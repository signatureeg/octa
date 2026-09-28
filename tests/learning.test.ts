import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('electron', () => ({
  BrowserWindow: class {},
  app: { isPackaged: false, getAppPath: () => process.cwd() }
}))

import { LAUNCH_WORKFLOWS } from '../electron/core/octa/workflows'
import { createLaunchWorkflowHandler } from '../electron/core/octa/launch-handlers'
import { AgentsRepository } from '../electron/db/agents'
import { appendLearning, learningPath, lessonFromFeedback, readLearning, removeLearning, renderMemory } from '../electron/core/octa/learning'
import { executeVoiceTool, VOICE_TOOL_DECLARATIONS, type VoiceToolDependencies } from '../electron/core/octa/voice-tools'

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step()
})

function home(): string {
  const path = mkdtempSync(join(tmpdir(), 'octa-learning-'))
  cleanup.push(() => rmSync(path, { recursive: true, force: true }))
  return path
}

describe('learning logs', () => {
  it('appends, skips repeats, keeps the newest and removes by id', () => {
    const root = home()
    const path = learningPath(root, 'lessons', 'signature')
    expect(path).toBe(join(root, 'companies', 'signature', 'lessons.md'))
    appendLearning(path, 'lessons', 'Brand builder', 'Owner rejected: no English hooks · please', new Date('2026-09-28T10:00:00Z'))
    appendLearning(path, 'lessons', 'Brand builder', 'owner rejected: no english hooks - please')
    const entries = readLearning(path)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ date: '2026-09-28', tag: 'Brand builder', text: 'Owner rejected: no English hooks - please' })
    expect(readFileSync(path, 'utf8')).toMatch(/^# Lessons learned/)
    for (let index = 0; index < 70; index += 1) appendLearning(path, 'lessons', 'x', `lesson ${index}`)
    const kept = readLearning(path)
    expect(kept).toHaveLength(60)
    expect(kept.at(-1)?.text).toBe('lesson 69')
    expect(removeLearning(path, 'lessons', kept[0].id)).toBe(true)
    expect(readLearning(path)).toHaveLength(59)
  })

  it('owner memory lives outside the companies; gaps need a company', () => {
    const root = home()
    expect(learningPath(root, 'memory')).toBe(join(root, 'owner.md'))
    expect(() => learningPath(root, 'gaps')).toThrow(/company/)
    appendLearning(learningPath(root, 'memory'), 'memory', 'decision', 'No posting on Fridays')
    expect(renderMemory(readLearning(learningPath(root, 'memory')))).toBe('- (decision) No posting on Fridays')
  })

  it('turns feedback into a lesson, ignoring empty comments', () => {
    expect(lessonFromFeedback({ kind: 'rejected', comment: '   ' })).toBeUndefined()
    expect(lessonFromFeedback({ kind: 'rejected', comment: 'too salesy', who: 'Brand builder', about: 'agent-task' }))
      .toEqual({ tag: 'Brand builder', text: 'بيدو رفض "agent-task": too salesy' })
  })
})

describe('voice: remember and note gaps', () => {
  it('saves through its dependencies and fails clearly without them', () => {
    const memory: string[] = []
    const base = {
      listAgents: () => [], agentRuns: () => [], runStatus: () => undefined, proposeRequest: () => { throw new Error('no') },
      startRequest: () => { throw new Error('no') }, listRequests: () => [], createTask: () => { throw new Error('no') },
      listCompanies: () => ({ active: 'signature', companies: [] }), setCompany: () => ({ active: 'signature', companies: [] })
    } as unknown as VoiceToolDependencies
    const tools: VoiceToolDependencies = {
      ...base,
      remember: (text, kind) => { memory.push(`${kind}:${text}`); return text ? { text, tag: kind } : undefined },
      noteGap: (what) => (what ? { text: what } : undefined)
    }
    expect(executeVoiceTool('remember', { text: 'No posting on Fridays', kind: 'decision' }, tools)).toEqual({ saved: 'No posting on Fridays', kind: 'decision' })
    expect(memory).toEqual(['decision:No posting on Fridays'])
    expect(executeVoiceTool('remember', { text: '' }, tools)).toHaveProperty('error')
    expect(executeVoiceTool('note_gap', { what: 'Edit reels' }, tools)).toMatchObject({ logged: 'Edit reels' })
    expect(executeVoiceTool('remember', { text: 'x' }, base)).toHaveProperty('error')
    expect(VOICE_TOOL_DECLARATIONS.map((tool) => tool.name)).toEqual(expect.arrayContaining(['remember', 'note_gap']))
  })
})

describe('W8 weekly retro reads what Octa learned', () => {
  it('puts lessons, gaps, the agent lineup and available skills in the evidence', async () => {
    const root = home()
    const folder = join(root, 'workflows', 'run-8')
    mkdirSync(folder, { recursive: true })
    const knowledge = join(root, 'knowledge')
    appendLearning(learningPath(knowledge, 'lessons', 'signature'), 'lessons', 'Brand builder', 'Owner rejected: too salesy')
    appendLearning(learningPath(knowledge, 'gaps', 'signature'), 'gaps', 'voice', 'Edit my reels automatically')
    const agents = new AgentsRepository(':memory:')
    cleanup.push(() => agents.close())
    agents.create({ name: 'Brand builder', identity: 'i', scope: 's', definitionOfDone: 'd', skills: ['brand-building'], tier: 'claude-tools', trustStage: 'draft-only', department: 'marketing' })
    const w8 = LAUNCH_WORKFLOWS.find((item) => item.id === 'W8')!
    expect(w8.version).toBe(2)
    expect(w8.steps[1].prompt).toContain('new-skill')
    expect(w8.steps[2].gate).toBe('approve')
    const handler = createLaunchWorkflowHandler({ homePath: root, agents, knowledgeRoot: () => knowledge, activeCompany: () => 'signature', skillsCatalog: () => [{ name: 'video-editing', description: 'Edit videos' }] })
    await handler({ runId: 'run-8', workflow: w8, step: w8.steps[0], input: {}, brief: {}, attempt: 1, folder, jobId: 'run-8-s1-a1' })
    const evidence = JSON.parse(readFileSync(join(folder, 'out', 'retro-evidence.json'), 'utf8'))
    expect(evidence.lessons[0].text).toBe('Owner rejected: too salesy')
    expect(evidence.gaps[0].text).toBe('Edit my reels automatically')
    expect(evidence.agents[0]).toMatchObject({ name: 'Brand builder', skills: ['brand-building'] })
    expect(evidence.skillsAvailable[0].name).toBe('video-editing')
    expect(evidence.totals).toMatchObject({ lessons: 1, gaps: 1 })
  })
})

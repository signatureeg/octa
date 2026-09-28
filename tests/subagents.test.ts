import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn as nodeSpawn } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { JobRunner } from '../electron/core/jobs/runner'
import { JobsRepository } from '../electron/db/jobs'
import { agentJobSpec } from '../electron/core/octa/agent-runs'

let home: string | undefined
let repository: JobsRepository | undefined
afterEach(() => {
  repository?.close()
  repository = undefined
  if (home) rmSync(home, { recursive: true, force: true })
  home = undefined
})

function library(root: string): string {
  const skills = [
    ['brand-building', 'Build a personal brand and content plans that sell.'],
    ['performance-marketer', 'Performance marketing and growth operating system.']
  ]
  mkdirSync(join(root, 'skills'), { recursive: true })
  for (const [name, description] of skills) {
    mkdirSync(join(root, 'skills', name), { recursive: true })
    writeFileSync(join(root, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\nBODY-OF-${name}`)
  }
  writeFileSync(join(root, 'MANIFEST.json'), JSON.stringify({ skills: skills.map(([name, description]) => ({ name, folder: name, department: 'marketing', description, verdict: 'core', autonomy: 'assisted' })) }))
  return root
}

const ECHO = `
let input = ''
process.stdin.on('data', (chunk) => { input += chunk })
process.stdin.on('end', () => {
  const args = JSON.parse(process.env.FAKE_ARGV)
  const text = 'ARGS:' + args.join(' ') + ' PROMPT:' + input
  if (args.includes('stream-json')) {
    process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\\n')
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'done', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n')
  } else {
    process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }) + '\\n')
    process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n')
  }
})`

function runner(root: string): JobRunner {
  repository = new JobsRepository(':memory:')
  return new JobRunner({
    homePath: root,
    jobs: repository,
    skillsLibraryPath: join(root, 'lib'),
    claudeBinary: process.execPath,
    codexBinary: process.execPath,
    spawn: ((_command: string, args: readonly string[], options: object) => nodeSpawn(process.execPath, ['-e', ECHO], { ...(options as Record<string, unknown>), shell: false, env: { ...process.env, FAKE_ARGV: JSON.stringify(args) } })) as never
  })
}

const agent = { name: 'Brand builder', skills: ['brand-building', 'performance-marketer'], trustStage: 'draft-only' as const, department: 'marketing' }

describe('skills as sub-agents', () => {
  it('Claude agents get their other skills as Claude Code sub-agents they may delegate to', async () => {
    home = mkdtempSync(join(tmpdir(), 'octa-sub-'))
    library(join(home, 'lib'))
    const handle = runner(home).startJob(agentJobSpec({ ...agent, tier: 'claude-tools' }, 'Plan next week', 'signature', { maxRetries: 0 }))
    await handle.promise
    const subagent = join(handle.folder, '.claude', 'agents', 'performance-marketer.md')
    expect(existsSync(subagent)).toBe(true)
    expect(readFileSync(subagent, 'utf8')).toMatch(/^---\nname: performance-marketer\ndescription: "Performance marketing and growth operating system\."\ntools: Read, Grep, Glob, WebFetch, WebSearch, Write, Edit\n---/)
    expect(readFileSync(subagent, 'utf8')).toContain('BODY-OF-performance-marketer')
    const log = readFileSync(join(handle.folder, 'log.jsonl'), 'utf8')
    expect(log).toContain('Task Agent')
    expect(log).toContain('--add-dir')
    expect(log).toContain('sub-agent you can delegate to')
    // draft-only Claude agents may still write their deliverable
    expect(log).toMatch(/--allowedTools Read Grep Glob WebFetch WebSearch Write Edit/)
    // loop/schedule tools stall a headless job
    expect(log).toMatch(/--disallowedTools ScheduleWakeup CronCreate/)
  })

  it('Codex agents get every skill inlined and network access', async () => {
    home = mkdtempSync(join(tmpdir(), 'octa-sub-'))
    library(join(home, 'lib'))
    const handle = runner(home).startJob(agentJobSpec({ ...agent, tier: 'executor' }, 'Plan next week', 'signature', { maxRetries: 0 }))
    await handle.promise
    const log = readFileSync(join(handle.folder, 'log.jsonl'), 'utf8')
    expect(log).toContain('BODY-OF-brand-building')
    expect(log).toContain('BODY-OF-performance-marketer')
    expect(log).toContain('sandbox_workspace_write.network_access=true')
    expect(existsSync(join(handle.folder, 'skills', 'performance-marketer', 'SKILL.md'))).toBe(true)
  })

  it('a missing extra skill does not fail the job', async () => {
    home = mkdtempSync(join(tmpdir(), 'octa-sub-'))
    library(join(home, 'lib'))
    const handle = runner(home).startJob(agentJobSpec({ ...agent, skills: ['brand-building', 'ghost-skill'], tier: 'executor' }, 'x', 'signature', { maxRetries: 0 }))
    const result = await handle.promise
    expect(result.status).not.toBe('failed')
    expect(readFileSync(join(handle.folder, 'log.jsonl'), 'utf8')).toContain('Not available right now: ghost-skill')
  })
})

describe('a lead agent with a team of specialists', () => {
  const member = {
    slug: 'copywriter', name: 'Copywriter', role: 'Writes copy.', scope: 'One piece of copy.', definitionOfDone: 'out/team/copywriter/copy.md',
    skills: ['brand-building'], checklist: ['Speaks to the persona', 'Nothing invented'], tools: 'write' as const
  }

  it('validates the team and reports every problem', async () => {
    const { validateTeam } = await import('../electron/core/octa/agents')
    const errors: string[] = []
    const team = validateTeam([member, { ...member }, { slug: 'Bad Slug', name: '', skills: [], checklist: [] }], errors)
    expect(team.map((item) => item.slug)).toEqual(['copywriter'])
    expect(errors.join(' ')).toMatch(/used twice/)
    expect(errors.join(' ')).toMatch(/slug must be lowercase/)
    expect(errors.join(' ')).toMatch(/checklist needs/)
  })

  it('stores the team with the agent and replaces it on update', async () => {
    const { AgentsRepository } = await import('../electron/db/agents')
    const agents = new AgentsRepository(':memory:')
    const lead = agents.create({ name: 'Performance marketer', identity: 'i', scope: 's', definitionOfDone: 'd', skills: ['performance-marketer'], tier: 'claude-tools', team: [member] })
    expect(agents.get(lead.id)?.team?.[0]).toMatchObject({ slug: 'copywriter', tools: 'write' })
    expect(agents.update(lead.id, { team: [] }).team).toBeUndefined()
    agents.close()
  })

  it('mounts specialists as sub-agents with their checklist and the owner examples, runs on Claude with the independent review', async () => {
    home = mkdtempSync(join(tmpdir(), 'octa-team-'))
    library(join(home, 'lib'))
    const brain = join(home, 'knowledge', 'companies', 'signature')
    mkdirSync(join(brain, 'examples', 'copywriter'), { recursive: true })
    writeFileSync(join(brain, 'company.md'), '# Signature')
    writeFileSync(join(brain, 'examples', 'copywriter', 'README.md'), 'HOW-TO-NOT-SENT')
    writeFileSync(join(brain, 'examples', 'copywriter', 'good-ad.md'), 'EXAMPLE-GOOD-AD')
    const lead = { name: 'Performance marketer', skills: ['performance-marketer'], trustStage: 'draft-only' as const, department: 'marketing', tier: 'executor' as const, definitionOfDone: 'out/plan.md', team: [member] }
    const spec = agentJobSpec(lead, 'Plan the launch', 'signature', { maxRetries: 0, skipReview: true })
    // a team always runs on Claude; the independent review is on unless a test turns it off
    expect(spec.runner).toBe('claude-skill')
    expect(agentJobSpec(lead, 'x', 'signature')).toMatchObject({ skipReview: false })
    expect(agentJobSpec(lead, 'x', 'signature').acceptance?.join(' ')).toMatch(/review-log\.md/)
    const handle = runner(home).startJob({ ...spec, knowledgePath: brain })
    await handle.promise
    const subagent = readFileSync(join(handle.folder, '.claude', 'agents', 'copywriter.md'), 'utf8')
    expect(subagent).toMatch(/^---\nname: copywriter\n/)
    expect(subagent).toContain('tools: Read, Grep, Glob, Write, Edit\n')
    expect(subagent).toContain('Works only on a brief from Performance marketer')
    expect(subagent).toContain('1. Speaks to the persona')
    expect(subagent).toContain('EXAMPLE-GOOD-AD')
    expect(subagent).not.toContain('HOW-TO-NOT-SENT')
    expect(subagent).toContain('BODY-OF-brand-building')
    const log = readFileSync(join(handle.folder, 'log.jsonl'), 'utf8')
    expect(log).toContain('Your team (1 specialists)')
    expect(log).toContain('out/review-log.md')
    expect(log).toContain('Task Agent')
    // specialists can read the company brain
    expect(log).toContain(JSON.stringify(brain).slice(1, -1))
  })
})

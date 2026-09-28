import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../electron/types'
import { VoiceController } from '../electron/core/dictation'
import { createGeminiLiveSetup, liveFunctionCalls, type GeminiLiveEvent } from '../electron/cloud/gemini-live'
import type { WakeWordDetector, WakeWordHit } from '../electron/core/wake-word'
import { VOICE_TOOL_DECLARATIONS, VoiceTools, type VoiceToolDeps } from '../electron/core/voice/tools'
import { DEFAULT_PHASE_MODELS } from '../electron/core/octa/models'
import type { OctaPlan, PlannerResult } from '../electron/core/octa/planner'
import { WorkflowRunner, type WorkflowRunRecord } from '../electron/core/octa/workflows'

const folders: string[] = []
function folder(): string {
  const path = mkdtempSync(join(tmpdir(), 'octa-voice-tools-'))
  folders.push(path)
  return path
}
afterEach(() => {
  for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true })
})

const plan: OctaPlan = {
  plan_id: 'p1',
  language: 'ar-EG',
  summary: 'اجمع محادثات Claude الخاصة بالـ portfolio وطلّع قائمة العملاء والمواقع.',
  questions: [],
  assumptions: [],
  workflow: 'custom',
  steps: [
    { id: 's1', runner: 'codex-exec', prompt: 'Collect every Claude chat about the portfolio into chats.md', needs: [], gate: 'none', autonomy: 'assisted', acceptance: ['chats.md exists'] },
    { id: 's2', runner: 'claude-skill', skill: 'client-report', prompt: 'Summarise clients and websites', needs: ['s1'], gate: 'none', autonomy: 'assisted', acceptance: ['report lists clients'] }
  ],
  deliverables: ['clients.md'],
  estimated_minutes: 12
}

function result(status: PlannerResult['status'], extra: Partial<PlannerResult> = {}): PlannerResult {
  return {
    status, planId: 'p1', plan, questions: [], debate: [], debateMarkdown: '', briefPath: 'brief.md',
    planPath: 'C:\\Octa\\jobs\\p1\\plan.json', debatePath: 'debate.md', workspace: 'w', round: 2, questionRound: 0, ...extra
  }
}

function deps(overrides: Partial<VoiceToolDeps> = {}): VoiceToolDeps & { spoken: string[]; notified: string[] } {
  const spoken: string[] = []
  const notified: string[] = []
  return {
    spoken,
    notified,
    plan: vi.fn(async () => result('needs_approval')),
    answer: vi.fn(async () => result('needs_approval')),
    approve: vi.fn(async () => result('approved')),
    getPlan: vi.fn(() => result('needs_approval')),
    latestPlanId: () => 'p1',
    execute: vi.fn(() => ({ runId: 'r1', folder: 'f', promise: new Promise<WorkflowRunRecord>(() => undefined) })),
    getRun: () => null,
    latestRunId: () => null,
    openPath: vi.fn(),
    announce: (text) => { spoken.push(text); return true },
    notify: (title, body) => { notified.push(`${title}: ${body}`) },
    phaseModels: () => DEFAULT_PHASE_MODELS,
    ...overrides
  }
}

describe('voice tools', () => {
  it('declares the tools in the Live setup and parses tool calls', () => {
    const setup = createGeminiLiveSetup({ model: 'm', functionDeclarations: VOICE_TOOL_DECLARATIONS }) as { setup: { tools: Array<{ functionDeclarations: Array<{ name: string }> }> } }
    expect(setup.setup.tools[0].functionDeclarations.map((tool) => tool.name)).toContain('execute_plan')
    expect(createGeminiLiveSetup({ model: 'm' }).setup).not.toHaveProperty('tools')
    expect(liveFunctionCalls({ functionCalls: [{ id: 'c1', name: 'get_plan', args: { plan_id: 'p1' } }, { id: 'x' }] }))
      .toEqual([{ id: 'c1', name: 'get_plan', args: { plan_id: 'p1' } }])
  })

  it('starts planning at once and announces a short brief naming who does what', async () => {
    const tools = deps()
    const response = await new VoiceTools(tools).call('start_plan', { request: 'اجمع كل محادثات Claude بتاعة الـ portfolio' })
    expect(response.status).toBe('planning_started')
    await vi.waitFor(() => expect(tools.spoken).toHaveLength(1))
    const update = tools.spoken[0]
    expect(update).toMatch(/^\[Octa update\] The plan is ready/)
    expect(update).toContain('ask whether to execute')
    expect(update).toContain('ChatGPT/Codex (gpt-5.6-luna)')
    expect(update).toContain('Claude (claude-sonnet-5)')
    expect(update).toContain('claude-fable-5-1 drafted it')
  })

  it('adds details given mid-planning to the new plan instead of an older one', async () => {
    let finish: (value: PlannerResult) => void = () => undefined
    const tools = deps({
      plan: vi.fn(() => new Promise<PlannerResult>((resolve) => { finish = resolve })),
      answer: vi.fn(async (planId: string) => result('needs_approval', { planId })),
      latestPlanId: () => 'old-plan'
    })
    const voice = new VoiceTools(tools)
    await voice.call('start_plan', { request: 'collect the portfolio chats' })
    expect(await voice.call('answer_plan_questions', { answers: 'the folder is Desktop/Projects/portfolio' })).toMatchObject({ status: 'noted' })
    expect(await voice.call('execute_plan', {})).toHaveProperty('error')
    finish(result('needs_approval', { planId: 'new-plan' }))
    await vi.waitFor(() => expect(tools.spoken).toHaveLength(1))
    expect(tools.answer).toHaveBeenCalledWith('new-plan', 'the folder is Desktop/Projects/portfolio')
    expect(tools.spoken[0]).toContain('"plan_id":"new-plan"')
  })

  it('refuses to execute while blocking questions are open', async () => {
    const tools = deps({ getPlan: () => result('needs_input', { questions: [{ id: 'q1', text: 'أي فولدر؟', why: '', options: [], blocking: true }] }) })
    const response = await new VoiceTools(tools).call('execute_plan', {})
    expect(response.error).toMatch(/blocking questions/)
    expect(tools.execute).not.toHaveBeenCalled()
  })

  it('approves, executes, writes the report and announces who did what', async () => {
    const runFolder = folder()
    const record: WorkflowRunRecord = {
      runId: 'r1', workflowId: 'w', workflow: 'w', folder: runFolder, brief: { plan_id: 'p1' }, status: 'ok',
      steps: [
        { id: 's1', status: 'completed', attempt: 1, reviewAttempts: 1, reviewRetries: 0, outputs: [{ path: 'chats.md', type: 'markdown', title: 'Chats' }] },
        { id: 's2', status: 'completed', attempt: 1, reviewAttempts: 1, reviewRetries: 0 }
      ],
      createdAt: '', updatedAt: ''
    } as WorkflowRunRecord
    const tools = deps({ execute: vi.fn(() => ({ runId: 'r1', folder: runFolder, promise: Promise.resolve(record) })) })
    const response = await new VoiceTools(tools).call('execute_plan', {})
    expect(tools.approve).toHaveBeenCalledWith('p1')
    expect(response).toMatchObject({ status: 'running', run_id: 'r1', steps: 2 })
    await vi.waitFor(() => expect(tools.spoken).toHaveLength(1))
    expect(tools.spoken[0]).toContain('which AI did what')
    const report = readFileSync(join(runFolder, 'octa-report.md'), 'utf8')
    expect(report).toContain('s1 — ChatGPT/Codex (gpt-5.6-luna) — completed')
    expect(report).toContain(join(runFolder, 'chats.md'))
    expect(report).toContain('reviewed by ChatGPT gpt-5.6-sol')
  })

  it('falls back to a desktop notification when no voice session is open', async () => {
    const tools = deps({ announce: () => false })
    await new VoiceTools(tools).call('start_plan', { request: 'plan the portfolio clients report' })
    await vi.waitFor(() => expect(tools.notified).toHaveLength(1))
    expect(tools.notified[0]).toMatch(/^Octa: Plan ready/)
  })

  it('turns a planner plan into a runnable workflow', () => {
    const runner = new WorkflowRunner({ homePath: folder() })
    const definition = runner.saveAsWorkflow('Voice plan p1', plan)
    expect(definition.steps.map((step) => step.runner)).toEqual(['codex-exec', 'claude-skill'])
  })
})

class Detector implements WakeWordDetector {
  readonly frameLength = 512
  private callback: ((hit: WakeWordHit) => void) | undefined
  start(callback: (hit: WakeWordHit) => void): void { this.callback = callback }
  feedPcm(): void {}
  fire(): void { this.callback?.({ keywordIndex: 0, timestamp: Date.now() }) }
  stop(): void { this.callback = undefined }
}

describe('voice controller tool calls', () => {
  it('runs the called tool and answers with the same call id', async () => {
    const detector = new Detector()
    let emit: ((event: GeminiLiveEvent) => void) | undefined
    const toolResponses: unknown[] = []
    const onToolCall = vi.fn(async () => ({ status: 'planning_started' }))
    const controller = new VoiceController({
      settings: () => DEFAULT_SETTINGS,
      detector,
      createSession: ({ onEvent }) => {
        emit = onEvent
        return { open: () => undefined, sendPcm: () => undefined, sendText: () => undefined, interrupt: () => undefined, close: () => undefined, sendToolResponse: (responses) => { toolResponses.push(responses) } }
      },
      onToolCall
    })
    await controller.start()
    detector.fire()
    await vi.waitFor(() => expect(emit).toBeDefined())
    await vi.waitFor(() => expect(controller.announce('[Octa update] hi')).toBe(true))
    emit!({ type: 'tool-call', value: { functionCalls: [{ id: 'c9', name: 'start_plan', args: { request: 'x' } }] } })
    await vi.waitFor(() => expect(toolResponses).toHaveLength(1))
    expect(onToolCall).toHaveBeenCalledWith('start_plan', { request: 'x' })
    expect(toolResponses[0]).toEqual([{ id: 'c9', name: 'start_plan', response: { status: 'planning_started' } }])
    controller.dispose()
  })
})

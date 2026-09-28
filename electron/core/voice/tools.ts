import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { OctaPlan, PlannerResult, PlanStep } from '../octa/planner'
import type { WorkflowRunRecord } from '../octa/workflows'
import type { PhaseModels } from '../octa/models'

/**
 * Tools the Gemini Live voice can call so "يلا نخطط" and "نفّذي" actually drive the planner and the
 * workflow runner instead of the voice answering "I can't". Planning and execution take minutes, so
 * those tools return at once and announce the result into the live conversation when it is ready.
 */

export const VOICE_TOOL_DECLARATIONS = [
  {
    name: 'start_plan',
    description: 'Start planning a task the owner described (Claude drafts the plan, ChatGPT critiques it). Takes a few minutes; the result is announced when ready. Call only after the task is clear enough; ask the owner first when a key detail is missing.',
    parameters: {
      type: 'OBJECT',
      properties: {
        request: { type: 'STRING', description: 'The full task in the owner\'s words plus every detail they gave: goal, sources, folders, clients, deadline, expected deliverables.' }
      },
      required: ['request']
    }
  },
  {
    name: 'answer_plan_questions',
    description: 'Send the owner\'s answers to the planner\'s questions; the plan is revised and announced again.',
    parameters: {
      type: 'OBJECT',
      properties: {
        plan_id: { type: 'STRING', description: 'Plan id; omit for the latest plan.' },
        answers: { type: 'STRING', description: 'The owner\'s answers, one per line, each prefixed by the question it answers.' }
      },
      required: ['answers']
    }
  },
  {
    name: 'get_plan',
    description: 'Get the latest (or a given) plan: status, summary, steps with which AI runs each, deliverables and open questions.',
    parameters: {
      type: 'OBJECT',
      properties: { plan_id: { type: 'STRING', description: 'Plan id; omit for the latest plan.' } }
    }
  },
  {
    name: 'execute_plan',
    description: 'Approve the plan and start executing it. Call ONLY after you summarised the plan and the owner clearly said to execute (e.g. "نفّذي", "يلا ننفذ", "go ahead").',
    parameters: {
      type: 'OBJECT',
      properties: { plan_id: { type: 'STRING', description: 'Plan id; omit for the latest plan.' } }
    }
  },
  {
    name: 'get_run_status',
    description: 'Progress or final report of an execution: each step, which AI and model did it, status, output files and the report path.',
    parameters: {
      type: 'OBJECT',
      properties: { run_id: { type: 'STRING', description: 'Run id; omit for the latest run.' } }
    }
  },
  {
    name: 'open_results',
    description: 'Open the folder (or report) of the latest or given run on the owner\'s screen.',
    parameters: {
      type: 'OBJECT',
      properties: { run_id: { type: 'STRING', description: 'Run id; omit for the latest run.' } }
    }
  }
] as const

export const VOICE_TOOLS_INSTRUCTION = `You can plan and execute work through your tools; never say you cannot plan, research, build or run tasks.
Flow: when the owner asks for work ("يلا نخطط", "عايز أعمل كذا"), ask only the missing essentials, then call start_plan and tell them planning takes a few minutes.
When a plan is announced: do not read it all. Give a short summary (goal, number of steps, who does what, deliverables, time), ask any planner questions, then ask "ننفّذ؟".
Call execute_plan only after the owner clearly says to execute. Execution takes a while; the result is announced when done.
When a run finishes, report which AI did which part (Claude, ChatGPT/Codex, Gemini), the final result in two or three sentences, and that the full report and files are in the run folder; offer to open it with open_results.
Messages that start with [Octa update] come from the app, not the owner: relay them naturally. Never write or imagine an [Octa update] yourself, and never describe a plan's steps or a run's result that did not come from an [Octa update], get_plan or get_run_status. While planning runs, say it is still being prepared.`

export interface VoicePlanRun {
  runId: string
  folder: string
  promise: Promise<WorkflowRunRecord>
}

export interface VoiceToolDeps {
  plan(request: string): Promise<PlannerResult>
  answer(planId: string, answers: string): Promise<PlannerResult>
  approve(planId: string): Promise<PlannerResult>
  getPlan(planId: string): PlannerResult | null
  latestPlanId(): string | null
  execute(result: PlannerResult): VoicePlanRun
  getRun(runId: string): WorkflowRunRecord | null
  latestRunId(): string | null
  openPath(path: string): Promise<unknown> | unknown
  /** Say an update in the live conversation; false when no session is open. */
  announce(text: string): boolean
  /** Fallback when no voice session is open (desktop notification). */
  notify(title: string, body: string): void
  phaseModels(): PhaseModels
}

type Args = Record<string, unknown>

function arg(args: Args, key: string): string {
  const value = args[key]
  return typeof value === 'string' ? value.trim() : ''
}

function short(value: string | undefined, max = 140): string {
  const text = (value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Which AI runs a plan step, named the way the owner talks about them. */
export function stepBrain(runner: string, models: PhaseModels): string {
  switch (runner) {
    case 'claude-skill':
      return `Claude (${models.skill.model})`
    case 'codex-exec':
      return `ChatGPT/Codex (${models.code.model})`
    case 'codex-scout':
      return `ChatGPT/Codex research (${models.code.model})`
    case 'gemini-inline':
      return 'Gemini'
    case 'octa-code':
      return 'Octa Code (Claude + Codex)'
    default:
      return runner
  }
}

function stepTask(step: PlanStep): string {
  return short(step.prompt || (step.skill ? `skill ${step.skill}` : '') || step.id)
}

export function planBrief(result: PlannerResult, models: PhaseModels): Record<string, unknown> {
  const plan: OctaPlan = result.plan
  const steps = Array.isArray(plan.steps) ? plan.steps : []
  return {
    plan_id: result.planId,
    status: result.status,
    summary: short(plan.summary, 600),
    planned_by: `Claude ${models.plan.model} drafted it; ChatGPT ${models.critic.model} critiqued it over ${Math.max(1, result.round)} round(s).`,
    steps: steps.map((step) => ({ id: step.id, ai: stepBrain(step.runner, models), task: stepTask(step), needs_approval: step.gate === 'approve' })),
    reviewed_by: `Every step is checked by ChatGPT ${models.review.model}.`,
    deliverables: (plan.deliverables ?? []).map((item) => short(item)),
    open_questions: (result.questions ?? []).map((question) => ({ id: question.id, text: question.text, options: question.options })),
    estimated_minutes: plan.estimated_minutes,
    plan_file: result.planPath
  }
}

function outputPaths(step: WorkflowRunRecord['steps'][number], folder: string): string[] {
  return (step.outputs ?? []).map((output) => /^[A-Za-z]:[\\/]|^\//.test(output.path) ? output.path : join(folder, output.path))
}

export function runReport(run: WorkflowRunRecord, plan: OctaPlan | null, models: PhaseModels): Record<string, unknown> {
  const planSteps = new Map((plan?.steps ?? []).map((step) => [step.id, step]))
  return {
    run_id: run.runId,
    status: run.status,
    error: run.error ? short(run.error, 300) : undefined,
    waiting_for_approval: run.currentGate ? run.currentGate.stepId : undefined,
    steps: run.steps.map((step) => {
      const planned = planSteps.get(step.id)
      return {
        id: step.id,
        ai: planned ? stepBrain(planned.runner, models) : 'unknown',
        task: planned ? stepTask(planned) : undefined,
        status: step.status,
        error: step.error ? short(step.error, 200) : undefined,
        outputs: outputPaths(step, run.folder)
      }
    }),
    acceptance: run.acceptance,
    folder: run.folder,
    report_file: join(run.folder, 'octa-report.md')
  }
}

export function renderRunReport(run: WorkflowRunRecord, plan: OctaPlan | null, models: PhaseModels): string {
  const report = runReport(run, plan, models) as { steps: Array<{ id: string; ai: string; task?: string; status: string; error?: string; outputs: string[] }> }
  const lines = [
    '# Octa run report',
    '',
    `- Run: ${run.runId}`,
    `- Status: ${run.status}`,
    plan ? `- Goal: ${plan.summary}` : '',
    `- Planned by Claude ${models.plan.model}, critiqued by ChatGPT ${models.critic.model}, each step reviewed by ChatGPT ${models.review.model}.`,
    run.error ? `- Error: ${run.error}` : '',
    '',
    '## Who did what',
    '',
    ...report.steps.flatMap((step) => [
      `### ${step.id} — ${step.ai} — ${step.status}`,
      step.task ? step.task : '',
      step.error ? `Error: ${step.error}` : '',
      ...step.outputs.map((path) => `- ${path}`),
      ''
    ]),
    plan?.deliverables?.length ? '## Deliverables' : '',
    ...(plan?.deliverables ?? []).map((item) => `- ${item}`)
  ]
  return `${lines.filter((line, index, all) => line !== '' || all[index - 1] !== '').join('\n').trim()}\n`
}

const FINISHED = new Set(['ok', 'failed', 'cancelled', 'stale'])

export class VoiceTools {
  private planning = new Set<string>()
  /** Extra details the owner gave while a plan was still being drafted; applied as soon as it lands. */
  private pendingDetails: string[] = []
  private lastPlanId: string | null = null

  constructor(private readonly deps: VoiceToolDeps) {}

  async call(name: string, args: Args = {}): Promise<Record<string, unknown>> {
    try {
      switch (name) {
        case 'start_plan':
          return this.startPlan(arg(args, 'request'))
        case 'answer_plan_questions':
          return this.answer(arg(args, 'plan_id'), arg(args, 'answers'))
        case 'get_plan':
          return this.getPlan(arg(args, 'plan_id'))
        case 'execute_plan':
          return await this.execute(arg(args, 'plan_id'))
        case 'get_run_status':
          return this.runStatus(arg(args, 'run_id'))
        case 'open_results':
          return await this.open(arg(args, 'run_id'))
        default:
          return { error: `Unknown tool ${name}.` }
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }

  private startPlan(request: string): Record<string, unknown> {
    if (request.length < 8) return { error: 'The task is too short to plan; ask the owner for the goal and details.' }
    const key = request.slice(0, 200)
    if (this.planning.has(key)) return { status: 'already_planning' }
    this.planning.add(key)
    this.pendingDetails = []
    void this.deps.plan(request)
      .then((result) => {
        this.planning.delete(key)
        this.planLanded(result)
      })
      .catch((error: unknown) => this.announce('Planning failed', `Planning failed: ${error instanceof Error ? error.message : String(error)}. Tell the owner briefly and suggest checking Settings → health (Claude sign-in).`))
      .finally(() => this.planning.delete(key))
    return { status: 'planning_started', note: 'Claude drafts and ChatGPT critiques; usually 2–6 minutes. The plan will be announced.' }
  }

  private planId(explicit: string): string | null {
    return explicit || this.lastPlanId || this.deps.latestPlanId()
  }

  private planLanded(result: PlannerResult): void {
    this.lastPlanId = result.planId
    const details = this.pendingDetails.splice(0)
    if (details.length > 0 && result.status !== 'approved') {
      this.answer(result.planId, details.join('\n'))
      return
    }
    this.announcePlan(result)
  }

  private answer(planId: string, answers: string): Record<string, unknown> {
    if (!answers) return { error: 'No answers given.' }
    if (this.planning.size > 0) {
      this.pendingDetails.push(answers)
      return { status: 'noted', note: 'The plan is still being drafted; these details will be added to it before it is announced.' }
    }
    const id = this.planId(planId)
    if (!id) return { error: 'There is no plan yet.' }
    this.planning.add(id)
    void this.deps.answer(id, answers)
      .then((result) => {
        this.planning.delete(id)
        this.planLanded(result)
      })
      .catch((error: unknown) => this.announce('Planning failed', `Revising the plan failed: ${error instanceof Error ? error.message : String(error)}.`))
      .finally(() => this.planning.delete(id))
    return { status: 'revising', plan_id: id }
  }

  private getPlan(planId: string): Record<string, unknown> {
    if (!planId && this.planning.size > 0) return { status: 'still_planning' }
    const id = this.planId(planId)
    const result = id ? this.deps.getPlan(id) : null
    if (!result) return { error: 'There is no plan yet.' }
    return planBrief(result, this.deps.phaseModels())
  }

  private async execute(planId: string): Promise<Record<string, unknown>> {
    if (!planId && this.planning.size > 0) return { error: 'The plan is still being drafted; wait for it to be announced.' }
    const id = this.planId(planId)
    if (!id) return { error: 'There is no plan to execute.' }
    const current = this.deps.getPlan(id)
    if (!current) return { error: `Plan ${id} was not found.` }
    if (current.status === 'needs_input') {
      return { error: 'The plan still has blocking questions.', open_questions: current.questions.map((question) => question.text) }
    }
    const approved = current.status === 'approved' ? current : await this.deps.approve(id)
    const run = this.deps.execute(approved)
    void run.promise
      .then((record) => this.announceRun(record, approved.plan))
      .catch((error: unknown) => this.announce('Run failed', `The run ${run.runId} failed: ${error instanceof Error ? error.message : String(error)}.`))
    return { status: 'running', run_id: run.runId, folder: run.folder, steps: approved.plan.steps.length }
  }

  private runStatus(runId: string): Record<string, unknown> {
    const id = runId || this.deps.latestRunId()
    const run = id ? this.deps.getRun(id) : null
    if (!run) return { error: 'There is no run yet.' }
    return runReport(run, this.planFor(run), this.deps.phaseModels())
  }

  private async open(runId: string): Promise<Record<string, unknown>> {
    const id = runId || this.deps.latestRunId()
    const run = id ? this.deps.getRun(id) : null
    if (!run) return { error: 'There is no run to open.' }
    await this.deps.openPath(run.folder)
    return { opened: run.folder }
  }

  private planFor(run: WorkflowRunRecord): OctaPlan | null {
    const brief = run.brief as { plan_id?: unknown } | null
    const planId = brief && typeof brief === 'object' && typeof brief.plan_id === 'string' ? brief.plan_id : null
    return planId ? this.deps.getPlan(planId)?.plan ?? null : null
  }

  private announcePlan(result: PlannerResult): void {
    const brief = planBrief(result, this.deps.phaseModels())
    const ask = result.status === 'needs_input'
      ? 'Summarise it in a few sentences and ask the open questions.'
      : 'Summarise it in a few sentences (do not read it all) and ask whether to execute.'
    this.announce('Plan ready', `The plan is ready. ${ask}\n${JSON.stringify(brief)}`, short(result.plan.summary, 180))
  }

  private announceRun(record: WorkflowRunRecord, plan: OctaPlan): void {
    const models = this.deps.phaseModels()
    if (FINISHED.has(record.status)) {
      try {
        writeFileSync(join(record.folder, 'octa-report.md'), renderRunReport(record, plan, models), 'utf8')
      } catch {
        // The spoken report still goes out if the folder is unwritable.
      }
    }
    const report = runReport(record, plan, models)
    this.announce(
      record.status === 'ok' ? 'Run finished' : `Run ${record.status}`,
      `The run finished with status ${record.status}. Tell the owner which AI did what, the result briefly, and offer to open the folder.\n${JSON.stringify(report)}`,
      `${record.steps.length} steps — ${record.folder}`
    )
  }

  private announce(title: string, text: string, notification = text): void {
    if (!this.deps.announce(`[Octa update] ${text}`)) this.deps.notify(`Octa: ${title}`, short(notification, 240))
  }
}

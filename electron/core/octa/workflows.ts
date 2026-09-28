import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import W1 from './workflows/W1-review-website.json'
import W2 from './workflows/W2-build-website.json'
import W3 from './workflows/W3-market-project.json'
import W4 from './workflows/W4-think-project.json'
import W5 from './workflows/W5-invoice.json'
import W6 from './workflows/W6-research.json'
import W7 from './workflows/W7-scope-new-agent.json'
import W8 from './workflows/W8-weekly-retro.json'
import W9 from './workflows/W9-agent-task.json'
import {
  JobRunner,
  getJobRunner,
  type JobHandle,
  type JobSpec
} from '../jobs/runner'
import {
  normalizeReviewRunResult,
  reviewStep,
  type ReviewJob,
  type ReviewResult,
  type ReviewRunResult,
  type ReviewStepRunner
} from './review'
import {
  runResearch,
  type ResearchResult
} from './research'
import {
  JobsRepository,
  type RecurringJobRecord,
  type SaveRecurringJobInput,
  type SaveWorkflowInput,
  type WorkflowRecord,
  type WorkflowStatsRecord
} from '../../db/jobs'
import {
  runWorkflowAcceptance,
  type WorkflowAcceptanceContext,
  type WorkflowAcceptanceResult,
  type WorkflowAcceptanceRunner
} from './acceptance'
import type { NotifyAction, NotifyOptions, Notifier } from '../notify'
import type {
  AppSettings,
  JobAutonomy,
  JobOutput,
  JobResult,
  JobRunnerName,
  JobStatus
} from '../../types'
import { isModelTier, MODEL_TIERS } from './models'
import type { ModelTier } from '../../types'

export type WorkflowGate = 'none' | 'review' | 'approve'
export type WorkflowAutonomy = JobAutonomy
export type WorkflowRunnerName = JobRunnerName | 'claude-skill' | 'codex-exec' | 'codex-scout' | 'octa-code' | string

export interface WorkflowStepDefinition {
  id: string
  name?: string
  needs: string[]
  runner: WorkflowRunnerName
  skill?: string
  prompt?: string
  input?: unknown
  gate: WorkflowGate
  autonomy: WorkflowAutonomy
  acceptance: string[]
  department?: string
  todo?: boolean
  research?: boolean
  /** Optional exact outward payload. When absent, the step result is shown verbatim. */
  gatePayload?: unknown
  timeBudgetMs?: number
  inputTokenBudget?: number
  maxRetries?: number
  /** Model tier for this step (spec 018). */
  tier?: ModelTier
}

export interface WorkflowDefinition {
  id: string
  name: string
  version: number
  description?: string
  autonomy?: WorkflowAutonomy
  acceptance: string[]
  steps: WorkflowStepDefinition[]
}

export const WORKFLOW_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Octa workflow definition',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1 },
    version: { type: 'integer', minimum: 1 },
    description: { type: 'string' },
    autonomy: { type: 'string', enum: ['led', 'assisted', 'auto'] },
    acceptance: { type: 'array', items: { type: 'string' } },
    steps: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1 },
          name: { type: 'string' },
          needs: { type: 'array', items: { type: 'string' } },
          runner: { type: 'string', minLength: 1 },
          skill: { type: 'string' },
          prompt: { type: 'string' },
          input: {},
          gate: { type: 'string', enum: ['none', 'review', 'approve'] },
          autonomy: { type: 'string', enum: ['led', 'assisted', 'auto'] },
          acceptance: { type: 'array', items: { type: 'string' } },
          department: { type: 'string' },
          todo: { type: 'boolean' },
          research: { type: 'boolean' },
          gatePayload: {},
          timeBudgetMs: { type: 'integer', minimum: 1 },
          inputTokenBudget: { type: 'integer', minimum: 1 },
          maxRetries: { type: 'integer', minimum: 0, maximum: 2 },
          tier: { type: 'string', enum: [...MODEL_TIERS] }
        },
        required: ['id', 'needs', 'runner', 'gate', 'autonomy', 'acceptance']
      }
    }
  },
  required: ['id', 'name', 'version', 'acceptance', 'steps']
} as const

export interface WorkflowValidationResult {
  valid: boolean
  errors: string[]
  definition?: WorkflowDefinition
}

export interface WorkflowInterpolationContext {
  brief: unknown
  steps: Record<string, unknown> | Map<string, unknown>
}

export interface WorkflowStepRunRequest {
  runId: string
  workflow: WorkflowDefinition
  step: WorkflowStepDefinition
  input: unknown
  brief: unknown
  attempt: number
  reviewComments?: string
  folder: string
  jobId: string
  language?: string
  timeBudgetMs?: number
}

export interface WorkflowStepExecution {
  status?: 'ok' | 'failed' | 'needs_input' | 'needs_approval' | 'cancelled' | 'stale' | string
  output?: unknown
  /** Structured result passed to Sol and stored in job_runs. */
  result?: unknown
  outputs?: JobOutput[]
  folder?: string
  jobId?: string
  notes?: string
  /** The exact payload that an approve gate must compare. */
  payload?: unknown
  review?: ReviewResult
}

export type WorkflowStepRunner =
  | ((request: WorkflowStepRunRequest) => Promise<WorkflowStepExecution | unknown> | WorkflowStepExecution | unknown)
  | ((step: WorkflowStepDefinition, input: unknown) => Promise<WorkflowStepExecution | unknown> | WorkflowStepExecution | unknown)

export type WorkflowResearchRunner = (request: WorkflowStepRunRequest) => Promise<WorkflowStepExecution | unknown> | WorkflowStepExecution | unknown

/** Specialized launch handlers return undefined when the generic job runner should take over. */
export type WorkflowStepHandler = (request: WorkflowStepRunRequest) => Promise<WorkflowStepExecution | unknown | undefined> | WorkflowStepExecution | unknown | undefined

export interface WorkflowGateApprovalRequest {
  runId: string
  workflowId: string
  workflow: string
  stepId: string
  folder: string
  brief: unknown
  state: WorkflowStepState
  approvedAt: string
  approvedBy: string
}

export type WorkflowGateApprovalHandler = (request: WorkflowGateApprovalRequest) => Promise<void> | void

export interface WorkflowGateState {
  gate: Exclude<WorkflowGate, 'none'>
  status: 'pending' | 'approved' | 'rejected' | 'commented' | 'expired'
  payload: string
  createdAt: string
  expiresAt: string
  comments?: string
  approvedBy?: string
  approvedAt?: string
  rejectedAt?: string
}

export type WorkflowStepStatus = 'pending' | 'running' | 'reviewing' | 'retrying' | 'waiting_gate' | 'completed' | 'failed' | 'skipped' | 'cancelled'

export interface WorkflowStepState {
  id: string
  status: WorkflowStepStatus
  attempt: number
  reviewAttempts: number
  reviewRetries: number
  jobId?: string
  input?: unknown
  output?: unknown
  result?: unknown
  outputs?: JobOutput[]
  review?: ReviewResult
  reviewComments?: string
  gate?: WorkflowGateState
  error?: string
  startedAt?: string
  finishedAt?: string
}

export interface WorkflowRunRecord {
  runId: string
  workflowId: string
  workflow: string
  folder: string
  brief: unknown
  status: 'running' | 'waiting_gate' | 'ok' | 'failed' | 'stale' | 'cancelled'
  steps: WorkflowStepState[]
  currentGate?: WorkflowGateState & { stepId: string }
  createdAt: string
  updatedAt: string
  acceptance?: WorkflowAcceptanceResult
  error?: string
}

export interface WorkflowListItem extends WorkflowDefinition {
  stats: WorkflowStatsRecord
  latestRun: WorkflowRunRecord | null
}

export interface WorkflowStartOptions {
  runId?: string
  planId?: string | null
  language?: string
  autonomy?: WorkflowAutonomy
  timeBudgetMs?: number
  inputTokenBudget?: number
}

export interface WorkflowStartRequest {
  workflow: string
  brief: unknown
  planId?: string | null
  language?: string
  autonomy?: WorkflowAutonomy
  timeBudgetMs?: number
  inputTokenBudget?: number
}

export interface WorkflowStartResponse {
  runId: string
  workflow: string
  folder: string
}

export interface WorkflowGateActionRequest {
  runId: string
  stepId?: string
  payload?: string
  approvedBy?: string
  comment?: string
  reason?: string
}

export interface WorkflowEventBase {
  runId: string
  workflowId: string
  timestamp: string
}

export interface WorkflowStepEvent extends WorkflowEventBase {
  type: 'workflow:step'
  stepId: string
  status: WorkflowStepStatus
  attempt: number
  message?: string
  output?: unknown
}

export interface WorkflowGateEvent extends WorkflowEventBase {
  type: 'workflow:gate'
  stepId: string
  gate: Exclude<WorkflowGate, 'none'>
  status: WorkflowGateState['status']
  payload: string
  expiresAt: string
  message?: string
}

export type WorkflowEvent = WorkflowStepEvent | WorkflowGateEvent

export interface WorkflowRunHandle {
  id: string
  runId: string
  folder: string
  promise: Promise<WorkflowRunRecord>
  result: Promise<WorkflowRunRecord>
  events: EventEmitter
  onEvent(listener: (event: WorkflowEvent) => void): () => void
  cancel(): Promise<boolean>
}

export interface WorkflowRunnerOptions {
  jobs?: JobsRepository
  jobRunner?: Pick<JobRunner, 'startJob'>
  /** Fake or embedded executor. Useful for tests and future specialized runners. */
  runner?: WorkflowStepRunner
  stepRunner?: WorkflowStepRunner
  /** Specialized W1-W5 handlers. Returning undefined delegates to the normal job runner. */
  stepHandler?: WorkflowStepHandler
  /** Fake or embedded Sol reviewer. */
  review?: ReviewStepRunner
  reviewStep?: ReviewStepRunner
  notifier?: Pick<Notifier, 'send'>
  notify?: Pick<Notifier, 'send'>
  /** Hook reserved for Gemini Live (spec 007) read-backs. */
  voiceGate?: (gate: WorkflowGateEvent) => void | Promise<void>
  research?: WorkflowResearchRunner
  /** Runs the code-level workflow acceptance checks after the final step. */
  acceptance?: WorkflowAcceptanceRunner
  /** Performs approval-only side effects after the exact gate payload is approved. */
  afterGateApproval?: WorkflowGateApprovalHandler
  homePath?: string
  getSettings?: () => AppSettings
  now?: () => Date
  onEvent?: (event: WorkflowEvent) => void
  maxConcurrent?: number
}

interface StoredWorkflowState {
  version: 1
  workflowId: string
  workflow: string
  folder: string
  brief: unknown
  language?: string
  timeBudgetMs?: number
  inputTokenBudget?: number
  status: WorkflowRunRecord['status']
  steps: Record<string, WorkflowStepState>
  createdAt: string
  updatedAt: string
  hadRejection: boolean
  hadReviewComments: boolean
  statsRecorded: boolean
  acceptance?: WorkflowAcceptanceResult
  error?: string
}

interface ActiveWorkflow {
  runId: string
  definition: WorkflowDefinition
  state: StoredWorkflowState
  folder: string
  planId?: string | null
  language?: string
  timeBudgetMs?: number
  inputTokenBudget?: number
  emitter: EventEmitter
  active: Map<string, Promise<void>>
  handles: Map<string, Pick<JobHandle, 'cancel'>>
  wakeResolvers: Array<() => void>
  wakePending: boolean
  gateTimers: Map<string, ReturnType<typeof setTimeout>>
  cancelled: boolean
  promise: Promise<WorkflowRunRecord>
}

const TERMINAL_STEP_STATUSES: ReadonlySet<WorkflowStepStatus> = new Set(['completed', 'skipped'])
const KNOWN_RUNNERS = new Set(['claude-plan', 'claude-skill', 'codex-exec', 'codex-scout', 'codex-critic', 'codex-review', 'gemini-inline', 'octa-code'])
const GATE_EXPIRY_MS = 24 * 60 * 60 * 1_000

export const LAUNCH_WORKFLOWS: readonly WorkflowDefinition[] = [W1, W2, W3, W4, W5, W6, W7, W8, W9] as WorkflowDefinition[]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function arrayOfStrings(value: unknown, path: string, required = true): string[] {
  if (!Array.isArray(value)) return required ? [`${path} must be an array.`] : []
  return value.flatMap((item, index) => typeof item === 'string' && item.trim() ? [] : [`${path}[${index}] must be a non-empty string.`])
}

function validAutonomy(value: unknown, fallback: WorkflowAutonomy = 'assisted'): WorkflowAutonomy {
  return value === 'led' || value === 'assisted' || value === 'auto' ? value : fallback
}

function validGate(value: unknown): WorkflowGate | undefined {
  return value === 'none' || value === 'review' || value === 'approve' ? value : undefined
}

function normalizeStep(value: Record<string, unknown>, index: number, workflowAutonomy: WorkflowAutonomy): WorkflowStepDefinition {
  return {
    id: text(value.id)!.trim(),
    ...(text(value.name) ? { name: text(value.name)!.trim() } : {}),
    needs: Array.isArray(value.needs) ? value.needs.filter((item): item is string => typeof item === 'string').map((item) => item.trim()) : [],
    runner: text(value.runner)!.trim(),
    ...(text(value.skill) ? { skill: text(value.skill)!.trim() } : {}),
    ...(text(value.prompt) ? { prompt: text(value.prompt)! } : {}),
    ...(value.input !== undefined ? { input: value.input } : {}),
    gate: validGate(value.gate) ?? 'none',
    autonomy: validAutonomy(value.autonomy, workflowAutonomy),
    acceptance: Array.isArray(value.acceptance) ? value.acceptance.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean) : [],
    ...(text(value.department) ? { department: text(value.department)!.trim() } : {}),
    ...(typeof value.todo === 'boolean' ? { todo: value.todo } : {}),
    ...(typeof value.research === 'boolean' ? { research: value.research } : {}),
    ...(value.gatePayload !== undefined ? { gatePayload: value.gatePayload } : {}),
    ...(typeof value.timeBudgetMs === 'number' && Number.isFinite(value.timeBudgetMs) ? { timeBudgetMs: Math.max(1, Math.trunc(value.timeBudgetMs)) } : {}),
    ...(typeof value.inputTokenBudget === 'number' && Number.isFinite(value.inputTokenBudget) ? { inputTokenBudget: Math.max(1, Math.trunc(value.inputTokenBudget)) } : {}),
    ...(typeof value.maxRetries === 'number' && Number.isFinite(value.maxRetries) ? { maxRetries: Math.max(0, Math.min(2, Math.trunc(value.maxRetries))) } : {}),
    ...(isModelTier(value.tier) ? { tier: value.tier } : {})
  }
}

function cycleErrors(steps: readonly WorkflowStepDefinition[]): string[] {
  const byId = new Map(steps.map((step) => [step.id, step]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const errors: string[] = []
  const visit = (id: string, trail: string[]): void => {
    if (visiting.has(id)) {
      errors.push(`steps contains a dependency cycle: ${[...trail, id].join(' -> ')}`)
      return
    }
    if (visited.has(id)) return
    const step = byId.get(id)
    if (!step) return
    visiting.add(id)
    for (const need of step.needs) visit(need, [...trail, id])
    visiting.delete(id)
    visited.add(id)
  }
  for (const step of steps) visit(step.id, [])
  return [...new Set(errors)]
}

export function validateWorkflow(value: unknown): WorkflowValidationResult {
  if (!isRecord(value)) return { valid: false, errors: ['Workflow must be a JSON object.'] }
  const errors: string[] = []
  const id = text(value.id)?.trim()
  const name = text(value.name)?.trim()
  if (!id) errors.push('id must be a non-empty string.')
  if (!name) errors.push('name must be a non-empty string.')
  if (!Number.isInteger(value.version) || Number(value.version) < 1) errors.push('version must be a positive integer.')
  errors.push(...arrayOfStrings(value.acceptance, 'acceptance'))
  if (!Array.isArray(value.steps) || value.steps.length === 0) {
    errors.push('steps must be a non-empty array.')
    return { valid: false, errors }
  }
  const workflowAutonomy = validAutonomy(value.autonomy)
  const steps: WorkflowStepDefinition[] = []
  const ids = new Set<string>()
  value.steps.forEach((raw, index) => {
    if (!isRecord(raw)) {
      errors.push(`steps[${index}] must be an object.`)
      return
    }
    const stepId = text(raw.id)?.trim()
    if (!stepId) errors.push(`steps[${index}].id must be a non-empty string.`)
    else if (ids.has(stepId)) errors.push(`steps[${index}].id duplicates ${stepId}.`)
    else ids.add(stepId)
    const runner = text(raw.runner)?.trim()
    if (!runner) errors.push(`steps[${index}].runner must be a non-empty string.`)
    else if (!KNOWN_RUNNERS.has(runner)) errors.push(`steps[${index}].runner ${runner} is not supported by the workflow contract.`)
    if (!Array.isArray(raw.needs)) errors.push(`steps[${index}].needs must be an array.`)
    else raw.needs.forEach((need, needIndex) => {
      if (typeof need !== 'string' || !need.trim()) errors.push(`steps[${index}].needs[${needIndex}] must be a non-empty string.`)
    })
    const gate = validGate(raw.gate)
    if (!gate) errors.push(`steps[${index}].gate must be none, review, or approve.`)
    if (raw.autonomy !== undefined && !['led', 'assisted', 'auto'].includes(String(raw.autonomy))) errors.push(`steps[${index}].autonomy is invalid.`)
    if (raw.tier !== undefined && !isModelTier(raw.tier)) errors.push(`steps[${index}].tier must be one of ${MODEL_TIERS.join(', ')}.`)
    errors.push(...arrayOfStrings(raw.acceptance, `steps[${index}].acceptance`))
    if (!raw.todo && !text(raw.skill)?.trim() && !text(raw.prompt)?.trim() && !raw.research) errors.push(`steps[${index}] needs skill, prompt, or research.`)
    steps.push(normalizeStep(raw, index, workflowAutonomy))
  })
  for (const step of steps) for (const need of step.needs) if (!ids.has(need)) errors.push(`steps.${step.id}.needs references missing step ${need}.`)
  errors.push(...cycleErrors(steps))
  if (errors.length > 0 || !id || !name) return { valid: false, errors }
  const definition: WorkflowDefinition = {
    id,
    name,
    version: Math.trunc(Number(value.version)),
    ...(text(value.description) ? { description: text(value.description) } : {}),
    ...(value.autonomy !== undefined ? { autonomy: workflowAutonomy } : {}),
    acceptance: (value.acceptance as unknown[]).filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean),
    steps
  }
  return { valid: true, errors: [], definition }
}

export const validateWorkflowSchema = validateWorkflow

export function topologicalOrder(definition: WorkflowDefinition): string[] {
  const checked = validateWorkflow(definition)
  if (!checked.valid || !checked.definition) throw new Error(`Invalid workflow: ${checked.errors.join(' ')}`)
  const byId = new Map(checked.definition.steps.map((step) => [step.id, step]))
  const result: string[] = []
  const remaining = new Set(byId.keys())
  while (remaining.size > 0) {
    const ready = [...remaining].filter((id) => byId.get(id)!.needs.every((need) => !remaining.has(need)))
    if (ready.length === 0) throw new Error('Workflow dependencies contain a cycle.')
    result.push(...ready)
    ready.forEach((id) => remaining.delete(id))
  }
  return result
}

function valueAt(root: unknown, path: string): unknown {
  if (!path) return root
  return path.split('.').reduce<unknown>((current, key) => {
    if (current instanceof Map) return current.get(key)
    if (isRecord(current)) return current[key]
    if (Array.isArray(current) && /^\d+$/.test(key)) return current[Number(key)]
    return undefined
  }, root)
}

function stepContextValue(value: unknown): unknown {
  if (isRecord(value) && value.out !== undefined) return value.out
  return value
}

function interpolationValue(path: string, context: WorkflowInterpolationContext): unknown {
  if (path === 'brief') return context.brief
  if (path.startsWith('brief.')) {
    const value = valueAt(context.brief, path.slice('brief.'.length))
    if (value !== undefined) return value
    throw new WorkflowInterpolationError(`Missing workflow template value {{${path}}}.`)
  }
  if (path.startsWith('steps.')) {
    const parts = path.slice('steps.'.length).split('.')
    const stepId = parts.shift() ?? ''
    const raw = context.steps instanceof Map ? context.steps.get(stepId) : context.steps[stepId]
    if (raw === undefined) throw new WorkflowInterpolationError(`Step ${stepId} has no output for {{${path}}}.`)
    const output = stepContextValue(raw)
    const value = parts[0] === 'out'
      ? parts.length === 1 ? output : valueAt(output, parts.slice(1).join('.'))
      : valueAt(output, parts.join('.'))
    if (value !== undefined) return value
    throw new WorkflowInterpolationError(`Step ${stepId} has no value for {{${path}}}.`)
  }
  throw new WorkflowInterpolationError(`Unsupported workflow template {{${path}}}.`)
}

function printableTemplateValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null) return 'null'
  if (value === undefined) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export class WorkflowInterpolationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowInterpolationError'
  }
}

/** Resolve templates recursively, preserving the original value type for an exact placeholder. */
export function interpolateTemplate<T>(value: T, context: WorkflowInterpolationContext): T {
  if (typeof value === 'string') {
    const exact = /^\{\{([^{}]+)\}\}$/.exec(value.trim())
    if (exact) return interpolationValue(exact[1].trim(), context) as T
    const rendered = value.replace(/\{\{([^{}]+)\}\}/g, (_match, path: string) => printableTemplateValue(interpolationValue(path.trim(), context)))
    return rendered as T
  }
  if (Array.isArray(value)) return value.map((item) => interpolateTemplate(item, context)) as T
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolateTemplate(item, context)])) as T
  }
  return value
}

export const interpolateWorkflowInput = interpolateTemplate

function safeSegment(value: string): string {
  const safe = value.trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return safe.slice(0, 80) || 'step'
}

function briefObject(value: unknown): unknown {
  if (typeof value === 'string') return { text: value, raw: value }
  if (isRecord(value)) return value
  return { text: printableTemplateValue(value), raw: value }
}

function briefText(value: unknown): string {
  if (typeof value === 'string') return value
  return printableTemplateValue(value)
}

function jsonText(value: unknown): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function resultStatus(value: unknown): WorkflowStepExecution['status'] {
  return isRecord(value) && typeof value.status === 'string' ? value.status as WorkflowStepExecution['status'] : undefined
}

function normalizeExecution(value: unknown): WorkflowStepExecution {
  if (typeof value === 'string') return { status: 'ok', output: value, result: { status: 'ok', notes: value } }
  if (!isRecord(value)) return { status: 'ok', output: value, result: value }
  const result = value.result ?? value
  const output = value.output !== undefined ? value.output : value.out !== undefined ? value.out : value.outputs !== undefined ? value.outputs : result
  const outputs = Array.isArray(value.outputs)
    ? value.outputs.filter((item): item is JobOutput => isRecord(item) && typeof item.path === 'string' && typeof item.type === 'string' && typeof item.title === 'string')
    : isRecord(result) && Array.isArray(result.outputs)
      ? result.outputs.filter((item): item is JobOutput => isRecord(item) && typeof item.path === 'string' && typeof item.type === 'string' && typeof item.title === 'string')
      : undefined
  return {
    ...value,
    status: resultStatus(value) ?? resultStatus(result) ?? 'ok',
    output,
    result,
    ...(outputs ? { outputs } : {})
  }
}

function payloadFor(step: WorkflowStepDefinition, execution: WorkflowStepExecution): string {
  const source = step.gatePayload !== undefined ? step.gatePayload : execution.payload !== undefined ? execution.payload : execution.output !== undefined ? execution.output : execution.result
  return jsonText(source ?? { status: execution.status ?? 'ok', outputs: execution.outputs ?? [], notes: execution.notes ?? '' })
}

function jobStatusFor(status: WorkflowRunRecord['status']): JobStatus {
  if (status === 'waiting_gate') return 'needs_approval'
  if (status === 'stale') return 'stale'
  if (status === 'ok') return 'ok'
  if (status === 'cancelled') return 'cancelled'
  if (status === 'failed') return 'failed'
  return 'running'
}

function workflowStatusForJob(status: JobStatus, stored?: StoredWorkflowState['status']): StoredWorkflowState['status'] {
  if (stored) return stored
  if (status === 'stale') return 'stale'
  if (status === 'cancelled') return 'cancelled'
  if (status === 'ok') return 'ok'
  if (status === 'failed') return 'failed'
  if (status === 'needs_approval') return 'waiting_gate'
  return 'running'
}

function gateRecordFromUnknown(value: unknown): WorkflowGateState | undefined {
  if (!isRecord(value) || (value.gate !== 'review' && value.gate !== 'approve') || typeof value.payload !== 'string') return undefined
  if (typeof value.status !== 'string' || !['pending', 'approved', 'rejected', 'commented', 'expired'].includes(value.status)) return undefined
  if (typeof value.createdAt !== 'string' || typeof value.expiresAt !== 'string') return undefined
  return {
    gate: value.gate,
    status: value.status as WorkflowGateState['status'],
    payload: value.payload,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    ...(typeof value.comments === 'string' ? { comments: value.comments } : {}),
    ...(typeof value.approvedBy === 'string' ? { approvedBy: value.approvedBy } : {}),
    ...(typeof value.approvedAt === 'string' ? { approvedAt: value.approvedAt } : {}),
    ...(typeof value.rejectedAt === 'string' ? { rejectedAt: value.rejectedAt } : {})
  }
}

function stepStateFromUnknown(step: WorkflowStepDefinition, value: unknown): WorkflowStepState {
  const record = isRecord(value) ? value : {}
  const status = typeof record.status === 'string' && ['pending', 'running', 'reviewing', 'retrying', 'waiting_gate', 'completed', 'failed', 'skipped', 'cancelled'].includes(record.status)
    ? record.status as WorkflowStepStatus
    : 'pending'
  return {
    id: step.id,
    status,
    attempt: typeof record.attempt === 'number' ? Math.max(0, Math.trunc(record.attempt)) : 0,
    reviewAttempts: typeof record.reviewAttempts === 'number' ? Math.max(0, Math.trunc(record.reviewAttempts)) : 0,
    reviewRetries: typeof record.reviewRetries === 'number' ? Math.max(0, Math.trunc(record.reviewRetries)) : 0,
    ...(typeof record.jobId === 'string' ? { jobId: record.jobId } : {}),
    ...(record.input !== undefined ? { input: record.input } : {}),
    ...(record.output !== undefined ? { output: record.output } : {}),
    ...(record.result !== undefined ? { result: record.result } : {}),
    ...(Array.isArray(record.outputs) ? { outputs: record.outputs as JobOutput[] } : {}),
    ...(isRecord(record.review) && (record.review.verdict === 'pass' || record.review.verdict === 'revise') ? { review: normalizeReviewRunResult(record.review) } : {}),
    ...(typeof record.reviewComments === 'string' ? { reviewComments: record.reviewComments } : {}),
    ...(gateRecordFromUnknown(record.gate) ? { gate: gateRecordFromUnknown(record.gate) } : {}),
    ...(typeof record.error === 'string' ? { error: record.error } : {}),
    ...(typeof record.startedAt === 'string' ? { startedAt: record.startedAt } : {}),
    ...(typeof record.finishedAt === 'string' ? { finishedAt: record.finishedAt } : {})
  }
}

function emptyState(definition: WorkflowDefinition, runId: string, folder: string, brief: unknown, now: string): StoredWorkflowState {
  return {
    version: 1,
    workflowId: definition.id,
    workflow: definition.name,
    folder,
    brief,
    status: 'running',
    steps: Object.fromEntries(definition.steps.map((step) => [step.id, stepStateFromUnknown(step, undefined)])),
    createdAt: now,
    updatedAt: now,
    hadRejection: false,
    hadReviewComments: false,
    statsRecorded: false
  }
}

function stateFromRecord(definition: WorkflowDefinition, record: { state: unknown; input: unknown; status: JobStatus; startedAt: string | null; id: string; workflowRunId: string | null }, fallbackFolder: string): StoredWorkflowState {
  if (isRecord(record.state) && record.state.version === 1 && isRecord(record.state.steps)) {
    const raw = record.state
    return {
      version: 1,
      workflowId: typeof raw.workflowId === 'string' ? raw.workflowId : definition.id,
      workflow: typeof raw.workflow === 'string' ? raw.workflow : definition.name,
      folder: typeof raw.folder === 'string' ? raw.folder : fallbackFolder,
      brief: raw.brief ?? record.input,
      ...(typeof raw.language === 'string' ? { language: raw.language } : {}),
      ...(typeof raw.timeBudgetMs === 'number' && Number.isFinite(raw.timeBudgetMs) ? { timeBudgetMs: Math.max(1, Math.trunc(raw.timeBudgetMs)) } : {}),
      ...(typeof raw.inputTokenBudget === 'number' && Number.isFinite(raw.inputTokenBudget) ? { inputTokenBudget: Math.max(1, Math.trunc(raw.inputTokenBudget)) } : {}),
      status: workflowStatusForJob(record.status, typeof raw.status === 'string' ? raw.status as StoredWorkflowState['status'] : undefined),
      steps: Object.fromEntries(definition.steps.map((step) => [step.id, stepStateFromUnknown(step, (raw.steps as Record<string, unknown>)[step.id])])),
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : record.startedAt ?? new Date(0).toISOString(),
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : record.startedAt ?? new Date(0).toISOString(),
      hadRejection: raw.hadRejection === true,
      hadReviewComments: raw.hadReviewComments === true,
      statsRecorded: raw.statsRecorded === true,
      ...(isRecord(raw.acceptance) && typeof raw.acceptance.passed === 'boolean' && Array.isArray(raw.acceptance.checks)
        ? { acceptance: raw.acceptance as unknown as WorkflowAcceptanceResult }
        : {}),
      ...(typeof raw.error === 'string' ? { error: raw.error } : {})
    }
  }
  return emptyState(definition, record.id, fallbackFolder, briefObject(record.input), record.startedAt ?? new Date(0).toISOString())
}

function isTerminalRun(status: WorkflowRunRecord['status']): boolean {
  return status === 'ok' || status === 'failed' || status === 'stale' || status === 'cancelled'
}

function statsForMemory(workflowId: string, stats: Map<string, WorkflowStatsRecord>): WorkflowStatsRecord {
  const existing = stats.get(workflowId)
  if (existing) return existing
  const created: WorkflowStatsRecord = {
    workflowId,
    cleanRuns: 0,
    rejectionCount: 0,
    autonomy: 'assisted',
    promotedAt: null,
    demotedAt: null,
    updatedAt: new Date(0).toISOString()
  }
  stats.set(workflowId, created)
  return created
}

function currentGate(state: StoredWorkflowState): (WorkflowGateState & { stepId: string }) | undefined {
  for (const step of Object.values(state.steps)) if (step.gate?.status === 'pending') return { ...step.gate, stepId: step.id }
  return undefined
}

export class WorkflowRunner {
  private readonly jobs?: JobsRepository
  private readonly jobRunner?: Pick<JobRunner, 'startJob'>
  private readonly stepRunner?: WorkflowStepRunner
  private readonly stepHandler?: WorkflowStepHandler
  private readonly reviewRunner?: ReviewStepRunner
  private readonly notifier?: Pick<Notifier, 'send'>
  private readonly voiceGate?: (gate: WorkflowGateEvent) => void | Promise<void>
  private readonly researchRunner?: WorkflowResearchRunner
  private readonly acceptanceRunner: WorkflowAcceptanceRunner
  private readonly afterGateApproval?: WorkflowGateApprovalHandler
  private readonly homePath: string
  private readonly getSettings: () => AppSettings
  private readonly now: () => Date
  private readonly onEvent?: (event: WorkflowEvent) => void
  private readonly maxConcurrent: number
  private readonly definitions = new Map<string, WorkflowDefinition>()
  private readonly active = new Map<string, ActiveWorkflow>()
  private readonly memoryStats = new Map<string, WorkflowStatsRecord>()
  private closed = false

  constructor(options: WorkflowRunnerOptions = {}) {
    this.jobs = options.jobs
    this.stepRunner = options.stepRunner ?? options.runner
    this.stepHandler = options.stepHandler
    this.reviewRunner = options.reviewStep ?? options.review
    this.notifier = options.notifier ?? options.notify
    this.voiceGate = options.voiceGate
    this.researchRunner = options.research
    this.acceptanceRunner = options.acceptance ?? runWorkflowAcceptance
    this.afterGateApproval = options.afterGateApproval
    this.homePath = resolve(options.homePath ?? options.getSettings?.().octaHomePath ?? process.env.OCTA_HOME?.trim() ?? 'C:\\Octa')
    this.getSettings = options.getSettings ?? (() => ({
      octaHomePath: this.homePath,
      skillsLibraryPath: ''
    } as AppSettings))
    this.now = options.now ?? (() => new Date())
    this.onEvent = options.onEvent
    this.maxConcurrent = Math.max(1, Math.min(3, Math.trunc(options.maxConcurrent ?? 3)))
    for (const raw of LAUNCH_WORKFLOWS) {
      const checked = validateWorkflow(raw)
      if (checked.valid && checked.definition) this.definitions.set(checked.definition.id, checked.definition)
    }
    this.refreshFromDatabase()
  }

  private refreshFromDatabase(): void {
    for (const record of this.jobs?.listWorkflows() ?? []) {
      const checked = validateWorkflow(record.definition)
      if (checked.valid && checked.definition) this.definitions.set(checked.definition.id, checked.definition)
    }
  }

  seedLaunchWorkflows(): WorkflowDefinition[] {
    const seeded: WorkflowDefinition[] = []
    for (const raw of LAUNCH_WORKFLOWS) {
      const checked = validateWorkflow(raw)
      if (!checked.valid || !checked.definition) throw new Error(`Launch workflow ${String((raw as { id?: unknown }).id)} is invalid: ${checked.errors.join(' ')}`)
      const definition = checked.definition
      this.definitions.set(definition.id, definition)
      this.jobs?.saveWorkflow({ id: definition.id, name: definition.name, version: definition.version, definition })
      this.ensureStats(definition.id, definition.autonomy ?? 'assisted')
      seeded.push(definition)
    }
    return seeded
  }

  list(): WorkflowListItem[] {
    this.refreshFromDatabase()
    return [...this.definitions.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((definition) => ({
        ...definition,
        stats: this.ensureStats(definition.id, definition.autonomy ?? 'assisted'),
        latestRun: this.latestRun(definition)
      }))
  }

  listWorkflows(): WorkflowListItem[] {
    return this.list()
  }

  getWorkflow(idOrName: string): WorkflowDefinition | null {
    this.refreshFromDatabase()
    const exact = this.definitions.get(idOrName.trim())
    if (exact) return exact
    return [...this.definitions.values()].find((definition) => definition.name === idOrName.trim()) ?? null
  }

  getDefinition(idOrName: string): WorkflowDefinition | null {
    return this.getWorkflow(idOrName)
  }

  private resolveDefinition(idOrName: string): WorkflowDefinition {
    const definition = this.getWorkflow(idOrName)
    if (!definition) throw new Error(`Workflow "${idOrName}" was not found.`)
    const checked = validateWorkflow(definition)
    if (!checked.valid || !checked.definition) throw new Error(`Workflow "${idOrName}" is invalid: ${checked.errors.join(' ')}`)
    return checked.definition
  }

  private ensureStats(workflowId: string, autonomy: WorkflowAutonomy): WorkflowStatsRecord {
    if (this.jobs) return this.jobs.ensureWorkflowStats(workflowId, autonomy)
    return statsForMemory(workflowId, this.memoryStats)
  }

  getStats(workflowIdOrName: string): WorkflowStatsRecord {
    const definition = this.getWorkflow(workflowIdOrName)
    const id = definition?.id ?? workflowIdOrName
    return this.jobs?.getWorkflowStats(id) ?? statsForMemory(id, this.memoryStats)
  }

  private latestRun(definition: WorkflowDefinition): WorkflowRunRecord | null {
    const active = [...this.active.values()]
      .filter((context) => context.definition.id === definition.id)
      .sort((a, b) => b.state.updatedAt.localeCompare(a.state.updatedAt))[0]
    if (active) return this.snapshot(active)
    const row = (this.jobs?.listWorkflowRuns(100) ?? []).find((item) => item.workflow === definition.name || item.workflow === definition.id)
    return row ? this.snapshotFromRow(row, definition) : null
  }

  saveAsWorkflow(name: string, source: unknown): WorkflowDefinition {
    const cleanName = name.trim()
    if (!cleanName) throw new Error('A workflow name is required.')
    const rawSource = isRecord(source) && source.plan !== undefined ? source.plan : source
    if (!isRecord(rawSource)) throw new Error('A plan or workflow definition is required.')
    const sourceSteps = Array.isArray(rawSource.steps) ? rawSource.steps : []
    const slug = cleanName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'custom'
    const candidate: Record<string, unknown> = {
      ...rawSource,
      id: text(rawSource.id)?.trim() || `custom-${slug}`,
      name: cleanName,
      version: Number.isInteger(rawSource.version) ? rawSource.version : 1,
      acceptance: Array.isArray(rawSource.acceptance) ? rawSource.acceptance : [],
      steps: sourceSteps.map((step) => isRecord(step) ? {
        ...step,
        needs: Array.isArray(step.needs) ? step.needs : [],
        gate: validGate(step.gate) ?? 'none',
        autonomy: validAutonomy(step.autonomy),
        acceptance: Array.isArray(step.acceptance) ? step.acceptance : []
      } : step)
    }
    const checked = validateWorkflow(candidate)
    if (!checked.valid || !checked.definition) throw new Error(`Custom workflow is invalid: ${checked.errors.join(' ')}`)
    const definition = checked.definition
    this.definitions.set(definition.id, definition)
    this.jobs?.saveWorkflow({ id: definition.id, name: definition.name, version: definition.version, definition })
    this.ensureStats(definition.id, definition.autonomy ?? 'assisted')
    return definition
  }

  save(name: string, source: unknown): WorkflowDefinition {
    return this.saveAsWorkflow(name, source)
  }

  start(workflowOrRequest: string | WorkflowStartRequest, briefValue?: unknown, options: WorkflowStartOptions = {}): WorkflowRunHandle {
    if (this.closed) throw new Error('The workflow runner is closed.')
    const request = typeof workflowOrRequest === 'string'
      ? { workflow: workflowOrRequest, brief: briefValue, ...options }
      : workflowOrRequest
    const definition = this.resolveDefinition(request.workflow)
    const runId = options.runId ?? randomUUID()
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(runId)) throw new Error('Workflow run id contains invalid characters.')
    if (this.active.has(runId) || this.jobs?.getJob(runId)) throw new Error(`Workflow run ${runId} already exists.`)
    const folder = join(this.homePath, 'jobs', runId)
    mkdirSync(folder, { recursive: true })
    const brief = briefObject(request.brief)
    const now = this.now().toISOString()
    const state = emptyState(definition, runId, folder, brief, now)
    if (request.language?.trim()) state.language = request.language.trim()
    if (request.timeBudgetMs !== undefined && Number.isFinite(request.timeBudgetMs)) state.timeBudgetMs = Math.max(1, Math.trunc(request.timeBudgetMs))
    if (request.inputTokenBudget !== undefined && Number.isFinite(request.inputTokenBudget)) state.inputTokenBudget = Math.max(1, Math.trunc(request.inputTokenBudget))
    writeFileSync(join(folder, 'workflow.json'), `${JSON.stringify(definition, null, 2)}\n`, 'utf8')
    writeFileSync(join(folder, 'brief.json'), `${JSON.stringify(brief, null, 2)}\n`, 'utf8')
    this.jobs?.createJob({
      id: runId,
      workflowRunId: runId,
      planId: request.planId ?? null,
      workflow: definition.name,
      runner: 'workflow',
      status: 'running',
      autonomy: request.autonomy ?? this.ensureStats(definition.id, definition.autonomy ?? 'assisted').autonomy,
      gate: 'none',
      input: brief,
      state
    })
    const context = this.createContext(definition, state, {
      planId: request.planId,
      language: request.language,
      autonomy: request.autonomy,
      timeBudgetMs: request.timeBudgetMs,
      inputTokenBudget: request.inputTokenBudget
    })
    return this.begin(context)
  }

  startWorkflow(request: WorkflowStartRequest): WorkflowRunHandle {
    return this.start(request)
  }

  private createContext(definition: WorkflowDefinition, state: StoredWorkflowState, options: WorkflowStartOptions): ActiveWorkflow {
    const emitter = new EventEmitter()
    const context: ActiveWorkflow = {
      runId: basename(state.folder),
      definition,
      state,
      folder: state.folder,
      planId: options.planId,
      language: options.language,
      timeBudgetMs: options.timeBudgetMs,
      inputTokenBudget: options.inputTokenBudget,
      emitter,
      active: new Map(),
      handles: new Map(),
      wakeResolvers: [],
      wakePending: false,
      gateTimers: new Map(),
      cancelled: false,
      promise: Promise.resolve(undefined as never)
    }
    return context
  }

  private begin(context: ActiveWorkflow): WorkflowRunHandle {
    this.active.set(context.runId, context)
    const promise = this.drive(context)
      .catch((error: unknown) => {
        this.failWorkflow(context, errorText(error))
        return this.snapshot(context)
      })
      .finally(() => {
        this.active.delete(context.runId)
      })
    context.promise = promise
    return {
      id: context.runId,
      runId: context.runId,
      folder: context.folder,
      promise,
      result: promise,
      events: context.emitter,
      onEvent: (listener) => {
        context.emitter.on('event', listener)
        return () => context.emitter.removeListener('event', listener)
      },
      cancel: () => this.cancel(context.runId)
    }
  }

  resume(runId: string): WorkflowRunHandle {
    if (this.closed) throw new Error('The workflow runner is closed.')
    const existing = this.active.get(runId)
    if (existing) return this.handleFor(existing)
    const row = this.jobs?.getJob(runId)
    if (!row || row.runner !== 'workflow') throw new Error(`Workflow run ${runId} was not found.`)
    const definition = this.resolveDefinition(row.workflow ?? '')
    if (row.status === 'stale' || row.status === 'cancelled' || row.status === 'ok') return this.handleFor(this.contextFromRow(row, definition))
    const context = this.contextFromRow(row, definition)
    for (const step of definition.steps) {
      const state = context.state.steps[step.id]
      if (state.status === 'running' || state.status === 'reviewing' || state.status === 'retrying') {
        state.status = 'pending'
        state.error = undefined
      }
      if (state.status === 'failed') {
        state.status = 'pending'
        state.error = undefined
        if (state.gate?.status !== 'pending') state.gate = undefined
      }
      if (state.gate?.status === 'pending') this.scheduleGateExpiry(context, step.id, state.gate)
    }
    context.state.error = undefined
    context.state.status = currentGate(context.state) ? 'waiting_gate' : 'running'
    context.state.updatedAt = this.now().toISOString()
    this.persist(context)
    return this.begin(context)
  }

  resumeWorkflow(runId: string): WorkflowRunHandle {
    return this.resume(runId)
  }

  resumePending(): WorkflowRunHandle[] {
    const rows = this.jobs?.listWorkflowRuns(500) ?? []
    return rows
      .filter((row) => row.status === 'running' || row.status === 'needs_approval')
      .flatMap((row) => {
        try { return [this.resume(row.id)] } catch (error) {
          console.error(`[workflow] could not resume ${row.id}: ${errorText(error)}`)
          return []
        }
      })
  }

  resumeAll(): WorkflowRunHandle[] {
    return this.resumePending()
  }

  getRun(runId: string): WorkflowRunRecord | null {
    const active = this.active.get(runId)
    if (active) {
      this.expireGates(active)
      return this.snapshot(active)
    }
    const row = this.jobs?.getJob(runId)
    if (!row || row.runner !== 'workflow') return null
    const definition = this.getWorkflow(row.workflow ?? '')
    if (!definition) return null
    const context = this.contextFromRow(row, definition)
    this.expireGates(context)
    return this.snapshot(context)
  }

  getWorkflowRun(runId: string): WorkflowRunRecord | null {
    return this.getRun(runId)
  }

  get(idOrName: string): WorkflowDefinition | WorkflowRunRecord | null {
    return this.getRun(idOrName) ?? this.getWorkflow(idOrName)
  }

  listRuns(limit = 100): WorkflowRunRecord[] {
    const byId = new Map<string, WorkflowRunRecord>()
    for (const context of this.active.values()) byId.set(context.runId, this.snapshot(context))
    for (const row of this.jobs?.listWorkflowRuns(limit) ?? []) {
      const definition = this.getWorkflow(row.workflow ?? '')
      if (definition && !byId.has(row.id)) byId.set(row.id, this.snapshotFromRow(row, definition))
    }
    return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  private contextFromRow(row: ReturnType<JobsRepository['getJob']> extends infer T ? NonNullable<T> : never, definition: WorkflowDefinition): ActiveWorkflow {
    const folder = isRecord(row.state) && typeof row.state.folder === 'string' ? row.state.folder : join(this.homePath, 'jobs', row.id)
    const state = stateFromRecord(definition, row, folder)
    return {
      ...this.createContext(definition, state, {
        planId: row.planId,
        language: state.language,
        timeBudgetMs: state.timeBudgetMs,
        inputTokenBudget: state.inputTokenBudget
      }),
      runId: row.id,
      folder
    }
  }

  private snapshotFromRow(row: NonNullable<ReturnType<JobsRepository['getJob']>>, definition: WorkflowDefinition): WorkflowRunRecord {
    return this.snapshot(this.contextFromRow(row, definition))
  }

  private snapshot(context: ActiveWorkflow): WorkflowRunRecord {
    const gate = currentGate(context.state)
    return {
      runId: context.runId,
      workflowId: context.definition.id,
      workflow: context.definition.name,
      folder: context.folder,
      brief: context.state.brief,
      status: context.state.status,
      steps: context.definition.steps.map((step) => ({ ...context.state.steps[step.id] })),
      ...(gate ? { currentGate: gate } : {}),
      createdAt: context.state.createdAt,
      updatedAt: context.state.updatedAt,
      ...(context.state.acceptance ? { acceptance: context.state.acceptance } : {}),
      ...(context.state.error ? { error: context.state.error } : {})
    }
  }

  private handleFor(context: ActiveWorkflow): WorkflowRunHandle {
    const promise = isTerminalRun(context.state.status)
      ? Promise.resolve(this.snapshot(context))
      : context.promise
    return {
      id: context.runId,
      runId: context.runId,
      folder: context.folder,
      promise,
      result: promise,
      events: context.emitter,
      onEvent: (listener) => {
        context.emitter.on('event', listener)
        return () => context.emitter.removeListener('event', listener)
      },
      cancel: () => this.cancel(context.runId)
    }
  }

  private emit(context: ActiveWorkflow, event: WorkflowEvent): void {
    context.emitter.emit('event', event)
    this.onEvent?.(event)
    try {
      appendFileSync(join(context.folder, 'workflow.log.jsonl'), `${JSON.stringify(event)}\n`, 'utf8')
    } catch {
      // A read-only or partially removed job folder must not stop the workflow.
    }
  }

  private emitStep(context: ActiveWorkflow, step: WorkflowStepDefinition, status: WorkflowStepStatus, message?: string): void {
    this.emit(context, {
      type: 'workflow:step',
      runId: context.runId,
      workflowId: context.definition.id,
      timestamp: this.now().toISOString(),
      stepId: step.id,
      status,
      attempt: context.state.steps[step.id].attempt,
      ...(message ? { message } : {}),
      ...(context.state.steps[step.id].output !== undefined ? { output: context.state.steps[step.id].output } : {})
    })
  }

  private emitGate(context: ActiveWorkflow, step: WorkflowStepDefinition, gate: WorkflowGateState, status: WorkflowGateState['status'], message?: string): WorkflowGateEvent {
    const event: WorkflowGateEvent = {
      type: 'workflow:gate',
      runId: context.runId,
      workflowId: context.definition.id,
      timestamp: this.now().toISOString(),
      stepId: step.id,
      gate: gate.gate,
      status,
      payload: gate.payload,
      expiresAt: gate.expiresAt,
      ...(message ? { message } : {})
    }
    this.emit(context, event)
    return event
  }

  private scheduleGateExpiry(context: ActiveWorkflow, stepId: string, gate: WorkflowGateState): void {
    const previous = context.gateTimers.get(stepId)
    if (previous) clearTimeout(previous)
    const delay = Math.max(0, Date.parse(gate.expiresAt) - this.now().getTime())
    const timer = setTimeout(() => {
      context.gateTimers.delete(stepId)
      this.expireGates(context)
      this.signal(context)
    }, delay + 1)
    context.gateTimers.set(stepId, timer)
    const timerWithUnref = timer as unknown as { unref?: () => void }
    timerWithUnref.unref?.()
  }

  private clearGateExpiry(context: ActiveWorkflow, stepId: string): void {
    const timer = context.gateTimers.get(stepId)
    if (!timer) return
    clearTimeout(timer)
    context.gateTimers.delete(stepId)
  }

  private clearAllGateExpiry(context: ActiveWorkflow): void {
    for (const timer of context.gateTimers.values()) clearTimeout(timer)
    context.gateTimers.clear()
  }

  private persist(context: ActiveWorkflow): void {
    context.state.updatedAt = this.now().toISOString()
    const gate = currentGate(context.state)
    const row = this.jobs?.updateJob(context.runId, {
      status: jobStatusFor(context.state.status),
      state: context.state,
      result: {
        workflow_id: context.definition.id,
        workflow: context.definition.name,
        status: context.state.status,
        steps: context.definition.steps.map((step) => ({
          id: step.id,
          status: context.state.steps[step.id].status,
          job_id: context.state.steps[step.id].jobId,
          output: context.state.steps[step.id].output,
          error: context.state.steps[step.id].error
        })),
        ...(context.state.acceptance ? { acceptance: context.state.acceptance } : {})
      },
      gate: gate ? gate.gate : 'none',
      gatePayload: gate ? gate.payload : null,
      gateCreatedAt: gate ? gate.createdAt : null,
      gateExpiresAt: gate ? gate.expiresAt : null,
      gateDecision: gate ? gate.status : null,
      gateComments: gate?.comments ?? null,
      finishedAt: isTerminalRun(context.state.status) ? context.state.updatedAt : null,
      error: context.state.error ?? null
    })
    if (!row) {
      mkdirSync(context.folder, { recursive: true })
      try { writeFileSync(join(context.folder, 'workflow-state.json'), `${JSON.stringify(context.state, null, 2)}\n`, 'utf8') } catch { /* best effort for memory-only runners */ }
    }
  }

  private async drive(context: ActiveWorkflow): Promise<WorkflowRunRecord> {
    while (true) {
      this.expireGates(context)
      if (context.cancelled && context.state.status !== 'cancelled') {
        context.state.status = 'cancelled'
        this.persist(context)
      }
      if (isTerminalRun(context.state.status)) {
        if (context.active.size === 0) {
          this.clearAllGateExpiry(context)
          this.recordStatsIfNeeded(context)
          this.persist(context)
          return this.snapshot(context)
        }
        await this.waitForActive(context)
        continue
      }
      const pendingGate = currentGate(context.state)
      const ready = context.definition.steps.filter((step) => {
        const state = context.state.steps[step.id]
        return state.status === 'pending' && step.needs.every((need) => TERMINAL_STEP_STATUSES.has(context.state.steps[need].status))
      })
      while (!context.cancelled && context.state.status !== 'failed' && context.active.size < this.maxConcurrent && ready.length > 0) {
        const step = ready.shift()!
        const task = this.executeStep(context, step)
          .catch((error: unknown) => this.failStep(context, step, errorText(error)))
          .finally(() => {
            context.active.delete(step.id)
            this.signal(context)
          })
        context.active.set(step.id, task)
      }
      if (context.active.size > 0) {
        await this.waitForActive(context)
        continue
      }
      if (context.state.status === 'failed') {
        this.persist(context)
        continue
      }
      const allDone = context.definition.steps.every((step) => TERMINAL_STEP_STATUSES.has(context.state.steps[step.id].status))
      if (allDone && !currentGate(context.state)) {
        if (!context.state.acceptance) {
          const finishedAt = this.now().toISOString()
          const acceptanceContext: WorkflowAcceptanceContext = {
            workflowId: context.definition.id,
            workflow: context.definition.name,
            brief: context.state.brief,
            folder: context.folder,
            steps: context.definition.steps.map((step) => ({ ...context.state.steps[step.id] })),
            acceptance: context.definition.acceptance,
            language: context.language,
            startedAt: context.state.createdAt,
            finishedAt
          }
          context.state.acceptance = await this.acceptanceRunner(acceptanceContext)
          if (!context.state.acceptance.passed) {
            context.state.status = 'failed'
            context.state.error = context.state.acceptance.checks
              .filter((item) => !item.passed)
              .map((item) => `${item.criterion}: ${item.detail}`)
              .join(' ') || 'Workflow acceptance checks failed.'
            this.persist(context)
            this.signal(context)
            continue
          }
        }
        context.state.status = 'ok'
        this.persist(context)
        this.recordStatsIfNeeded(context)
        this.persist(context)
        return this.snapshot(context)
      }
      if (pendingGate || currentGate(context.state)) {
        context.state.status = 'waiting_gate'
        this.persist(context)
        await this.waitForSignal(context)
        continue
      }
      const blocked = context.definition.steps.find((step) => context.state.steps[step.id].status === 'pending')
      this.failWorkflow(context, blocked ? `Step ${blocked.id} is blocked by an unfinished dependency.` : 'The workflow has no runnable steps.')
    }
  }

  private async waitForActive(context: ActiveWorkflow): Promise<void> {
    if (context.active.size === 0) return
    await Promise.race([...context.active.values()])
  }

  private async waitForSignal(context: ActiveWorkflow): Promise<void> {
    if (context.wakePending) {
      context.wakePending = false
      return
    }
    await new Promise<void>((resolvePromise) => context.wakeResolvers.push(resolvePromise))
    context.wakePending = false
  }

  private signal(context: ActiveWorkflow): void {
    if (context.wakeResolvers.length > 0) {
      const resolvers = context.wakeResolvers.splice(0)
      resolvers.forEach((resolvePromise) => resolvePromise())
    } else context.wakePending = true
  }

  private async executeStep(context: ActiveWorkflow, step: WorkflowStepDefinition): Promise<void> {
    const state = context.state.steps[step.id]
    state.status = 'running'
    state.startedAt = this.now().toISOString()
    this.persist(context)
    this.emitStep(context, step, 'running')
    if (step.todo) {
      const message = `Skipped todo step ${step.id} (${step.runner}) — pending its owning spec. / تم تخطي الخطوة ${step.id} (${step.runner}) — المواصفة المالكة لم تُدمج بعد.`
      state.status = 'skipped'
      state.output = message
      state.result = { status: 'ok', skipped: true, todo: true, notes: message }
      state.finishedAt = this.now().toISOString()
      this.persist(context)
      this.emitStep(context, step, 'skipped', message)
      return
    }
    let reviewComments = state.reviewComments
    while (true) {
      state.attempt += 1
      const jobId = `${safeSegment(context.runId)}-${safeSegment(step.id)}-a${state.attempt}`
      state.jobId = jobId
      const input = interpolateTemplate(step.input ?? {}, {
        brief: context.state.brief,
        steps: Object.fromEntries(Object.entries(context.state.steps).map(([id, item]) => [id, item.output ?? item.result]))
      })
      state.input = input
      const request: WorkflowStepRunRequest = {
        runId: context.runId,
        workflow: context.definition,
        step,
        input,
        brief: context.state.brief,
        attempt: state.attempt,
        ...(reviewComments ? { reviewComments } : {}),
        folder: context.folder,
        jobId,
        language: context.language,
        timeBudgetMs: context.timeBudgetMs ?? step.timeBudgetMs
      }
      const execution = normalizeExecution(await this.runExecutor(context, request))
      state.result = execution.result
      state.output = execution.output
      state.outputs = execution.outputs
      if (execution.jobId) state.jobId = execution.jobId
      if (execution.folder) state.result = execution.result
      const status = execution.status ?? 'ok'
      if (status !== 'ok' && status !== 'needs_approval') {
        if (status === 'cancelled' || context.cancelled) {
          state.status = 'cancelled'
          state.error = execution.notes ?? 'Step cancelled.'
          state.finishedAt = this.now().toISOString()
          this.persist(context)
          this.emitStep(context, step, 'cancelled', state.error)
          return
        }
        this.failStep(context, step, execution.notes ?? `Step ${step.id} returned ${status}.`)
        return
      }
      state.status = 'reviewing'
      this.persist(context)
      this.emitStep(context, step, 'reviewing')
      let review: ReviewRunResult
      try {
        review = await this.runReviewer(context, request, execution)
      } catch (error) {
        this.failStep(context, step, `Sol review failed: ${errorText(error)}`)
        return
      }
      state.reviewAttempts += 1
      state.review = { verdict: review.verdict, issues: review.issues, ...(review.fixed_output_path ? { fixed_output_path: review.fixed_output_path } : {}) }
      this.persist(context)
      if (review.verdict === 'revise' && state.reviewRetries < 1) {
        state.reviewRetries += 1
        reviewComments = review.issues.map((issue) => `Criterion: ${issue.criterion}\nDetail: ${issue.detail}\nSeverity: ${issue.severity}`).join('\n') || 'Sol requested a revision. Re-check every acceptance criterion.'
        state.reviewComments = reviewComments
        state.status = 'retrying'
        this.persist(context)
        this.emitStep(context, step, 'retrying', 'Sol requested one correction pass. / طلب Sol تمريرة تصحيح واحدة.')
        continue
      }
      if (review.verdict === 'revise') {
        this.failStep(context, step, `Sol still requests revision after the one allowed correction pass: ${review.issues.map((issue) => issue.detail).join(' ')}`)
        return
      }
      if (step.gate === 'none') {
        state.status = 'completed'
        state.finishedAt = this.now().toISOString()
        this.persist(context)
        this.emitStep(context, step, 'completed')
        return
      }
      const createdAt = this.now()
      const gate: WorkflowGateState = {
        gate: step.gate,
        status: 'pending',
        payload: payloadFor(step, execution),
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + GATE_EXPIRY_MS).toISOString(),
        ...(reviewComments ? { comments: reviewComments } : {})
      }
      state.gate = gate
      state.status = 'waiting_gate'
      this.persist(context)
      this.scheduleGateExpiry(context, step.id, gate)
      this.emitStep(context, step, 'waiting_gate', `Waiting for ${step.gate} gate. / في انتظار بوابة ${step.gate}.`)
      const event = this.emitGate(context, step, gate, 'pending', 'Exact payload shown below. / المعروض أدناه هو الـ payload المطابق حرفيًا.')
      await this.notifier?.send(this.notificationForGate(context, step, gate))
      await this.voiceGate?.(event)
      return
    }
  }

  private async runExecutor(context: ActiveWorkflow, request: WorkflowStepRunRequest): Promise<WorkflowStepExecution | unknown> {
    if (this.stepHandler) {
      const handled = await this.stepHandler(request)
      if (handled !== undefined) return handled
    }
    if (this.stepRunner) {
      return this.stepRunner.length >= 2
        ? (this.stepRunner as (step: WorkflowStepDefinition, input: unknown) => Promise<WorkflowStepExecution | unknown> | WorkflowStepExecution | unknown)(request.step, request.input)
        : (this.stepRunner as (request: WorkflowStepRunRequest) => Promise<WorkflowStepExecution | unknown> | WorkflowStepExecution | unknown)(request)
    }
    if (request.step.research || request.step.runner === 'codex-scout' && request.step.skill === 'research') {
      if (this.researchRunner) return this.researchRunner(request)
      return this.runNativeResearch(context, request)
    }
    if (request.step.runner === 'octa-code') throw new Error(`Runner octa-code could not start for step ${request.step.id}.`)
    const jobRunner = this.jobRunner ?? getJobRunner()
    const spec: JobSpec = {
      id: request.jobId,
      runner: request.step.runner as JobRunnerName,
      skill: request.step.skill,
      prompt: [request.step.prompt, request.reviewComments ? `\n\n## Review comments\n${request.reviewComments}` : ''].filter(Boolean).join(''),
      brief: briefText(request.brief),
      input: request.input,
      acceptance: [],
      planId: context.planId,
      workflow: context.definition.name,
      workflowRunId: context.runId,
      stepId: request.step.id,
      department: request.step.department,
      autonomy: request.step.autonomy,
      gate: request.step.gate,
      language: request.language,
      timeBudgetMs: context.timeBudgetMs ?? request.step.timeBudgetMs,
      inputTokenBudget: request.step.inputTokenBudget ?? context.inputTokenBudget,
      maxRetries: request.step.maxRetries,
      ...(request.step.tier ? { tier: request.step.tier } : {}),
      homePath: this.homePath,
      skillsLibraryPath: this.getSettings().skillsLibraryPath || undefined,
      skipReview: true
    }
    const handle = jobRunner.startJob(spec)
    context.handles.set(request.step.id, handle)
    const execution = await handle.promise
    context.handles.delete(request.step.id)
    if (execution.status === 'cancelled') return { status: 'cancelled', result: execution, output: execution, folder: handle.folder, jobId: handle.id, notes: execution.notes }
    return {
      status: execution.status,
      result: execution,
      output: execution,
      outputs: execution.outputs,
      folder: handle.folder,
      jobId: handle.id,
      notes: execution.notes
    }
  }

  private async runNativeResearch(context: ActiveWorkflow, request: WorkflowStepRunRequest): Promise<WorkflowStepExecution> {
    const task = isRecord(request.input) && typeof request.input.task === 'string'
      ? request.input.task.trim()
      : request.step.prompt?.trim() || briefText(request.brief)
    const handle = runResearch(task, {
      homePath: this.homePath,
      jobId: request.jobId,
      workflowRunId: context.runId,
      stepId: request.step.id,
      conversationLanguage: request.language,
      budgetMs: request.timeBudgetMs,
      inputTokenBudget: request.step.inputTokenBudget ?? context.inputTokenBudget,
      runner: this.jobRunner as JobRunner | undefined,
      jobs: this.jobs,
      getSettings: this.getSettings
    })
    context.handles.set(request.step.id, handle)
    const result: ResearchResult = await handle.promise
    context.handles.delete(request.step.id)
    const reportPath = result.reportPath
    const reportRelative = reportPath ? relative(handle.folder, reportPath) : 'evidence/report.md'
    return {
      status: result.status === 'ok' ? 'ok' : result.status === 'cancelled' ? 'cancelled' : 'failed',
      output: result,
      result: result.agent,
      outputs: reportPath ? [{ path: reportRelative, type: 'markdown', title: 'Research report' }] : [],
      folder: handle.folder,
      jobId: handle.id,
      notes: result.gate.failures.join(' ')
    }
  }

  private async runReviewer(context: ActiveWorkflow, request: WorkflowStepRunRequest, execution: WorkflowStepExecution): Promise<ReviewRunResult> {
    const folder = execution.folder ?? context.folder
    const job: ReviewJob = {
      id: execution.jobId ?? request.jobId,
      jobId: execution.jobId ?? request.jobId,
      folder,
      workspace: folder,
      resultPath: join(folder, 'result.json'),
      result: isRecord(execution.result) ? execution.result : null,
      outputs: execution.outputs ?? []
    }
    const step = {
      id: request.step.id,
      stepId: request.step.id,
      runner: request.step.runner,
      acceptance: request.step.acceptance,
      acceptanceCriteria: request.step.acceptance,
      input: request.input,
      outputs: execution.outputs ?? []
    }
    const review = await reviewStep(job, step, this.reviewRunner)
    return normalizeReviewRunResult(review, request.step.acceptance)
  }

  private notificationForGate(context: ActiveWorkflow, step: WorkflowStepDefinition, gate: WorkflowGateState): NotifyOptions {
    const actionUrl = `octa://workflow/${encodeURIComponent(context.runId)}/gate/${encodeURIComponent(step.id)}`
    const action: NotifyAction = { action: 'view', label: gate.gate === 'approve' ? 'Approve / موافقة' : 'Review / مراجعة', url: actionUrl }
    return {
      title: `Octa gate / بوابة Octa: ${gate.gate}`,
      body: gate.payload,
      priority: 'high',
      tags: ['octa', 'approval'],
      actions: [action]
    }
  }

  private failStep(context: ActiveWorkflow, step: WorkflowStepDefinition, message: string): void {
    const state = context.state.steps[step.id]
    state.status = context.cancelled ? 'cancelled' : 'failed'
    state.error = message
    state.finishedAt = this.now().toISOString()
    if (!context.cancelled) {
      context.state.status = 'failed'
      context.state.error = message
    }
    this.persist(context)
    this.emitStep(context, step, state.status, message)
  }

  private failWorkflow(context: ActiveWorkflow, message: string): void {
    context.state.status = context.cancelled ? 'cancelled' : 'failed'
    context.state.error = message
    this.persist(context)
    const pending = context.definition.steps.find((step) => context.state.steps[step.id].status === 'pending')
    if (pending) this.emitStep(context, pending, 'failed', message)
    this.signal(context)
  }

  private expireGates(context: ActiveWorkflow): void {
    const now = this.now().getTime()
    for (const step of context.definition.steps) {
      const state = context.state.steps[step.id]
      const gate = state.gate
      if (!gate || gate.status !== 'pending' || Date.parse(gate.expiresAt) > now) continue
      this.clearGateExpiry(context, step.id)
      gate.status = 'expired'
      state.status = 'failed'
      state.error = `The ${gate.gate} gate expired after 24 hours. / انتهت صلاحية بوابة ${gate.gate} بعد 24 ساعة.`
      state.finishedAt = this.now().toISOString()
      context.state.status = 'stale'
      context.state.error = state.error
      this.persist(context)
      this.emitGate(context, step, gate, 'expired', state.error)
      this.emitStep(context, step, 'failed', state.error)
      this.signal(context)
    }
  }

  private gateStep(context: ActiveWorkflow, request: WorkflowGateActionRequest): WorkflowStepDefinition {
    const step = request.stepId
      ? context.definition.steps.find((item) => item.id === request.stepId)
      : context.definition.steps.find((item) => context.state.steps[item.id].gate?.status === 'pending')
    if (!step) throw new Error('A pending workflow gate step is required.')
    if (!context.state.steps[step.id].gate || context.state.steps[step.id].gate?.status !== 'pending') throw new Error(`Step ${step.id} has no pending gate.`)
    return step
  }

  private async contextForGate(runId: string): Promise<ActiveWorkflow> {
    const active = this.active.get(runId)
    if (active) return active
    const handle = this.resume(runId)
    const context = this.active.get(runId)
    if (!context) {
      await handle.promise
      throw new Error(`Workflow run ${runId} is no longer active.`)
    }
    return context
  }

  async approveGate(request: WorkflowGateActionRequest): Promise<WorkflowRunRecord> {
    const context = await this.contextForGate(request.runId)
    this.expireGates(context)
    const step = this.gateStep(context, request)
    const state = context.state.steps[step.id]
    const gate = state.gate!
    if (gate.gate === 'approve' && request.payload !== gate.payload) throw new Error('Approval payload does not match the exact pending payload.')
    if (request.payload !== undefined && request.payload !== gate.payload) throw new Error('Gate payload does not match the exact pending payload.')
    gate.status = 'approved'
    this.clearGateExpiry(context, step.id)
    gate.approvedBy = request.approvedBy?.trim() || 'owner'
    gate.approvedAt = this.now().toISOString()
    state.status = 'completed'
    state.finishedAt = gate.approvedAt
    context.state.status = 'running'
    this.persist(context)
    if (this.afterGateApproval) {
      await this.afterGateApproval({
        runId: context.runId,
        workflowId: context.definition.id,
        workflow: context.definition.name,
        stepId: step.id,
        folder: context.folder,
        brief: context.state.brief,
        state,
        approvedAt: gate.approvedAt,
        approvedBy: gate.approvedBy
      })
      this.persist(context)
    }
    this.emitGate(context, step, gate, 'approved', 'Gate approved. / تمت الموافقة على البوابة.')
    this.emitStep(context, step, 'completed')
    this.signal(context)
    return this.snapshot(context)
  }

  async rejectGate(request: WorkflowGateActionRequest): Promise<WorkflowRunRecord> {
    const context = await this.contextForGate(request.runId)
    this.expireGates(context)
    const step = this.gateStep(context, request)
    const state = context.state.steps[step.id]
    const gate = state.gate!
    gate.status = 'rejected'
    this.clearGateExpiry(context, step.id)
    gate.rejectedAt = this.now().toISOString()
    gate.comments = request.reason?.trim() || request.comment?.trim()
    state.status = 'failed'
    state.error = gate.comments || 'The gate was rejected. / تم رفض البوابة.'
    state.finishedAt = gate.rejectedAt
    context.state.status = 'failed'
    context.state.error = state.error
    context.state.hadRejection = true
    this.persist(context)
    this.emitGate(context, step, gate, 'rejected', state.error)
    this.emitStep(context, step, 'failed', state.error)
    this.recordStatsRejection(context)
    this.signal(context)
    return this.snapshot(context)
  }

  async commentGate(request: WorkflowGateActionRequest): Promise<WorkflowRunRecord> {
    const context = await this.contextForGate(request.runId)
    this.expireGates(context)
    const step = this.gateStep(context, request)
    const state = context.state.steps[step.id]
    const gate = state.gate!
    const comment = request.comment?.trim() ?? ''
    if (gate.gate !== 'review') throw new Error('Only review gates accept comments.')
    if (!comment) throw new Error('A review comment is required.')
    if (state.reviewRetries >= 1) throw new Error('A review gate allows only one correction pass.')
    gate.status = 'commented'
    this.clearGateExpiry(context, step.id)
    gate.comments = comment
    state.reviewComments = comment
    state.reviewRetries += 1
    state.gate = undefined
    state.status = 'pending'
    context.state.hadReviewComments = true
    context.state.status = 'running'
    this.persist(context)
    this.emitGate(context, step, gate, 'commented', 'Re-running once with your comments. / ستُعاد الخطوة مرة واحدة مع تعليقاتك.')
    this.emitStep(context, step, 'pending', 'Re-running once with review comments. / ستُعاد مرة واحدة مع تعليقات المراجعة.')
    this.signal(context)
    return this.snapshot(context)
  }

  gateApprove(request: WorkflowGateActionRequest): Promise<WorkflowRunRecord> {
    return this.approveGate(request)
  }

  gateReject(request: WorkflowGateActionRequest): Promise<WorkflowRunRecord> {
    return this.rejectGate(request)
  }

  gateComment(request: WorkflowGateActionRequest): Promise<WorkflowRunRecord> {
    return this.commentGate(request)
  }

  private recordStatsIfNeeded(context: ActiveWorkflow): void {
    if (context.state.status !== 'ok' || context.state.statsRecorded || context.state.hadRejection || context.state.hadReviewComments) return
    context.state.statsRecorded = true
    if (this.jobs) this.jobs.recordWorkflowCleanRun(context.definition.id)
    else {
      const existing = statsForMemory(context.definition.id, this.memoryStats)
      const cleanRuns = existing.cleanRuns + 1
      const promoted = cleanRuns >= 10 || existing.autonomy === 'auto'
      this.memoryStats.set(context.definition.id, {
        ...existing,
        cleanRuns,
        autonomy: promoted ? 'auto' : existing.autonomy,
        promotedAt: promoted ? existing.promotedAt ?? this.now().toISOString() : existing.promotedAt,
        updatedAt: this.now().toISOString()
      })
    }
  }

  private recordStatsRejection(context: ActiveWorkflow): void {
    if (this.jobs) this.jobs.recordWorkflowRejection(context.definition.id)
    else {
      const existing = statsForMemory(context.definition.id, this.memoryStats)
      this.memoryStats.set(context.definition.id, {
        ...existing,
        cleanRuns: 0,
        rejectionCount: existing.rejectionCount + 1,
        autonomy: 'assisted',
        demotedAt: this.now().toISOString(),
        updatedAt: this.now().toISOString()
      })
    }
  }

  async cancel(runId: string): Promise<boolean> {
    const context = this.active.get(runId)
    if (!context) return Boolean(this.jobs?.getJob(runId))
    context.cancelled = true
    this.clearAllGateExpiry(context)
    await Promise.all([...context.handles.values()].map((handle) => handle.cancel().catch(() => false)))
    context.state.status = 'cancelled'
    this.persist(context)
    this.signal(context)
    await context.promise
    return true
  }

  async close(): Promise<void> {
    this.closed = true
    await Promise.all([...this.active.keys()].map((runId) => this.cancel(runId)))
  }
}

export const WorkflowExecutor = WorkflowRunner

export function createWorkflowRunner(options: WorkflowRunnerOptions = {}): WorkflowRunner {
  return new WorkflowRunner(options)
}

export function runWorkflow(
  workflow: WorkflowDefinition,
  brief: unknown,
  options: WorkflowRunnerOptions & WorkflowStartOptions = {}
): WorkflowRunHandle {
  const runner = new WorkflowRunner(options)
  runner.saveAsWorkflow(workflow.name, workflow)
  return runner.start(workflow.id, brief, options)
}

export interface RecurringSeedDefinition {
  id: string
  name: string
  workflow: string
  every: string
  autonomy: 'assisted'
  enabled: boolean
  input?: unknown
}

export const DEFAULT_RECURRING_JOBS: readonly RecurringSeedDefinition[] = [
  { id: 'daily-brief', name: 'Daily brief', workflow: 'daily-brief', every: 'daily 08:00', autonomy: 'assisted', enabled: true, input: { placeholder: true } },
  { id: 'prospect-list-refresh', name: 'Prospect list refresh', workflow: 'custom', every: 'weekly', autonomy: 'assisted', enabled: true, input: { placeholder: true } },
  { id: 'competitor-watch', name: 'Competitor watch per active client', workflow: 'research', every: 'monthly', autonomy: 'assisted', enabled: true },
  { id: 'seo-performance-check', name: 'SEO + performance check per live client site', workflow: 'review-website', every: 'monthly', autonomy: 'assisted', enabled: true },
  { id: 'content-batch', name: 'Content batch for next week', workflow: 'market-project', every: 'weekly', autonomy: 'assisted', enabled: true },
  { id: 'brain-consolidation', name: 'Brain consolidation', workflow: 'custom', every: 'monthly', autonomy: 'assisted', enabled: true, input: { placeholder: true } },
  { id: 'weekly-retro', name: 'Weekly retro: what to improve', workflow: 'weekly-retro', every: 'weekly', autonomy: 'assisted', enabled: true, input: {} }
]

function localDateAt(date: Date, hour: number, minute: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute, 0, 0)
}

/** Compute the next occurrence for the small cadence vocabulary used by the launch seeds. */
export function nextRecurringRun(every: string, from: Date = new Date()): Date {
  const value = every.trim().toLowerCase()
  if (value === 'once') return new Date(from.getTime())
  const daily = /^daily(?:\s+(\d{1,2}):(\d{2}))?$/.exec(value)
  if (daily) {
    const hour = Math.min(23, Number(daily[1] ?? 8))
    const minute = Math.min(59, Number(daily[2] ?? 0))
    const candidate = localDateAt(from, hour, minute)
    if (candidate.getTime() > from.getTime()) return candidate
    candidate.setDate(candidate.getDate() + 1)
    return candidate
  }
  if (value === 'weekly') return new Date(from.getTime() + 7 * 24 * 60 * 60 * 1_000)
  if (value === 'monthly') {
    const candidate = new Date(from.getTime())
    candidate.setMonth(candidate.getMonth() + 1)
    return candidate
  }
  throw new Error(`Unsupported recurring cadence: ${every}`)
}

export function seedRecurringJobs(jobs: JobsRepository, now: () => Date = () => new Date()): RecurringJobRecord[] {
  const current = now()
  return DEFAULT_RECURRING_JOBS.map((seed) => {
    const existing = jobs.getRecurringJob(seed.id)
    const input: SaveRecurringJobInput = {
      ...seed,
      nextRunAt: existing?.nextRunAt ?? nextRecurringRun(seed.every, current).toISOString(),
      lastRunAt: existing?.lastRunAt ?? null,
      input: seed.input ?? existing?.input
    }
    return jobs.saveRecurringJob(input)
  })
}

export interface RecurringSchedulerOptions {
  jobs: JobsRepository
  workflows: WorkflowRunner
  /** Runs a scheduled agent (recurring jobs whose workflow is `agent:<id>`, spec 018). */
  runAgent?: (agentId: string) => void
  /** Owner's pause switch: while true nothing scheduled starts, and due runs wait (not skipped). */
  isPaused?: () => boolean
  now?: () => Date
  intervalMs?: number
  onEvent?: (message: string) => void
}

export class RecurringScheduler {
  private readonly jobs: JobsRepository
  private readonly workflows: WorkflowRunner
  private readonly now: () => Date
  private readonly intervalMs: number
  private readonly onEvent?: (message: string) => void
  private readonly runAgent?: (agentId: string) => void
  private readonly isPaused?: () => boolean
  private timer?: ReturnType<typeof setInterval>
  private running = false

  constructor(options: RecurringSchedulerOptions) {
    this.jobs = options.jobs
    this.workflows = options.workflows
    this.now = options.now ?? (() => new Date())
    this.intervalMs = Math.max(1_000, Math.trunc(options.intervalMs ?? 60_000))
    this.onEvent = options.onEvent
    this.runAgent = options.runAgent
    this.isPaused = options.isPaused
  }

  start(): void {
    if (this.running) return
    this.running = true
    void this.tick()
    this.timer = setInterval(() => { void this.tick() }, this.intervalMs)
    const timerWithUnref = this.timer as unknown as { unref?: () => void }
    timerWithUnref.unref?.()
  }

  stop(): void {
    this.running = false
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  async tick(): Promise<RecurringJobRecord[]> {
    if (this.isPaused?.()) return []
    const now = this.now()
    const due = this.jobs.listRecurringJobs().filter((job) => job.enabled && job.nextRunAt && Date.parse(job.nextRunAt) <= now.getTime())
    const started: RecurringJobRecord[] = []
    for (const job of due) {
      const once = job.every.trim().toLowerCase() === 'once'
      const next = once ? null : nextRecurringRun(job.every, now).toISOString()
      const input = isRecord(job.input) ? { ...job.input, recurringJobId: job.id } : { value: job.input, recurringJobId: job.id }
      if (isRecord(job.input) && job.input.placeholder === true) {
        const message = `Skipped recurring placeholder ${job.id}. / تم تخطي المهمة المجدولة الوهمية ${job.id}.`
        this.onEvent?.(message)
        this.jobs.recordRecurringRun(job.id, now.toISOString(), next)
        continue
      }
      if (job.workflow.startsWith('agent:')) {
        try {
          if (!this.runAgent) throw new Error('No agent runner is configured.')
          this.runAgent(job.workflow.slice('agent:'.length))
          started.push(this.jobs.recordRecurringRun(job.id, now.toISOString(), next) ?? job)
        } catch (error) {
          this.onEvent?.(`Scheduled agent ${job.id} could not start: ${errorText(error)}`)
          this.jobs.recordRecurringRun(job.id, now.toISOString(), next)
        }
        continue
      }
      if (once && job.workflow === 'invoice-follow-up') {
        this.onEvent?.(`Completed one-time invoice follow-up ${job.id}.`)
        this.jobs.recordRecurringRun(job.id, now.toISOString(), null)
        continue
      }
      try {
        const handle = this.workflows.start(job.workflow, input, { autonomy: job.autonomy })
        started.push(this.jobs.recordRecurringRun(job.id, now.toISOString(), next) ?? job)
        void handle.promise.catch((error: unknown) => this.onEvent?.(`Recurring workflow ${job.id} failed: ${errorText(error)}`))
      } catch (error) {
        this.onEvent?.(`Recurring workflow ${job.id} could not start: ${errorText(error)}`)
        this.jobs.recordRecurringRun(job.id, now.toISOString(), next)
      }
    }
    return started
  }
}

export const WorkflowScheduler = RecurringScheduler

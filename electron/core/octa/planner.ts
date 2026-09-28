import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ChatMessage } from '../../cloud/chat'
import {
  CompanyBrain,
  loadBrain as loadCompanyBrain,
  type BrainLoadOptions
} from './brain'
import {
  JobsRepository,
  type PlanStatus
} from '../../db/jobs'
import {
  JobRunner,
  resolveSkill,
  type JobRunnerOptions
} from '../jobs/runner'
import {
  rejectUnsourced,
  type LedgerInput
} from './sources'
import { isModelTier, MODEL_TIERS } from './models'
import type { ModelTier } from '../../types'
import planSchema from './schemas/plan.schema.json'
import critiqueSchema from './schemas/critique.schema.json'

export const DEFAULT_PLANNER_HOME = 'C:\\Octa'
export const MAX_DEBATE_ROUNDS = 4
export const MAX_QUESTION_ROUNDS = 3

export type PlanLanguage = 'ar-EG' | 'en' | 'mixed'
export type PlannerRunnerName = 'claude-plan' | 'codex-critic'
export type PlannerPhase = 'draft' | 'critique' | 'reply'

export interface PlanQuestion {
  id: string
  text: string
  why: string
  options: string[]
  blocking: boolean
}

export interface PlanStep {
  id: string
  runner: 'codex-scout' | 'claude-skill' | 'octa-code' | 'gemini-inline' | 'codex-exec'
  skill?: string
  prompt?: string
  input?: Record<string, unknown>
  needs: string[]
  gate: 'none' | 'review' | 'approve'
  autonomy: 'led' | 'assisted' | 'auto'
  acceptance: string[]
  /** Model tier the manager picked for this step (spec 018); the runner's default when absent. */
  tier?: ModelTier
}

export interface PlanReply {
  issue: string
  decision: 'accepted' | 'rejected'
  reason: string
}

/** The planner contract from docs/01-RUNTIME-CONTRACT.md §3.1. */
export interface OctaPlan {
  plan_id: string
  language: PlanLanguage
  summary: string
  questions: PlanQuestion[]
  assumptions: string[]
  workflow: 'review-website' | 'build-website' | 'market-project' | 'think-project' | 'invoice' | 'research' | 'custom'
  steps: PlanStep[]
  deliverables: string[]
  estimated_minutes: number
  replies?: PlanReply[]
}

export interface PlanCritique {
  issues: string[]
  missing_questions: string[]
  risks: string[]
  verdict: 'agree' | 'revise'
}

export interface DebateRound {
  round: number
  planBefore: OctaPlan
  critique?: PlanCritique
  planAfter?: OctaPlan
  replies?: PlanReply[]
}

export interface PlannerRoundEvent {
  type: 'planner:round'
  planId: string
  round: number
  phase: PlannerPhase
  plan?: OctaPlan
  critique?: PlanCritique
  replies?: PlanReply[]
}

export interface PlannerQuestionsEvent {
  type: 'planner:questions'
  planId: string
  questions: PlanQuestion[]
}

export type PlannerEvent = PlannerRoundEvent | PlannerQuestionsEvent

export interface PlannerRunnerRequest {
  runner: PlannerRunnerName
  phase: PlannerPhase
  round: number
  planId: string
  workspace: string
  schemaPath: string
  prompt: string
  systemPrompt: string
}

export interface PlannerRunnerResponse {
  /** A fake runner may return an object; the CLI adapter returns text here. */
  output: unknown
  raw?: string
  jobId?: string
  folder?: string
}

export type PlannerRunner =
  | ((request: PlannerRunnerRequest) => Promise<PlannerRunnerResponse | unknown> | PlannerRunnerResponse | unknown)
  | {
      run(request: PlannerRunnerRequest): Promise<PlannerRunnerResponse | unknown> | PlannerRunnerResponse | unknown
    }

export type ConversationTurn = ChatMessage | {
  role?: string
  speaker?: string
  content?: string
  text?: string
} | string

export type Attachment = string | {
  path: string
  name?: string
  type?: string
}

export type BrainSource = string | CompanyBrain | {
  loadBrain(options?: BrainLoadOptions): Promise<string>
} | (() => Promise<string> | string)

export interface CompileBriefOptions {
  outputPath?: string
  homePath?: string
  planId?: string
  brainOptions?: BrainLoadOptions
  language?: PlanLanguage
}

export interface PlannerOptions {
  runner?: PlannerRunner
  jobs?: JobsRepository
  jobRunner?: JobRunner
  jobRunnerOptions?: JobRunnerOptions
  homePath?: string
  skillsLibraryPath?: string
  conversationId?: string | null
  planId?: string
  language?: PlanLanguage
  /** Selects the planner contract used by a caller. The build pipeline uses
   * the spec profile while preserving the normal planner behaviour. */
  profile?: 'default' | 'spec'
  client?: string
  sourceLedger?: LedgerInput
  maxDebateRounds?: number
  maxQuestionRounds?: number
  timeBudgetMs?: number
  onEvent?: (event: PlannerEvent) => void
}

export type PlanInput = string | { path: string; content?: string }

export type PlanAnswer = string | Record<string, string> | Array<{
  id?: string
  questionId?: string
  answer: string
}>

export interface PlannerResult {
  status: 'ok' | 'needs_input' | 'needs_approval' | 'approved'
  planId: string
  plan: OctaPlan
  questions: PlanQuestion[]
  debate: DebateRound[]
  debateMarkdown: string
  briefPath: string
  planPath: string
  debatePath: string
  workspace: string
  round: number
  questionRound: number
}

export interface PlannerPlanRequest {
  brief?: string
  conversation?: ConversationTurn[]
  attachments?: Attachment[]
  conversationId?: string | null
  planId?: string
  language?: PlanLanguage
  profile?: 'default' | 'spec'
  client?: string
  maxDebateRounds?: number
  maxQuestionRounds?: number
}

export interface PlannerAnswerRequest {
  planId: string
  answers: PlanAnswer
}

export interface PlanValidationResult {
  valid: boolean
  errors: string[]
}

export class PlannerValidationError extends Error {
  constructor(
    message: string,
    public readonly errors: string[],
    public readonly attempts: number
  ) {
    super(message)
    this.name = 'PlannerValidationError'
  }
}

export const PLAN_SCHEMA = planSchema
export const CRITIQUE_SCHEMA = critiqueSchema

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const PROMPTS_DIRECTORY = join(MODULE_DIRECTORY, 'prompts')

const FALLBACK_PROMPTS: Record<string, string> = {
  'planner.md': `You are Fable, Octa Assistant's planner. Mirror the language of the last user turn: Arabic Egyptian (ar-EG), English, or the same Arabic/English mix. You must ask when a decision is missing; never invent facts. Return only JSON matching plan.schema.json. A non-empty blocking questions[] means the plan must not execute.`,
  'critic.md': `You are Astra, Octa Assistant's read-only planning critic. Mirror the language of the last user turn. Check the brief, company brain, plan, skills, dependencies, gates, and acceptance criteria. Raise every missing decision as missing_questions[]. Never invent facts. Return only JSON matching critique.schema.json.`,
  'reply.md': `You are Fable replying to Astra. Mirror the language of the last user turn. Address every issue explicitly in replies[] with decision accepted or rejected and a reason. Update the plan rather than silently ignoring criticism. If information is missing, ask a blocking question. Return only the revised plan JSON.`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function readPrompt(name: string): string {
  const candidates = [
    join(PROMPTS_DIRECTORY, name),
    join(process.cwd(), 'electron', 'core', 'octa', 'prompts', name)
  ]
  for (const path of candidates) {
    if (!existsSync(path)) continue
    try {
      const content = readFileSync(path, 'utf8').trim()
      if (content) return content
    } catch {
      // The bundled fallback keeps packaged builds usable if prompt assets are absent.
    }
  }
  return FALLBACK_PROMPTS[name] ?? ''
}

function normalizeLanguage(value: string | undefined): PlanLanguage {
  if (value === 'ar-EG' || value === 'ar' || value === 'arabic') return 'ar-EG'
  if (value === 'en' || value === 'english') return 'en'
  return 'mixed'
}

function detectLanguage(turns: ConversationTurn[]): PlanLanguage {
  const lastUser = [...turns].reverse().find((turn) => {
    if (typeof turn === 'string') return true
    const role = turn.role?.toLowerCase()
    return role === 'user' || role === 'human' || !role
  })
  const text = turnText(lastUser)
  if (!text) return 'mixed'
  const arabic = (text.match(/[\u0600-\u06ff]/g) ?? []).length
  const latin = (text.match(/[A-Za-z]/g) ?? []).length
  if (arabic > 0 && latin === 0) return 'ar-EG'
  if (latin > 0 && arabic === 0) return 'en'
  return 'mixed'
}

function turnText(turn: ConversationTurn | undefined): string {
  if (typeof turn === 'string') return turn
  if (!turn) return ''
  return turn.content ?? ('text' in turn ? turn.text ?? '' : '')
}

function turnRole(turn: ConversationTurn): string {
  if (typeof turn === 'string') return 'user'
  return turn.role ?? turn.speaker ?? 'user'
}

function attachmentPath(attachment: Attachment): string {
  return typeof attachment === 'string' ? attachment : attachment.path
}

async function resolveBrainSource(source: BrainSource | undefined, options: CompileBriefOptions): Promise<string> {
  if (typeof source === 'string') return source.trim()
  if (typeof source === 'function') return String(await source()).trim()
  if (source && typeof source.loadBrain === 'function') {
    return (await source.loadBrain(options.brainOptions ?? {})).trim()
  }
  // The main process normally passes CompanyBrain. This fallback keeps the
  // standalone API aligned with spec 005 when a configured brain exists.
  if (source === undefined) {
    try {
      return (await loadCompanyBrain()).trim()
    } catch {
      return ''
    }
  }
  return ''
}

function renderBrief(
  conversation: ConversationTurn[],
  attachments: Attachment[],
  brainText: string,
  language: PlanLanguage
): string {
  const recent = conversation.slice(-40)
  const conversationText = recent.length > 0
    ? recent.map((turn, index) => {
        const role = turnRole(turn)
        return `### Turn ${index + 1} · ${role}\n${turnText(turn).trim()}`
      }).join('\n\n')
    : '_No conversation turns were provided._'
  const attachmentText = attachments.length > 0
    ? attachments
        .map((attachment) => `- ${attachmentPath(attachment)}`)
        .filter((line) => line.trim() !== '- ')
        .join('\n')
    : '_No attachments._'
  const brainSection = brainText.trim()
    ? `\n## Company brain / عقل الشركة (read-only)\n\n${brainText.trim()}\n`
    : '\n## Company brain / عقل الشركة (read-only)\n\n_No brain context was available._\n'
  return `# Octa planning brief\n\n## Language / اللغة\n\n${language}\n\n## Conversation / المحادثة (last ${recent.length} turns)\n\n${conversationText}\n\n## Attachments / المرفقات\n\n${attachmentText}\n${brainSection}`
}

/**
 * Compile a conversation into a persisted brief and return its absolute path.
 * The returned path can be passed directly to plan(); the file is always UTF-8.
 */
export async function compileBrief(
  conversation: readonly ConversationTurn[],
  attachments: readonly Attachment[],
  brain: BrainSource | undefined,
  options: CompileBriefOptions = {}
): Promise<string> {
  const turns = [...conversation]
  const language = options.language ?? detectLanguage(turns)
  const brainText = await resolveBrainSource(brain, options)
  const planId = options.planId ?? `brief-${randomUUID()}`
  const outputPath = resolve(
    options.outputPath ?? join(options.homePath ?? DEFAULT_PLANNER_HOME, 'jobs', planId, 'brief.md')
  )
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, renderBrief(turns, [...attachments], brainText, language), 'utf8')
  return outputPath
}

export async function compileBriefContent(
  conversation: readonly ConversationTurn[],
  attachments: readonly Attachment[],
  brain: BrainSource | undefined,
  options: CompileBriefOptions = {}
): Promise<{ path: string; content: string; language: PlanLanguage }> {
  const path = await compileBrief(conversation, attachments, brain, options)
  const content = readFileSync(path, 'utf8')
  return { path, content, language: options.language ?? detectLanguage([...conversation]) }
}

function isExistingFile(value: string): boolean {
  if (!value.trim() || value.includes('\n') || value.includes('\r')) return false
  try {
    return existsSync(value) && readFileSync(value, 'utf8') !== undefined
  } catch {
    return false
  }
}

function safeId(value: string): string {
  return /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : randomUUID()
}

function readPlanInput(input: PlanInput): { brief: string; path?: string } {
  if (typeof input !== 'string') {
    if (input.content !== undefined) return { brief: input.content, path: input.path }
    return { brief: readFileSync(input.path, 'utf8'), path: input.path }
  }
  if (isExistingFile(input)) return { brief: readFileSync(input, 'utf8'), path: resolve(input) }
  return { brief: input }
}

function arrayOfStrings(value: unknown, path: string, required = true): string[] {
  if (!Array.isArray(value)) return required ? [`${path} must be an array.`] : []
  return value.flatMap((item, index) => nonEmptyString(item) ? [] : [`${path}[${index}] must be a non-empty string.`])
}

function validateQuestion(value: unknown, path: string): string[] {
  if (!isRecord(value)) return [`${path} must be an object.`]
  const errors: string[] = []
  const allowed = new Set(['id', 'text', 'why', 'options', 'blocking'])
  for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`${path}.${key} is not allowed.`)
  for (const key of ['id', 'text', 'why']) if (!nonEmptyString(value[key])) errors.push(`${path}.${key} must be a non-empty string.`)
  errors.push(...arrayOfStrings(value.options, `${path}.options`))
  if (typeof value.blocking !== 'boolean') errors.push(`${path}.blocking must be a boolean.`)
  return errors
}

function validateReply(value: unknown, path: string): string[] {
  if (!isRecord(value)) return [`${path} must be an object.`]
  const allowed = new Set(['issue', 'decision', 'accepted', 'reason'])
  const errors = Object.keys(value)
    .filter((key) => !allowed.has(key))
    .map((key) => `${path}.${key} is not allowed.`)
  if (!nonEmptyString(value.issue)) errors.push(`${path}.issue must be a non-empty string.`)
  if (!nonEmptyString(value.reason)) errors.push(`${path}.reason must be a non-empty string.`)
  const decision = value.decision
  const validDecision = decision === 'accepted' || decision === 'rejected'
  const validAccepted = typeof value.accepted === 'boolean'
  if (!validDecision && !validAccepted) errors.push(`${path} needs decision accepted/rejected or accepted boolean.`)
  return errors
}

function validateStep(value: unknown, path: string): string[] {
  if (!isRecord(value)) return [`${path} must be an object.`]
  const allowed = new Set(['id', 'runner', 'skill', 'prompt', 'input', 'needs', 'gate', 'autonomy', 'acceptance', 'tier'])
  const errors = Object.keys(value)
    .filter((key) => !allowed.has(key))
    .map((key) => `${path}.${key} is not allowed.`)
  if (!nonEmptyString(value.id)) errors.push(`${path}.id must be a non-empty string.`)
  const runners = ['codex-scout', 'claude-skill', 'octa-code', 'gemini-inline', 'codex-exec']
  if (typeof value.runner !== 'string' || !runners.includes(value.runner)) errors.push(`${path}.runner is invalid.`)
  if (value.skill !== undefined && !nonEmptyString(value.skill)) errors.push(`${path}.skill must be a non-empty string when provided.`)
  if (value.prompt !== undefined && !nonEmptyString(value.prompt)) errors.push(`${path}.prompt must be a non-empty string when provided.`)
  if (value.input !== undefined && !isRecord(value.input)) errors.push(`${path}.input must be an object.`)
  errors.push(...arrayOfStrings(value.needs, `${path}.needs`))
  if (!['none', 'review', 'approve'].includes(String(value.gate))) errors.push(`${path}.gate is invalid.`)
  if (!['led', 'assisted', 'auto'].includes(String(value.autonomy))) errors.push(`${path}.autonomy is invalid.`)
  errors.push(...arrayOfStrings(value.acceptance, `${path}.acceptance`))
  if (value.tier !== undefined && !isModelTier(value.tier)) errors.push(`${path}.tier must be one of ${MODEL_TIERS.join(', ')}.`)
  if (value.skill === undefined && value.prompt === undefined) errors.push(`${path} needs skill or prompt.`)
  return errors
}

/** Validate the plan JSON shape before checking the live skill registry. */
export function validatePlan(value: unknown): PlanValidationResult {
  if (!isRecord(value)) return { valid: false, errors: ['Plan must be a JSON object.'] }
  const allowed = new Set([
    'plan_id', 'language', 'summary', 'questions', 'assumptions', 'workflow',
    'steps', 'deliverables', 'estimated_minutes', 'replies'
  ])
  const errors = Object.keys(value)
    .filter((key) => !allowed.has(key))
    .map((key) => `${key} is not allowed in a plan.`)
  if (!nonEmptyString(value.plan_id)) errors.push('plan_id must be a non-empty string.')
  if (!['ar-EG', 'en', 'mixed'].includes(String(value.language))) errors.push('language must be ar-EG, en, or mixed.')
  if (!nonEmptyString(value.summary)) errors.push('summary must be a non-empty string.')
  errors.push(...arrayOfStrings(value.assumptions, 'assumptions'))
  errors.push(...arrayOfStrings(value.deliverables, 'deliverables'))
  const workflows = ['review-website', 'build-website', 'market-project', 'think-project', 'invoice', 'research', 'custom']
  if (!workflows.includes(String(value.workflow))) errors.push('workflow is invalid.')
  if (!Array.isArray(value.questions)) errors.push('questions must be an array.')
  else value.questions.forEach((question, index) => errors.push(...validateQuestion(question, `questions[${index}]`)))
  if (!Array.isArray(value.steps)) errors.push('steps must be an array.')
  else value.steps.forEach((step, index) => errors.push(...validateStep(step, `steps[${index}]`)))
  if (!finiteNumber(value.estimated_minutes) || value.estimated_minutes < 0) errors.push('estimated_minutes must be a non-negative number.')
  if (value.replies !== undefined) {
    if (!Array.isArray(value.replies)) errors.push('replies must be an array.')
    else value.replies.forEach((reply, index) => errors.push(...validateReply(reply, `replies[${index}]`)))
  }
  return { valid: errors.length === 0, errors }
}

function critiqueItemText(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined
}

/** Validate Astra's critique schema. */
export function validateCritique(value: unknown): PlanValidationResult {
  if (!isRecord(value)) return { valid: false, errors: ['Critique must be a JSON object.'] }
  const allowed = new Set(['issues', 'missing_questions', 'risks', 'verdict'])
  const errors = Object.keys(value)
    .filter((key) => !allowed.has(key))
    .map((key) => `${key} is not allowed in a critique.`)
  for (const key of ['issues', 'missing_questions', 'risks']) {
    if (!Array.isArray(value[key])) {
      errors.push(`${key} must be an array.`)
      continue
    }
    value[key].forEach((item, index) => {
      if (!critiqueItemText(item)) errors.push(`${key}[${index}] must be a non-empty string.`)
    })
  }
  if (value.verdict !== 'agree' && value.verdict !== 'revise') errors.push('verdict must be agree or revise.')
  return { valid: errors.length === 0, errors }
}

export const validatePlanSchema = validatePlan
export const validateCritiqueSchema = validateCritique

function normalizeReply(value: unknown): PlanReply | undefined {
  if (!isRecord(value)) return undefined
  const issue = stringValue(value.issue)?.trim()
  const reason = stringValue(value.reason)?.trim()
  if (!issue || !reason) return undefined
  const decision = value.decision === 'accepted' || value.accepted === true ? 'accepted' : 'rejected'
  return { issue, reason, decision }
}

function normalizePlanEnvelope(value: unknown): { plan: OctaPlan; replies: PlanReply[] } {
  if (!isRecord(value)) throw new Error('Fable output is not an object.')
  const candidate = isRecord(value.plan) ? value.plan : value
  const plan = candidate as unknown as OctaPlan
  const replies = Array.isArray(value.replies)
    ? value.replies.map(normalizeReply).filter((reply): reply is PlanReply => Boolean(reply))
    : Array.isArray(candidate.replies)
      ? candidate.replies.map(normalizeReply).filter((reply): reply is PlanReply => Boolean(reply))
      : []
  return { plan, replies }
}

function normalizeCritique(value: unknown): PlanCritique {
  if (!isRecord(value)) throw new Error('Astra output is not an object.')
  const candidate = isRecord(value.critique) ? value.critique : value
  return {
    issues: Array.isArray(candidate.issues) ? candidate.issues.map(critiqueItemText).filter((item): item is string => Boolean(item)) : [],
    missing_questions: Array.isArray(candidate.missing_questions)
      ? candidate.missing_questions.map(critiqueItemText).filter((item): item is string => Boolean(item))
      : [],
    risks: Array.isArray(candidate.risks) ? candidate.risks.map(critiqueItemText).filter((item): item is string => Boolean(item)) : [],
    verdict: candidate.verdict === 'agree' ? 'agree' : 'revise'
  }
}

function jsonCandidate(value: unknown): unknown {
  if (isRecord(value)) {
    if ('output' in value) return jsonCandidate(value.output)
    if ('value' in value) return jsonCandidate(value.value)
    if ('raw' in value && typeof value.raw === 'string') return jsonCandidate(value.raw)
    if ('text' in value && Object.keys(value).every((key) => key === 'text' || key === 'raw')) return jsonCandidate(value.text)
    if ('notes' in value && typeof value.notes === 'string' && Object.keys(value).length <= 2) return jsonCandidate(value.notes)
    return value
  }
  if (typeof value !== 'string') return value
  const text = value.trim()
  if (!text) throw new Error('Runner returned empty output.')
  const candidates = [text]
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text)
  if (fenced) candidates.unshift(fenced[1])
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown
    } catch {
      // Try the next representation, then the JSON object embedded in CLI prose.
    }
  }
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(text.slice(first, last + 1)) as unknown
    } catch {
      // Preserve the useful validation error below.
    }
  }
  throw new Error('Invalid JSON returned by planner runner.')
}

function validationMessage(errors: string[]): string {
  return errors.length > 0 ? errors.join(' ') : 'Output did not match the required schema.'
}

function normalizeQuestion(value: unknown, source: 'fable' | 'astra', index: number): PlanQuestion | undefined {
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return undefined
    return {
      id: `${source}-${index + 1}`,
      text,
      why: source === 'astra' ? 'Astra identified a missing decision.' : 'Fable identified a missing decision.',
      options: [],
      blocking: true
    }
  }
  if (!isRecord(value) || !nonEmptyString(value.text)) return undefined
  return {
    id: nonEmptyString(value.id) ? value.id : `${source}-${index + 1}`,
    text: value.text.trim(),
    why: nonEmptyString(value.why) ? value.why.trim() : 'This decision is needed before execution.',
    options: Array.isArray(value.options) ? value.options.filter((item): item is string => typeof item === 'string') : [],
    blocking: value.blocking === true
  }
}

function normalizeQuestions(values: unknown[], source: 'fable' | 'astra'): PlanQuestion[] {
  return values
    .map((value, index) => normalizeQuestion(value, source, index))
    .filter((question): question is PlanQuestion => Boolean(question))
}

function questionKey(question: PlanQuestion): string {
  return question.text.trim().toLocaleLowerCase().replace(/\s+/g, ' ')
}

function mergeQuestions(...groups: PlanQuestion[][]): PlanQuestion[] {
  const merged: PlanQuestion[] = []
  const keys = new Set<string>()
  for (const group of groups) {
    for (const question of group) {
      const key = questionKey(question)
      if (!key || keys.has(key)) continue
      keys.add(key)
      merged.push(question)
    }
  }
  return merged
}

function extractAnsweredIds(brief: string): Set<string> {
  const ids = new Set<string>()
  let inAnswers = false
  for (const line of brief.split(/\r?\n/)) {
    if (/^## User answers\b/u.test(line)) {
      inAnswers = true
      continue
    }
    if (inAnswers && /^##\s+/u.test(line)) {
      inAnswers = false
      continue
    }
    if (!inAnswers) continue
    const match = /^\s*-\s*([^:\n]+):\s*/u.exec(line)
    if (match?.[1]?.trim()) ids.add(match[1].trim())
  }
  return ids
}

function removeAnsweredQuestions(questions: PlanQuestion[], answeredIds: ReadonlySet<string>): PlanQuestion[] {
  if (answeredIds.size === 0) return questions
  return questions.filter((question) => !answeredIds.has(question.id))
}

function mergeReplies(...groups: PlanReply[][]): PlanReply[] {
  const merged: PlanReply[] = []
  const keys = new Set<string>()
  for (const group of groups) {
    for (const reply of group) {
      const key = `${reply.issue.toLocaleLowerCase().replace(/\s+/g, ' ')}|${reply.decision}`
      if (keys.has(key)) continue
      keys.add(key)
      merged.push(reply)
    }
  }
  return merged
}

function freeFormPrompt(step: PlanStep): boolean {
  if (step.runner !== 'codex-exec') return false
  if (nonEmptyString(step.prompt)) return true
  return isRecord(step.input) && nonEmptyString(step.input.prompt)
}

function validateSkillRegistry(plan: OctaPlan, skillsLibraryPath?: string): string[] {
  const errors: string[] = []
  plan.steps.forEach((step, index) => {
    if (step.skill) {
      try {
        // resolveSkill is the registry entry point produced by spec 002/001.
        // It verifies MANIFEST.json and the actual SKILL.md folder.
        resolveSkill(step.skill, { skillsLibraryPath })
      } catch (error) {
        if (!freeFormPrompt(step)) {
          errors.push(`steps[${index}].skill "${step.skill}" is not available in the skill registry: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    } else if (!freeFormPrompt(step)) {
      errors.push(`steps[${index}] needs a registered skill, or runner codex-exec with a free-form prompt.`)
    }
  })
  return errors
}

export function validatePlanForExecution(
  plan: OctaPlan,
  options: Pick<PlannerOptions, 'skillsLibraryPath' | 'sourceLedger'>
): PlanValidationResult {
  const shape = validatePlan(plan)
  const errors = [...shape.errors]
  if (shape.valid) {
    errors.push(...validateSkillRegistry(plan, options.skillsLibraryPath))
    const sourceValidation = rejectUnsourced(plan.summary, options.sourceLedger ?? [])
    if (!sourceValidation.ok) errors.push(...sourceValidation.failures.map((failure) => `summary source validation failed: ${failure}`))
  }
  return { valid: errors.length === 0, errors }
}

async function invokeRunner(runner: PlannerRunner, request: PlannerRunnerRequest): Promise<unknown> {
  const response = typeof runner === 'function' ? await runner(request) : await runner.run(request)
  return jsonCandidate(response)
}

function questionPrompt(language: PlanLanguage): string {
  return language === 'ar-EG'
    ? 'اسأل أي سؤال blocking بالعربية المصرية وبوضوح، ولا تخمّن.'
    : language === 'en'
      ? 'Ask every blocking question clearly and do not guess.'
      : 'Mirror the Arabic/English mix of the last user turn, ask blocking questions clearly, and do not guess.'
}

function draftPrompt(brief: string, language: PlanLanguage, schemaPath: string, profile: PlannerOptions['profile'] = 'default'): string {
  const profileInstruction = profile === 'spec'
    ? 'This is the native build spec profile. Make the codex-exec steps concrete: include the files to touch, dependencies, acceptance criteria, and verification commands in each step input. Do not invoke Octa Code or any Python backend.'
    : ''
  return `You are Fable drafting v0 for Octa. Language: ${language}. ${questionPrompt(language)} ${profileInstruction}\n\nRead this brief and the injected company brain. Produce only one JSON plan matching ${schemaPath} and the Plan schema from the runtime contract. Every execution step needs a registered skill; the only exception is runner codex-exec with a free-form prompt. Questions that affect scope, audience, budget, timing, authority, or an outward action must be blocking. Never put an unsupported number in summary.\n\n${brief}`
}

function critiquePrompt(brief: string, plan: OctaPlan, language: PlanLanguage, schemaPath: string): string {
  return `You are Astra reviewing an Octa plan in read-only mode. Language: ${language}. ${questionPrompt(language)}\n\nCheck the plan against the brief and company brain. Find missing decisions, unsupported claims or numbers, invalid skills, dependency mistakes, weak acceptance criteria, unsafe outward actions, and risks. Return only ${schemaPath} with issues[], missing_questions[], risks[], and verdict agree or revise.\n\n## Brief\n${brief}\n\n## Plan under review\n\n${JSON.stringify(plan, null, 2)}`
}

function replyPrompt(
  brief: string,
  plan: OctaPlan,
  critique: PlanCritique,
  language: PlanLanguage,
  schemaPath: string
): string {
  return `You are Fable replying to Astra. Language: ${language}. ${questionPrompt(language)}\n\nReturn only a revised plan JSON matching ${schemaPath}. Include replies[]; for every Astra issue state issue, decision (accepted or rejected), and reason. Incorporate valid fixes into the plan. If Astra found a decision that the brief does not answer, add a blocking question rather than inventing an assumption.\n\n## Brief\n${brief}\n\n## Previous plan\n\n${JSON.stringify(plan, null, 2)}\n\n## Astra critique\n\n${JSON.stringify(critique, null, 2)}`
}

function capPlan(plan: OctaPlan, critique: PlanCritique | undefined): OctaPlan {
  if (!critique || critique.verdict === 'agree') return plan
  const unresolved = [...critique.issues, ...critique.risks]
    .map((item) => `Debate cap: ${item}`)
  return {
    ...plan,
    assumptions: [...new Set([...plan.assumptions, ...unresolved])]
  }
}

function issueWinner(issue: string, replies: PlanReply[], critique: PlanCritique): { winner: string; why: string } {
  const match = replies.find((reply) => {
    const a = reply.issue.toLocaleLowerCase()
    const b = issue.toLocaleLowerCase()
    return a === b || a.includes(b) || b.includes(a)
  })
  if (match) {
    return match.decision === 'accepted'
      ? { winner: 'Astra', why: `Fable accepted the issue: ${match.reason}` }
      : { winner: 'Fable', why: `Fable rejected the issue: ${match.reason}` }
  }
  if (critique.verdict === 'agree') return { winner: 'Astra', why: 'Astra found no remaining revision required.' }
  return { winner: 'Unresolved', why: 'No reply was recorded before the four-round debate cap.' }
}

function renderDebate(rounds: DebateRound[], finalPlan: OctaPlan, status: PlannerResult['status']): string {
  const sections = ['# Octa planner debate', '', `Final status: ${status}`, '']
  for (const round of rounds) {
    sections.push(`## Round ${round.round}`, '', '### Fable plan before Astra', '', '```json', JSON.stringify(round.planBefore, null, 2), '```', '')
    if (round.critique) {
      sections.push('### Astra critique', '')
      for (const issue of round.critique.issues) sections.push(`- Issue: ${issue}`)
      for (const question of round.critique.missing_questions) sections.push(`- Missing question: ${question}`)
      for (const risk of round.critique.risks) sections.push(`- Risk: ${risk}`)
      sections.push(`- Verdict: ${round.critique.verdict}`, '', '### Issue decisions', '')
      const allIssues = [
        ...round.critique.issues,
        ...round.critique.risks,
        ...round.critique.missing_questions
      ]
      for (const issue of allIssues) {
        const outcome = issueWinner(issue, round.replies ?? [], round.critique)
        sections.push(`- ${issue}`, `  - Winner: ${outcome.winner}`, `  - Why: ${outcome.why}`)
      }
    }
    if (round.replies && round.replies.length > 0) {
      sections.push('', '### Fable replies', '')
      for (const reply of round.replies) sections.push(`- ${reply.decision}: ${reply.issue} — ${reply.reason}`)
    }
    if (round.planAfter) sections.push('', '### Fable plan after Astra', '', '```json', JSON.stringify(round.planAfter, null, 2), '```')
    sections.push('')
  }
  sections.push('## Final plan', '', '```json', JSON.stringify(finalPlan, null, 2), '```', '')
  return `${sections.join('\n')}\n`
}

function resultStatus(status: PlanStatus): PlannerResult['status'] {
  if (status === 'needs_input') return 'needs_input'
  if (status === 'needs_approval') return 'needs_approval'
  if (status === 'approved') return 'approved'
  return 'ok'
}

interface StoredContext {
  workspace: string
  briefPath: string
  conversationId?: string | null
  language?: PlanLanguage
  skillsLibraryPath?: string
  sourceLedger?: LedgerInput
  client?: string
  maxDebateRounds: number
  maxQuestionRounds: number
}

class JobRunnerPlannerAdapter {
  constructor(
    private readonly jobRunner: JobRunner,
    private readonly homePath: string
  ) {}

  async run(request: PlannerRunnerRequest): Promise<PlannerRunnerResponse> {
    const jobId = safeId(`${request.planId}-planner-${request.phase}-${request.round}-${randomUUID().slice(0, 8)}`)
    const handle = this.jobRunner.startJob({
      id: jobId,
      runner: request.runner,
      brief: request.prompt,
      plannerPrompt: request.systemPrompt,
      planId: request.planId,
      workflow: 'custom',
      stepId: `planner-${request.phase}-${request.round}`,
      autonomy: 'led',
      gate: 'none',
      homePath: this.homePath,
      maxRetries: 0
    })
    let text = ''
    const unsubscribe = handle.onEvent((event) => {
      if (event.type === 'text') text += event.text
    })
    const result = await handle.promise
    unsubscribe()
    return {
      output: text.trim() || result.notes,
      raw: text,
      jobId: handle.id,
      folder: handle.folder
    }
  }
}

export class Planner {
  private readonly jobs: JobsRepository
  private readonly ownsJobs: boolean
  private readonly homePath: string
  private readonly runner: PlannerRunner
  private readonly onEvent?: (event: PlannerEvent) => void
  private readonly defaultOptions: PlannerOptions
  private readonly contexts = new Map<string, StoredContext>()

  constructor(options: PlannerOptions = {}) {
    this.homePath = resolve(options.homePath ?? DEFAULT_PLANNER_HOME)
    if (options.jobs) {
      this.jobs = options.jobs
      this.ownsJobs = false
    } else {
      this.jobs = new JobsRepository(join(this.homePath, 'octa.db'))
      this.ownsJobs = true
    }
    this.onEvent = options.onEvent
    this.defaultOptions = options
    if (options.runner) {
      this.runner = options.runner
    } else {
      const jobRunner = options.jobRunner ?? new JobRunner({
        ...(options.jobRunnerOptions ?? {}),
        jobs: this.jobs,
        homePath: this.homePath,
        skillsLibraryPath: options.skillsLibraryPath
      })
      this.runner = new JobRunnerPlannerAdapter(jobRunner, this.homePath)
    }
  }

  close(): void {
    if (this.ownsJobs) this.jobs.close()
  }

  private emit(event: PlannerEvent): void {
    this.onEvent?.(event)
  }

  private async callStructured<T>(
    request: PlannerRunnerRequest,
    validate: (value: unknown) => PlanValidationResult,
    normalize: (value: unknown) => T
  ): Promise<T> {
    let prompt = request.prompt
    let lastErrors: string[] = []
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const output = await invokeRunner(this.runner, { ...request, prompt })
        const validation = validate(output)
        if (!validation.valid) throw new Error(validationMessage(validation.errors))
        return normalize(output)
      } catch (error) {
        lastErrors = [error instanceof Error ? error.message : String(error)]
        if (attempt === 0) {
          prompt = `${request.prompt}\n\n## Validation error from Octa\n${lastErrors.join('\n')}\nReturn corrected JSON only; preserve the requested schema and do not omit required fields.`
        }
      }
    }
    throw new PlannerValidationError(
      `${request.runner} returned invalid JSON or schema after one retry: ${lastErrors.join(' ')}`,
      lastErrors,
      2
    )
  }

  private async callPlan(
    phase: 'draft' | 'reply',
    round: number,
    planId: string,
    workspace: string,
    brief: string,
    language: PlanLanguage,
    options: PlannerOptions,
    previousPlan?: OctaPlan,
    critique?: PlanCritique
  ): Promise<{ plan: OctaPlan; replies: PlanReply[] }> {
    const schemaPath = join(workspace, 'plan.schema.json')
    const prompt = phase === 'draft'
      ? draftPrompt(brief, language, schemaPath, options.profile)
      : replyPrompt(brief, previousPlan!, critique!, language, schemaPath)
    const systemPrompt = phase === 'draft'
      ? readPrompt('planner.md')
      : `${readPrompt('planner.md')}\n\n${readPrompt('reply.md')}`
    const envelope = await this.callStructured(
      {
        runner: 'claude-plan',
        phase,
        round,
        planId,
        workspace,
        schemaPath,
        prompt,
        systemPrompt
      },
      (value) => {
        try {
          const envelope = normalizePlanEnvelope(value)
          return validatePlanForExecution(envelope.plan, options)
        } catch (error) {
          return { valid: false, errors: [error instanceof Error ? error.message : String(error)] }
        }
      },
      (value) => normalizePlanEnvelope(value)
    )
    const validation = validatePlanForExecution(envelope.plan, options)
    if (!validation.valid) throw new PlannerValidationError(validationMessage(validation.errors), validation.errors, 1)
    return envelope
  }

  private async callCritique(
    round: number,
    planId: string,
    workspace: string,
    brief: string,
    plan: OctaPlan,
    language: PlanLanguage
  ): Promise<PlanCritique> {
    const schemaPath = join(workspace, 'critique.schema.json')
    return this.callStructured(
      {
        runner: 'codex-critic',
        phase: 'critique',
        round,
        planId,
        workspace,
        schemaPath,
        prompt: critiquePrompt(brief, plan, language, schemaPath),
        systemPrompt: readPrompt('critic.md')
      },
      validateCritique,
      normalizeCritique
    )
  }

  private ensureWorkspace(
    input: PlanInput,
    options: PlannerOptions
  ): { planId: string; workspace: string; briefPath: string; brief: string } {
    const parsed = readPlanInput(input)
    if (!parsed.brief.trim()) throw new Error('A planner brief is required.')
    const provisional = safeId(options.planId ?? (parsed.path ? dirname(parsed.path).split(/[\\/]/).pop() ?? '' : ''))
    const planId = provisional || randomUUID()
    const workspace = parsed.path ? resolve(dirname(parsed.path)) : join(this.homePath, 'jobs', planId)
    const briefPath = parsed.path ?? join(workspace, 'brief.md')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(join(workspace, 'inputs'), { recursive: true })
    mkdirSync(join(workspace, 'out'), { recursive: true })
    mkdirSync(join(workspace, 'evidence'), { recursive: true })
    writeFileSync(briefPath, parsed.brief, 'utf8')
    writeFileSync(join(workspace, 'plan.schema.json'), `${JSON.stringify(PLAN_SCHEMA, null, 2)}\n`, 'utf8')
    writeFileSync(join(workspace, 'critique.schema.json'), `${JSON.stringify(CRITIQUE_SCHEMA, null, 2)}\n`, 'utf8')
    return { planId, workspace, briefPath, brief: parsed.brief }
  }

  private persist(
    planId: string,
    brief: string,
    plan: OctaPlan,
    rounds: DebateRound[],
    debateMarkdown: string,
    status: PlanStatus,
    context: StoredContext,
    questionRound: number
  ): PlannerResult {
    const planPath = join(context.workspace, 'plan.json')
    const debatePath = join(context.workspace, 'debate.md')
    writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8')
    writeFileSync(debatePath, debateMarkdown, 'utf8')
    const existing = this.jobs.getPlan(planId)
    if (existing) {
      this.jobs.updatePlan(planId, {
        briefMd: brief,
        plan,
        round: rounds.filter((round) => round.critique).length,
        questionRound,
        status
      })
    } else {
      this.jobs.createPlan({
        id: planId,
        conversationId: context.conversationId ?? null,
        briefMd: brief,
        plan,
        round: rounds.filter((round) => round.critique).length,
        questionRound,
        status
      })
    }
    this.contexts.set(planId, context)
    return {
      status: resultStatus(status),
      planId,
      plan,
      questions: plan.questions,
      debate: rounds,
      debateMarkdown,
      briefPath: resolve(context.briefPath),
      planPath: resolve(planPath),
      debatePath: resolve(debatePath),
      workspace: resolve(context.workspace),
      round: rounds.filter((round) => round.critique).length,
      questionRound
    }
  }

  private async runPlan(
    brief: string,
    planId: string,
    workspace: string,
    briefPath: string,
    options: PlannerOptions,
    questionRound: number,
    answeredIds: ReadonlySet<string> = new Set<string>()
  ): Promise<PlannerResult> {
    const language = options.language ?? detectLanguage([{ role: 'user', content: brief }])
    const context: StoredContext = {
      workspace,
      briefPath,
      conversationId: options.conversationId ?? this.defaultOptions.conversationId ?? null,
      language,
      skillsLibraryPath: options.skillsLibraryPath,
      sourceLedger: options.sourceLedger,
      client: options.client,
      maxDebateRounds: Math.max(1, Math.min(MAX_DEBATE_ROUNDS, Math.trunc(options.maxDebateRounds ?? MAX_DEBATE_ROUNDS))),
      maxQuestionRounds: Math.max(0, Math.min(MAX_QUESTION_ROUNDS, Math.trunc(options.maxQuestionRounds ?? MAX_QUESTION_ROUNDS)))
    }
    const effectiveOptions = { ...this.defaultOptions, ...options }
    const initial = await this.callPlan('draft', 0, planId, workspace, brief, language, effectiveOptions)
    let currentPlan: OctaPlan = { ...initial.plan, plan_id: planId, replies: initial.replies.length > 0 ? initial.replies : initial.plan.replies }
    let mergedQuestions = removeAnsweredQuestions(normalizeQuestions(currentPlan.questions, 'fable'), answeredIds)
    currentPlan = { ...currentPlan, questions: mergedQuestions }
    const rounds: DebateRound[] = []
    const allReplies: PlanReply[] = [...initial.replies]
    this.emit({ type: 'planner:round', planId, round: 0, phase: 'draft', plan: currentPlan })

    let finalCritique: PlanCritique | undefined
    let capped = false
    for (let roundNumber = 1; roundNumber <= context.maxDebateRounds; roundNumber += 1) {
      const before = currentPlan
      const critique = await this.callCritique(roundNumber, planId, workspace, brief, before, language)
      finalCritique = critique
      const critiqueQuestions = normalizeQuestions(critique.missing_questions, 'astra')
      mergedQuestions = removeAnsweredQuestions(mergeQuestions(mergedQuestions, critiqueQuestions), answeredIds)
      const debateRound: DebateRound = { round: roundNumber, planBefore: before, critique }
      rounds.push(debateRound)
      this.emit({ type: 'planner:round', planId, round: roundNumber, phase: 'critique', plan: before, critique })
      if (critique.verdict === 'agree' || roundNumber >= context.maxDebateRounds) {
        capped = critique.verdict !== 'agree'
        break
      }
      const reply = await this.callPlan('reply', roundNumber, planId, workspace, brief, language, effectiveOptions, before, critique)
      const replyQuestions = normalizeQuestions(reply.plan.questions, 'fable')
      mergedQuestions = removeAnsweredQuestions(mergeQuestions(mergedQuestions, replyQuestions), answeredIds)
      currentPlan = {
        ...reply.plan,
        plan_id: planId,
        questions: mergedQuestions,
        replies: reply.replies.length > 0 ? reply.replies : reply.plan.replies
      }
      const replies = reply.replies.length > 0
        ? reply.replies
        : critique.issues.map((issue) => ({ issue, decision: 'accepted' as const, reason: 'Fable revised the plan in response to Astra.' }))
      allReplies.push(...replies)
      debateRound.replies = replies
      debateRound.planAfter = currentPlan
      this.emit({ type: 'planner:round', planId, round: roundNumber, phase: 'reply', plan: currentPlan, critique, replies })
    }

    currentPlan = capPlan({
      ...currentPlan,
      plan_id: planId,
      questions: mergedQuestions,
      replies: mergeReplies(allReplies, currentPlan.replies ?? [])
    }, capped ? finalCritique : undefined)
    const blockingQuestions = currentPlan.questions.filter((question) => question.blocking)
    let status: PlanStatus
    if (blockingQuestions.length > 0 && questionRound < context.maxQuestionRounds) {
      status = 'needs_input'
    } else if (blockingQuestions.length > 0) {
      currentPlan = {
        ...currentPlan,
        assumptions: [...new Set([
          ...currentPlan.assumptions,
          ...blockingQuestions.map((question) => `Assumption awaiting explicit approval: ${question.text}`)
        ])],
        questions: currentPlan.questions.map((question) => ({ ...question, blocking: false }))
      }
      status = 'needs_approval'
    } else {
      status = 'draft'
    }
    const debateMarkdown = renderDebate(rounds, currentPlan, resultStatus(status))
    const result = this.persist(planId, brief, currentPlan, rounds, debateMarkdown, status, context, questionRound)
    if (status === 'needs_input') this.emit({ type: 'planner:questions', planId, questions: blockingQuestions })
    return result
  }

  async plan(input: PlanInput, options: PlannerOptions = {}): Promise<PlannerResult> {
    const prepared = this.ensureWorkspace(input, options)
    const planId = options.planId ?? prepared.planId
    const existing = this.jobs.getPlan(planId)
    const questionRound = existing?.questionRound ?? 0
    return this.runPlan(prepared.brief, planId, prepared.workspace, prepared.briefPath, options, questionRound)
  }

  async answer(planId: string, answers: PlanAnswer, options: PlannerOptions = {}): Promise<PlannerResult> {
    const record = this.jobs.getPlan(planId)
    if (!record) throw new Error(`Plan "${planId}" was not found.`)
    if (record.status === 'approved') throw new Error('An approved plan cannot receive more answers.')
    const context = this.contexts.get(planId) ?? {
      workspace: join(this.homePath, 'jobs', safeId(planId)),
      briefPath: join(this.homePath, 'jobs', safeId(planId), 'brief.md'),
      conversationId: record.conversationId,
      language: options.language,
      skillsLibraryPath: options.skillsLibraryPath,
      sourceLedger: options.sourceLedger,
      client: options.client,
      maxDebateRounds: Math.max(1, Math.min(MAX_DEBATE_ROUNDS, Math.trunc(options.maxDebateRounds ?? MAX_DEBATE_ROUNDS))),
      maxQuestionRounds: Math.max(0, Math.min(MAX_QUESTION_ROUNDS, Math.trunc(options.maxQuestionRounds ?? MAX_QUESTION_ROUNDS)))
    }
    if (record.questionRound >= context.maxQuestionRounds) {
      throw new Error('The planner question limit has been reached; explicit approval is required.')
    }
    const answerLines = normalizeAnswers(answers)
    if (answerLines.length === 0) throw new Error('At least one answer is required.')
    const nextQuestionRound = record.questionRound + 1
    const answerBlock = `\n\n## User answers / إجابات المستخدم (question round ${nextQuestionRound})\n\n${answerLines.map((item) => `- ${item.id}: ${item.answer}`).join('\n')}\n`
    const brief = `${record.briefMd.trimEnd()}${answerBlock}`
    const answeredIds = extractAnsweredIds(brief)
    mkdirSync(context.workspace, { recursive: true })
    writeFileSync(context.briefPath, brief, 'utf8')
    const mergedOptions: PlannerOptions = {
      ...this.defaultOptions,
      ...options,
      planId,
      language: options.language ?? context.language,
      skillsLibraryPath: options.skillsLibraryPath ?? context.skillsLibraryPath,
      sourceLedger: options.sourceLedger ?? context.sourceLedger,
      maxDebateRounds: options.maxDebateRounds ?? context.maxDebateRounds,
      maxQuestionRounds: options.maxQuestionRounds ?? context.maxQuestionRounds
    }
    return this.runPlan(brief, planId, context.workspace, context.briefPath, mergedOptions, nextQuestionRound, answeredIds)
  }

  async approve(planId: string, _approvedBy = 'owner'): Promise<PlannerResult> {
    const record = this.jobs.getPlan(planId)
    if (!record) throw new Error(`Plan "${planId}" was not found.`)
    if (record.status === 'needs_input') throw new Error('Blocking planner questions must be answered before approval.')
    const updated = this.jobs.updatePlan(planId, { status: 'approved' })
    if (!updated) throw new Error(`Plan "${planId}" could not be approved.`)
    const context = this.contexts.get(planId) ?? {
      workspace: join(this.homePath, 'jobs', safeId(planId)),
      briefPath: join(this.homePath, 'jobs', safeId(planId), 'brief.md'),
      conversationId: record.conversationId,
      language: undefined,
      skillsLibraryPath: undefined,
      sourceLedger: undefined,
      client: undefined,
      maxDebateRounds: MAX_DEBATE_ROUNDS,
      maxQuestionRounds: MAX_QUESTION_ROUNDS
    }
    const plan = updated.plan as OctaPlan
    const planPath = join(context.workspace, 'plan.json')
    const debatePath = join(context.workspace, 'debate.md')
    const debateMarkdown = existsSync(debatePath) ? readFileSync(debatePath, 'utf8') : renderDebate([], plan, 'approved')
    return {
      status: 'approved',
      planId,
      plan,
      questions: plan.questions,
      debate: [],
      debateMarkdown,
      briefPath: resolve(context.briefPath),
      planPath: resolve(planPath),
      debatePath: resolve(debatePath),
      workspace: resolve(context.workspace),
      round: updated.round,
      questionRound: updated.questionRound
    }
  }

  get(planId: string): PlannerResult | null {
    const record = this.jobs.getPlan(planId)
    if (!record) return null
    const context = this.contexts.get(planId) ?? {
      workspace: join(this.homePath, 'jobs', safeId(planId)),
      briefPath: join(this.homePath, 'jobs', safeId(planId), 'brief.md'),
      conversationId: record.conversationId,
      language: undefined,
      skillsLibraryPath: undefined,
      sourceLedger: undefined,
      client: undefined,
      maxDebateRounds: MAX_DEBATE_ROUNDS,
      maxQuestionRounds: MAX_QUESTION_ROUNDS
    }
    const plan = record.plan as OctaPlan
    const debatePath = join(context.workspace, 'debate.md')
    const planPath = join(context.workspace, 'plan.json')
    return {
      status: resultStatus(record.status),
      planId,
      plan,
      questions: Array.isArray(plan.questions) ? plan.questions : [],
      debate: [],
      debateMarkdown: existsSync(debatePath) ? readFileSync(debatePath, 'utf8') : '',
      briefPath: resolve(context.briefPath),
      planPath: resolve(planPath),
      debatePath: resolve(debatePath),
      workspace: resolve(context.workspace),
      round: record.round,
      questionRound: record.questionRound
    }
  }
}

function normalizeAnswers(answers: PlanAnswer): Array<{ id: string; answer: string }> {
  if (typeof answers === 'string') return answers.trim() ? [{ id: 'answer', answer: answers.trim() }] : []
  if (Array.isArray(answers)) {
    return answers.flatMap((item, index) => {
      const answer = item.answer.trim()
      return answer ? [{ id: item.id?.trim() || item.questionId?.trim() || `answer-${index + 1}`, answer }] : []
    })
  }
  return Object.entries(answers).flatMap(([id, answer]) => answer.trim() ? [{ id, answer: answer.trim() }] : [])
}

function needsTemporaryPlanner(options: PlannerOptions): boolean {
  return options.runner !== undefined ||
    options.jobs !== undefined ||
    options.jobRunner !== undefined ||
    options.jobRunnerOptions !== undefined ||
    options.homePath !== undefined ||
    options.skillsLibraryPath !== undefined ||
    options.onEvent !== undefined
}

let defaultPlanner: Planner | undefined

export function configurePlanner(options: PlannerOptions = {}): Planner {
  defaultPlanner?.close()
  defaultPlanner = new Planner(options)
  return defaultPlanner
}

export function getPlanner(): Planner {
  if (!defaultPlanner) defaultPlanner = new Planner()
  return defaultPlanner
}

export function closePlanner(): void {
  defaultPlanner?.close()
  defaultPlanner = undefined
}

export async function plan(input: PlanInput, options: PlannerOptions = {}): Promise<PlannerResult> {
  if (needsTemporaryPlanner(options)) {
    const temporary = new Planner(options)
    try {
      return await temporary.plan(input, options)
    } finally {
      temporary.close()
    }
  }
  return getPlanner().plan(input, options)
}

export async function answer(planId: string, answers: PlanAnswer, options: PlannerOptions = {}): Promise<PlannerResult> {
  if (needsTemporaryPlanner(options)) {
    const temporary = new Planner(options)
    try {
      return await temporary.answer(planId, answers, options)
    } finally {
      temporary.close()
    }
  }
  return getPlanner().answer(planId, answers, options)
}

export async function approve(planId: string, approvedBy = 'owner'): Promise<PlannerResult> {
  return getPlanner().approve(planId, approvedBy)
}

export function get(planId: string): PlannerResult | null {
  return getPlanner().get(planId)
}

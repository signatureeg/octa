import { EventEmitter } from 'node:events'
import { envPath } from '../octa/paths'
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  type Dirent
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { delimiter, basename, extname, join, relative, resolve } from 'node:path'
import type { ChatMessage, ChatProvider, ToolDefinition } from '../../cloud/chat'
import { GeminiChatProvider } from '../../cloud/gemini-chat'
import { requireAiAuth } from '../../cloud/vertex'
import { DEFAULT_SETTINGS, type AppSettings, type JobAutonomy, type JobEvent, type JobGate, type JobResult, type JobStartRequest, type JobStatus, type ModelTier, type SubAgentSpec } from '../../types'
import { classifyCliFailure, fallbackCanHelp, resolveTier, tierForRunner, type CliFailure, type TierModel } from '../octa/models'
import { JobsRepository } from '../../db/jobs'
import { parseSkillFrontmatter, type SkillFrontmatter } from '../skills/frontmatter'
import { runnerForSkill } from '../skills/policy'
import { DEFAULT_PHASE_MODELS } from '../octa/models'
import { COMPANY_FILES, knowledgePathFor } from '../octa/companies'
import {
  REVIEW_SCHEMA,
  normalizeReviewRunResult,
  reviewStep as runReviewStep,
  type ReviewJob,
  type ReviewResult,
  type ReviewRunResult,
  type ReviewStep as ReviewStepDefinition,
  type ReviewStepRunner
} from '../octa/review'

export const DEFAULT_OCTA_HOME = 'C:\\Octa'
export const DEFAULT_JOB_TIME_BUDGET_MS = 30 * 60_000
export const DEFAULT_SKILL_TOKEN_BUDGET = 300_000
export const DEFAULT_SCOUT_TOKEN_BUDGET = 2_000_000

const RATE_LIMIT_RETRY_DELAYS_MS = {
  claude: 5 * 60_000,
  codex: 15 * 60_000
} as const

const JOB_RESULT_STATUSES = ['ok', 'failed', 'needs_approval', 'needs_input', 'cancelled', 'stale'] as const
type FinalJobStatus = (typeof JOB_RESULT_STATUSES)[number]

export interface JobSpec extends JobStartRequest {
  /** Test and embedding hooks; IPC callers never need these fields. */
  homePath?: string
  skillsLibraryPath?: string
  skillPath?: string
  executable?: string
  argsOverride?: string[]
  environment?: Record<string, string | undefined>
  messages?: ChatMessage[]
  tools?: ToolDefinition[]
  chatProvider?: ChatProvider
  systemPrompt?: string
  plannerPrompt?: string
  knowledgePath?: string
}

export interface JobRunnerArgvContext {
  workspace: string
  skillPath?: string
  systemPromptFile?: string
  outputSchema?: string
  allowedTools?: string[]
  /** Resolved from the model registry; omitted in tests, which get the tier defaults. */
  model?: { model: string; effort: string }
  /** Additional skills the agent may use (Claude: sub-agents; Codex: inlined). */
  extraSkillPaths?: string[]
  /** Let a Codex job reach the network (web research, site checks). */
  network?: boolean
}

export interface JobRunnerOptions {
  jobs?: JobsRepository
  getSettings?: () => AppSettings
  homePath?: string
  skillsLibraryPath?: string
  spawn?: SpawnFunction
  platform?: NodeJS.Platform
  now?: () => Date
  onEvent?: (event: JobEvent) => void
  chatProvider?: ChatProvider
  claudeBinary?: string
  codexBinary?: string
  /** Injectable Sol adapter used by tests and future workflow runners. */
  reviewStep?: ReviewStepRunner
  reviewRunner?: ReviewStepRunner
  review?: ReviewStepRunner
  /** Extra per-tier fallback models (spec 018); the manager tier falls back to Sonnet by default. */
  tierFallbacks?: Partial<Record<ModelTier, string>>
  /** Company whose brain jobs read when the job does not name one. */
  getActiveCompany?: () => string | undefined
}

export type SpawnFunction = (
  command: string,
  args?: string[],
  options?: SpawnOptions
) => ChildProcess

export interface JobHandle {
  id: string
  jobId: string
  folder: string
  promise: Promise<JobResult>
  result: Promise<JobResult>
  events: EventEmitter
  onEvent(listener: (event: JobEvent) => void): () => void
  cancel(): Promise<boolean>
}

export interface SkillManifestEntry {
  name: string
  folder: string
  sourcePath?: string
  runner?: string
  [key: string]: unknown
}

export interface SkillResolution {
  entry: SkillManifestEntry
  skillPath: string
  skillMarkdown: string
  frontmatter: SkillFrontmatter
  manifestPath: string
}

export interface SkillResolutionOptions {
  skillsLibraryPath?: string
  manifestPath?: string
  settings?: Pick<AppSettings, 'skillsLibraryPath'>
}

export interface RunSkillRequest {
  name: string
  input?: unknown
  runner?: JobStartRequest['runner']
  department?: string | null
  autonomy?: JobAutonomy
  gate?: JobGate
  language?: string
  homePath?: string
  skillsLibraryPath?: string
  timeBudgetMs?: number
  maxRetries?: number
}

export const JOB_RESULT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Octa job result',
  type: 'object',
  additionalProperties: false,
  properties: {
    job_id: { type: 'string' },
    step_id: { type: 'string' },
    status: { type: 'string', enum: JOB_RESULT_STATUSES },
    outputs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          type: { type: 'string' },
          title: { type: 'string' }
        },
        required: ['path', 'type', 'title']
      }
    },
    sources: { type: 'string' },
    metrics: {
      type: 'object',
      additionalProperties: false,
      properties: {
        source_count: { type: 'number' },
        languages: { type: 'array', items: { type: 'string' } },
        tokens_in: { type: 'number' },
        tokens_out: { type: 'number' },
        seconds: { type: 'number' },
        cost_usd: { type: 'number' }
      },
      required: ['source_count', 'languages', 'tokens_in', 'tokens_out', 'seconds', 'cost_usd']
    },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
          why: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          blocking: { type: 'boolean' }
        },
        required: ['id', 'text', 'why', 'options', 'blocking']
      }
    },
    notes: { type: 'string' }
  },
  required: ['job_id', 'step_id', 'status', 'outputs', 'sources', 'metrics', 'questions', 'notes']
} as const

const CRITIQUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    issues: { type: 'array', items: { type: 'string' } },
    missing_questions: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    verdict: { type: 'string', enum: ['agree', 'revise'] }
  },
  required: ['issues', 'missing_questions', 'risks', 'verdict']
} as const

type JobEventPayload =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; phase?: 'start' | 'complete'; input?: unknown; output?: unknown }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; costUsd?: number }
  | { type: 'error'; message: string; code?: string | number }
  | { type: 'done'; status: FinalJobStatus; result?: JobResult }

function event<T extends JobEventPayload>(value: T): JobEvent {
  return {
    ...value,
    jobId: '',
    timestamp: new Date().toISOString()
  } as JobEvent
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function usageEvent(value: unknown): JobEvent | undefined {
  const usage = asRecord(value)
  if (!usage) return undefined
  const inputTokens = numberValue(usage.input_tokens ?? usage.inputTokens)
  const outputTokens = numberValue(usage.output_tokens ?? usage.outputTokens)
  const cachedInputTokens = numberValue(usage.cached_input_tokens ?? usage.cachedInputTokens)
  const costUsd = numberValue(usage.cost_usd ?? usage.costUsd ?? usage.total_cost_usd)
  if (inputTokens === undefined && outputTokens === undefined && cachedInputTokens === undefined && costUsd === undefined) {
    return undefined
  }
  return event({ type: 'usage', inputTokens, outputTokens, cachedInputTokens, costUsd })
}

function claudeContentEvents(value: unknown): JobEvent[] {
  if (!Array.isArray(value)) return []
  const events: JobEvent[] = []
  for (const block of value) {
    const item = asRecord(block)
    if (!item) continue
    const blockType = item.type
    if (blockType === 'text') {
      const text = textValue(item.text)
      if (text) events.push(event({ type: 'text', text }))
    } else if (blockType === 'tool_use') {
      const name = textValue(item.name)
      if (name) events.push(event({ type: 'tool', name, phase: 'start', input: item.input }))
    } else if (blockType === 'tool_result') {
      const name = textValue(item.name) ?? textValue(item.tool_name) ?? 'tool'
      events.push(event({ type: 'tool', name, phase: 'complete', output: item.content ?? item.output }))
    }
  }
  return events
}

/** Convert one Claude stream-json object to the common event shape. */
export function parseClaudeEvent(value: unknown): JobEvent[] {
  const payload = asRecord(value)
  if (!payload) return []
  const events: JobEvent[] = []
  const message = asRecord(payload.message)
  const messageUsage = usageEvent(message?.usage)
  if (messageUsage) events.push(messageUsage)
  const topUsage = usageEvent(payload.usage)
  if (topUsage) events.push(topUsage)

  if (payload.type === 'assistant') {
    events.push(...claudeContentEvents(message?.content ?? payload.content))
  } else if (payload.type === 'user') {
    events.push(...claudeContentEvents(message?.content ?? payload.content))
  } else if (payload.type === 'stream_event') {
    const stream = asRecord(payload.event)
    const delta = asRecord(stream?.delta)
    const deltaText = textValue(delta?.text)
    if (deltaText) events.push(event({ type: 'text', text: deltaText }))
    if (stream?.type === 'content_block_start') {
      const contentBlock = asRecord(stream.content_block)
      const name = textValue(contentBlock?.name)
      if (name) events.push(event({ type: 'tool', name, phase: 'start', input: contentBlock?.input }))
    }
  }

  if (payload.type === 'result' || payload.subtype === 'success' || payload.is_error === true) {
    const resultText = textValue(payload.result)
    if (resultText) events.push(event({ type: 'text', text: resultText }))
    const status: FinalJobStatus = payload.is_error === true || payload.subtype === 'error'
      ? 'failed'
      : 'ok'
    events.push(event({ type: 'done', status }))
  } else if (payload.type === 'error') {
    const messageText = textValue(payload.message) ?? textValue(payload.error) ?? 'Claude returned an error.'
    events.push(event({ type: 'error', message: messageText }))
  }
  return events
}

/** Parse newline-delimited Claude stream-json output, tolerating blank lines. */
export function parseClaudeStreamJson(output: string): JobEvent[] {
  const events = output
    .split(/\r?\n/)
    .flatMap((line) => {
      if (!line.trim()) return []
      try {
        return parseClaudeEvent(JSON.parse(line) as unknown)
      } catch {
        return []
      }
    })
  return dedupeTextEvents(events)
}

export const parseClaudeStream = parseClaudeStreamJson

function codexItemEvents(item: Record<string, unknown>, phase: 'start' | 'complete'): JobEvent[] {
  const itemType = textValue(item.type) ?? 'codex_item'
  if (itemType === 'agent_message') {
    const text = textValue(item.text)
    return text ? [event({ type: 'text', text })] : []
  }
  if (itemType === 'command_execution') {
    return [
      event({
        type: 'tool',
        name: 'Bash',
        phase,
        input: phase === 'start' ? { command: item.command } : undefined,
        output: phase === 'complete' ? item.aggregated_output ?? item.output : undefined
      })
    ]
  }
  if (itemType === 'mcp_tool_call' || itemType === 'dynamic_tool_call') {
    return [
      event({
        type: 'tool',
        name: textValue(item.tool) ?? textValue(item.name) ?? 'CodexTool',
        phase,
        input: phase === 'start' ? item.arguments ?? item.input : undefined,
        output: phase === 'complete' ? item.result ?? item.output : undefined
      })
    ]
  }
  if (itemType === 'file_change') {
    return [event({ type: 'tool', name: 'Edit', phase, input: item.changes })]
  }
  return []
}

/** Convert one Codex JSONL object to the common event shape. */
export function parseCodexEvent(value: unknown): JobEvent[] {
  const payload = asRecord(value)
  if (!payload) return []
  const events: JobEvent[] = []
  const item = asRecord(payload.item)
  if (payload.type === 'item.started' && item) events.push(...codexItemEvents(item, 'start'))
  if (payload.type === 'item.completed' && item) events.push(...codexItemEvents(item, 'complete'))
  if (item?.type === 'error') {
    events.push(event({ type: 'error', message: textValue(item.message) ?? 'Codex returned an item error.' }))
  }
  const usage = usageEvent(payload.usage)
  if (usage) events.push(usage)
  if (payload.type === 'error' || payload.type === 'turn.failed') {
    const message = textValue(payload.message) ?? textValue(payload.error) ?? textValue(asRecord(payload.error)?.message) ?? 'Codex returned an error.'
    events.push(event({ type: 'error', message }))
    if (payload.type === 'turn.failed') events.push(event({ type: 'done', status: 'failed' }))
  } else if (payload.type === 'turn.completed') {
    const status = textValue(payload.status)?.toLowerCase()
    events.push(event({ type: 'done', status: status && !['completed', 'success', 'succeeded'].includes(status) ? 'failed' : 'ok' }))
  }
  return events
}

/** Parse Codex's JSON-lines stream, ignoring non-JSON diagnostic lines. */
export function parseCodexJsonLines(output: string): JobEvent[] {
  const events = output
    .split(/\r?\n/)
    .flatMap((line) => {
      if (!line.trim()) return []
      try {
        return parseCodexEvent(JSON.parse(line) as unknown)
      } catch {
        return []
      }
    })
  return dedupeTextEvents(events)
}

export const parseCodexJsonl = parseCodexJsonLines

function dedupeTextEvents(events: JobEvent[]): JobEvent[] {
  let accumulated = ''
  return events.flatMap((item) => {
    if (item.type !== 'text' || !item.text) return [item]
    if (item.text === accumulated || accumulated.endsWith(item.text)) return []
    if (item.text.startsWith(accumulated)) {
      const delta = item.text.slice(accumulated.length)
      accumulated = item.text
      return delta ? [{ ...item, text: delta }] : []
    }
    accumulated += item.text
    return [item]
  })
}

export const HEADLESS_BLOCKED_TOOLS = ['ScheduleWakeup', 'CronCreate', 'CronDelete', 'RemoteTrigger', 'PushNotification', 'Monitor']

function allowedToolsFor(autonomy: JobSpec['autonomy'] = 'assisted'): string[] {
  const readOnly = ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']
  // Draft-only still writes its own deliverables (out/); it just cannot run commands.
  if (autonomy === 'led') return [...readOnly, 'Write', 'Edit']
  return [
    ...readOnly,
    'Write',
    'Edit',
    'Bash(python *)',
    'Bash(node *)',
    'Bash(uv *)',
    'Bash(npx *)',
    'Bash(ffmpeg *)'
  ]
}

/** The job's own model (per-step tier or fallback), else the tier's phase from Settings → Models. */
function modelFor(context: JobRunnerArgvContext, tier: ModelTier): { model: string; effort: string } {
  return context.model ?? resolveTier(tier)
}

function codexArgsFor(context: JobRunnerArgvContext, tier: ModelTier): string[] {
  const { model, effort } = modelFor(context, tier)
  return ['-m', model, ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : [])]
}

export function buildClaudePlanArgv(context: JobRunnerArgvContext): string[] {
  const { model, effort } = modelFor(context, 'manager')
  return [
    '-p',
    '--model',
    model,
    ...(effort ? ['--effort', effort] : []),
    '--output-format',
    'json',
    '--add-dir',
    context.workspace,
    '--append-system-prompt-file',
    context.systemPromptFile ?? 'planner.md'
  ]
}

export function buildClaudeSkillArgv(context: JobRunnerArgvContext, autonomy: JobSpec['autonomy'] = 'assisted'): string[] {
  if (!context.skillPath) throw new Error('claude-skill requires a skill path.')
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--add-dir',
    context.skillPath,
    '--add-dir',
    context.workspace,
    ...(context.extraSkillPaths ?? []).flatMap((path) => ['--add-dir', path]),
    '--append-system-prompt-file',
    join(context.skillPath, 'SKILL.md'),
    '--allowedTools',
    ...(context.allowedTools ?? allowedToolsFor(autonomy)),
    // Extra skills are mounted as Claude Code sub-agents (.claude/agents in the job folder).
    ...(context.extraSkillPaths?.length ? ['Task', 'Agent'] : []),
    // A headless job ends when the CLI exits: loop, schedule and notify tools only stall it.
    '--disallowedTools',
    ...HEADLESS_BLOCKED_TOOLS,
    '--model',
    modelFor(context, 'claude-tools').model
  ]
}

/** The shipped default for the Codex executor phase (Luna). The live value comes from phaseModel('code'). */
export const CODEX_EXECUTOR_MODEL = DEFAULT_PHASE_MODELS.code.model

export function buildCodexExecArgv(context: JobRunnerArgvContext): string[] {
  const args = [
    'exec',
    '--json',
    ...codexArgsFor(context, 'executor'),
    '-c',
    'service_tier="priority"',
    '-c',
    'features.fast_mode=true',
    '-s',
    'workspace-write',
    '-C',
    context.workspace
  ]
  if (context.skillPath) args.push('--add-dir', context.skillPath)
  for (const path of context.extraSkillPaths ?? []) args.push('--add-dir', path)
  if (context.network) args.push('-c', 'sandbox_workspace_write.network_access=true')
  args.push('--skip-git-repo-check')
  args.push('--output-schema', context.outputSchema ?? 'result.schema.json')
  return args
}

export function buildCodexCriticArgv(context: JobRunnerArgvContext): string[] {
  return [
    'exec',
    '--json',
    ...codexArgsFor(context, 'critic'),
    '-s',
    'read-only',
    '-C',
    context.workspace,
    '--skip-git-repo-check',
    '--output-schema',
    context.outputSchema ?? 'critique.schema.json'
  ]
}

export function buildCodexReviewArgv(context: JobRunnerArgvContext): string[] {
  return [
    'exec',
    '--json',
    ...codexArgsFor(context, 'reviewer'),
    '-s',
    'read-only',
    '-C',
    context.workspace,
    '--skip-git-repo-check',
    '--output-schema',
    context.outputSchema ?? 'review.schema.json'
  ]
}

export function buildRunnerArgv(
  runner: JobSpec['runner'],
  context: JobRunnerArgvContext,
  autonomy: JobSpec['autonomy'] = 'assisted'
): string[] {
  switch (runner) {
    case 'claude-plan':
      return buildClaudePlanArgv(context)
    case 'claude-skill':
      return buildClaudeSkillArgv(context, autonomy)
    case 'codex-exec':
    case 'codex-scout':
      return buildCodexExecArgv(context)
    case 'codex-critic':
      return buildCodexCriticArgv(context)
    case 'codex-review':
      return buildCodexReviewArgv(context)
    case 'gemini-inline':
      return []
    default:
      throw new Error(`Unsupported job runner: ${String(runner)}`)
  }
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

function writeJsonFile(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function findNativeFile(root: string, filename: string, depth: number): string | undefined {
  if (depth < 0 || !existsSync(root)) return undefined
  let entries: Dirent<string>[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isFile() && entry.name.toLowerCase() === filename.toLowerCase()) return path
    if (entry.isDirectory()) {
      const found = findNativeFile(path, filename, depth - 1)
      if (found) return found
    }
  }
  return undefined
}

function nativeFromNpmShim(shim: string, name: string): string | undefined {
  const npmRoot = dirnameOf(shim)
  if (name === 'claude') {
    const candidate = join(npmRoot, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
    return existsSync(candidate) ? candidate : undefined
  }
  const packageRoot = join(npmRoot, 'node_modules', '@openai', 'codex')
  return findNativeFile(packageRoot, 'codex.exe', 6)
}

function dirnameOf(path: string): string {
  const lastSlash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return lastSlash < 0 ? '.' : path.slice(0, lastSlash)
}

/** Resolve a native executable so Windows never needs a shell or a .cmd shim. */
export function resolveCliBinary(name: 'claude' | 'codex', environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = environment[name === 'claude' ? 'OCTA_CLAUDE_BINARY' : 'OCTA_CODEX_BINARY']
  if (override?.trim()) return override.trim()
  const pathEntries = [
    ...envPath(environment).split(delimiter),
    // Where the official installers put the CLIs, in case PATH was not inherited (Start-menu launch).
    environment.USERPROFILE ? join(environment.USERPROFILE, '.local', 'bin') : '',
    environment.APPDATA ? join(environment.APPDATA, 'npm') : ''
  ].filter(Boolean)
  for (const entry of pathEntries) {
    const candidates = [join(entry, `${name}.exe`), join(entry, name), join(entry, `${name}.cmd`)]
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue
      if (extname(candidate).toLowerCase() === '.exe') return candidate
      const native = nativeFromNpmShim(candidate, name)
      if (native) return native
      if (environment.OS !== 'Windows_NT') return candidate
    }
  }
  if (environment.OS !== 'Windows_NT') return name
  return undefined
}

function defaultSkillsLibraryCandidates(settings?: Pick<AppSettings, 'skillsLibraryPath'>, explicit?: string): string[] {
  const candidates = [
    explicit,
    settings?.skillsLibraryPath,
    process.env.OCTA_SKILLS_LIBRARY_PATH,
    resolve(process.cwd(), 'skills-library'),
    resolve(__dirname, '../../../skills-library'),
    resolve(__dirname, '../../../../skills-library'),
    process.resourcesPath ? resolve(process.resourcesPath, 'skills-library') : undefined,
    resolve(process.env.OCTA_HOME?.trim() || DEFAULT_OCTA_HOME, 'skills-library')
  ]
  return candidates.filter((value, index, all): value is string => Boolean(value?.trim()) && all.indexOf(value) === index)
}

function manifestEntries(value: unknown): SkillManifestEntry[] {
  const record = asRecord(value)
  if (!record || !Array.isArray(record.skills)) return []
  return record.skills.filter((item): item is SkillManifestEntry => {
    const entry = asRecord(item)
    return typeof entry?.name === 'string' && typeof entry.folder === 'string'
  })
}

export function resolveSkill(name: string, options: SkillResolutionOptions = {}): SkillResolution {
  const requestedName = name.trim()
  if (!requestedName) throw new Error('Skill name is required.')
  const libraryCandidates = defaultSkillsLibraryCandidates(options.settings, options.skillsLibraryPath)
  const manifestPath = options.manifestPath ?? libraryCandidates
    .map((library) => join(library, 'MANIFEST.json'))
    .find(existsSync)
  if (!manifestPath) {
    throw new Error(`Skills manifest was not found. Checked: ${libraryCandidates.join(', ')}`)
  }
  const manifest = readJsonFile(manifestPath)
  const entry = manifestEntries(manifest).find((item) => item.name === requestedName)
  if (!entry) throw new Error(`Skill "${requestedName}" was not found in ${manifestPath}.`)

  const library = dirnameOf(manifestPath)
  const possiblePaths = [
    join(library, 'skills', entry.folder),
    join(library, entry.folder),
    entry.sourcePath
  ].filter((value): value is string => Boolean(value))
  const skillPath = possiblePaths.find((value) => existsSync(join(value, 'SKILL.md')))
  if (!skillPath) {
    throw new Error(`Skill "${requestedName}" is listed in ${manifestPath}, but its SKILL.md folder is missing.`)
  }
  const resolvedSkillPath = resolve(skillPath)
  const skillMarkdown = readFileSync(join(resolvedSkillPath, 'SKILL.md'), 'utf8')
  return {
    entry,
    skillPath: resolvedSkillPath,
    skillMarkdown,
    frontmatter: parseSkillFrontmatter(skillMarkdown),
    manifestPath: resolve(manifestPath)
  }
}

function mountSkill(jobFolder: string, skillPath: string): string {
  const mountPath = join(jobFolder, 'skill')
  try {
    symlinkSync(skillPath, mountPath, process.platform === 'win32' ? 'junction' : 'dir')
  } catch {
    cpSync(skillPath, mountPath, { recursive: true })
  }
  return mountPath
}

function safeJobId(value?: string): string {
  if (!value) return randomUUID()
  const id = value.trim()
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('Job id must contain only letters, numbers, hyphens, and underscores.')
  return id
}

function inputText(input: unknown): string {
  if (typeof input === 'string') return input
  const record = asRecord(input)
  if (typeof record?.text === 'string') return record.text
  try {
    return JSON.stringify(input ?? {}, null, 2)
  } catch {
    return String(input)
  }
}

function renderBrief(spec: JobSpec): string {
  const brief = spec.brief?.trim() || spec.prompt?.trim() || inputText(spec.input)
  const input = spec.input === undefined ? '' : `\n\n## Input JSON\n\n\`\`\`json\n${JSON.stringify(spec.input, null, 2)}\n\`\`\``
  return `# Octa job brief\n\n${brief}${input}\n`
}

function renderStepInstructions(spec: JobSpec): string {
  const brief = spec.brief?.trim()
  const prompt = spec.prompt?.trim()
  if (!brief || !prompt || brief === prompt) return ''
  return `\n\n## Step instructions\n\n${prompt}\n`
}

function renderKnowledge(knowledgePath?: string): string {
  if (!knowledgePath || !existsSync(knowledgePath)) return ''
  // The company's master prompt (how to show up for it) leads, then the facts.
  const files = COMPANY_FILES
  return files
    .map((file) => {
      const path = join(knowledgePath, file)
      if (!existsSync(path)) return ''
      try {
        return `\n### ${file}\n${readFileSync(path, 'utf8')}`
      } catch {
        return ''
      }
    })
    .filter(Boolean)
    .concat(renderOwnerMemory(knowledgePath))
    .join('\n')
}

/** knowledge/owner.md sits two levels above a company folder (knowledge/companies/<slug>). */
function renderOwnerMemory(knowledgePath: string): string[] {
  const candidates = [join(knowledgePath, 'owner.md'), join(knowledgePath, '..', '..', 'owner.md')]
  const path = candidates.find((candidate) => existsSync(candidate))
  if (!path) return []
  try {
    return [`\n### owner.md (what the owner asked Octa to remember)\n${readFileSync(path, 'utf8')}`]
  } catch {
    return []
  }
}

function renderReviewFeedback(review?: ReviewResult): string {
  if (!review) return ''
  const issues = review.issues.length > 0
    ? review.issues
      .map((issue) => `- Criterion: ${JSON.stringify(issue.criterion)}\n  Detail: ${issue.detail}\n  Severity: ${issue.severity}`)
      .join('\n')
    : '- Sol requested a revision without a structured issue. Re-check every acceptance criterion.'
  return `\n\n## Sol review feedback\n\nThe previous executor attempt received verdict "${review.verdict}". Address the following issues before producing the same deliverable again:\n${issues}\n\nKeep the work within the original acceptance criteria and write the corrected deliverable to ./out.`
}

function renderPrompt(
  spec: JobSpec,
  folder: string,
  skill?: SkillResolution,
  retryError?: string,
  review?: ReviewResult
): string {
  const language = spec.language?.trim() || "the language of the user's last turn"
  const skillText = skill && (spec.runner === 'codex-exec' || spec.runner === 'codex-scout')
    ? `\n\n# Inlined SKILL.md (${skill.entry.name})\n\n${skill.skillMarkdown}`
    : ''
  const retry = retryError ? `\n\n## Previous attempt error\n\n${retryError}\nFix the error and retry the same job.` : ''
  return `<octa>\nYou are running inside Octa Assistant. Reply in ${language}.\n${spec.company ? `You are working for the company "${spec.company}". ` : ''}Company brain follows (its master prompt first); treat it as ground truth and never contradict it.${renderKnowledge(spec.knowledgePath)}\nBefore you finish, run the 3-point QA on your deliverable: 1) is it simple, 2) is it useful today, 3) is the next step clear. Fix what fails.\nSkill to execute: ${spec.skill ?? 'the assigned job'}. Write deliverables to ./out. Do not send, publish, or pay; write what you would send to ./out and set status needs_approval. When information is missing, do not invent it: return status needs_input with questions[]. Finish by writing result.json matching the schema in ./contract.json.\nJob folder: ${folder}\n</octa>\n\n${renderBrief(spec)}${renderStepInstructions(spec)}${skillText}${retry}${renderReviewFeedback(review)}\n`
}

/**
 * Mounts an agent's additional skills (spec 018 "skills as sub-agents"). Each lands in skills/<name>.
 * For Claude runs each also becomes a Claude Code sub-agent (.claude/agents/<name>.md in the job
 * folder, which is the CLI's working directory), so the main agent can delegate to it.
 * Skills that cannot be resolved are reported in the prompt instead of failing the job.
 */
function mountExtraSkills(
  folder: string,
  names: string[],
  resolveByName: (name: string) => SkillResolution,
  asClaudeSubagents: boolean
): Array<{ name: string; skill?: SkillResolution; error?: string }> {
  return [...new Set(names)].map((name) => {
    try {
      const skill = resolveByName(name)
      const target = join(folder, 'skills', name)
      mkdirSync(join(folder, 'skills'), { recursive: true })
      try {
        symlinkSync(skill.skillPath, target, process.platform === 'win32' ? 'junction' : 'dir')
      } catch {
        cpSync(skill.skillPath, target, { recursive: true })
      }
      if (asClaudeSubagents) {
        mkdirSync(join(folder, '.claude', 'agents'), { recursive: true })
        const description = String(skill.frontmatter.description || skill.entry.description || `Specialist for ${name}`).replace(/\s+/g, ' ').slice(0, 900)
        const body = skill.skillMarkdown.replace(/^---[\s\S]*?\n---\s*/, '')
        writeFileSync(join(folder, '.claude', 'agents', `${name}.md`), [
          '---',
          `name: ${name}`,
          `description: ${JSON.stringify(description)}`,
          'tools: Read, Grep, Glob, WebFetch, WebSearch, Write, Edit',
          '---',
          '',
          `You are the ${name} specialist working for the agent that called you. Your skill files (references, assets, scripts) are in ${skill.skillPath}. Follow the skill below, write any file you produce under ./out, and return a concise result.`,
          '',
          body
        ].join('\n'), 'utf8')
      }
      return { name, skill }
    } catch (error) {
      return { name, error: error instanceof Error ? error.message : String(error) }
    }
  })
}

interface MountedTeamMember {
  member: SubAgentSpec
  skills: SkillResolution[]
  missing: string[]
  examples: string[]
}

const EXAMPLE_FILE = /\.(md|txt)$/i
const EXAMPLES_BUDGET = 40_000

/** The owner's examples for one specialist: knowledge/companies/<slug>/examples/<specialist>/*.md|txt (README excluded). */
function readTeamExamples(knowledgePath: string | undefined, slug: string): string[] {
  if (!knowledgePath) return []
  const folder = join(knowledgePath, 'examples', slug)
  if (!existsSync(folder)) return []
  let budget = EXAMPLES_BUDGET
  const examples: string[] = []
  for (const name of readdirSync(folder).filter((file) => EXAMPLE_FILE.test(file) && !/^readme\./i.test(file)).sort()) {
    if (budget <= 0) break
    try {
      const text = readFileSync(join(folder, name), 'utf8').trim().slice(0, budget)
      if (!text) continue
      budget -= text.length
      examples.push(`### ${name}\n${text}`)
    } catch {
      // An unreadable example is skipped; the others still count.
    }
  }
  return examples
}

/**
 * Specialists under a lead agent become Claude Code sub-agents (.claude/agents/<slug>.md). They only
 * act on the lead's brief, carry their skills, review checklist and the owner's examples, and never
 * appear in the agent lineup.
 */
function mountTeam(
  folder: string,
  team: SubAgentSpec[],
  resolveByName: (name: string) => SkillResolution,
  context: { lead: string; company?: string; knowledgePath?: string }
): MountedTeamMember[] {
  if (team.length === 0) return []
  mkdirSync(join(folder, '.claude', 'agents'), { recursive: true })
  mkdirSync(join(folder, 'out', 'team'), { recursive: true })
  return team.map((member) => {
    const skills: SkillResolution[] = []
    const missing: string[] = []
    for (const name of member.skills) {
      try {
        skills.push(resolveByName(name))
      } catch (error) {
        missing.push(`${name} (${error instanceof Error ? error.message : String(error)})`)
      }
    }
    const examples = readTeamExamples(context.knowledgePath, member.slug)
    const tools = member.tools === 'research' ? 'Read, Grep, Glob, Write, Edit, WebFetch, WebSearch' : 'Read, Grep, Glob, Write, Edit'
    const description = `${member.name}: ${member.scope} Works only on a brief from ${context.lead}.`.replace(/\s+/g, ' ').slice(0, 900)
    const body = [
      '---',
      `name: ${member.slug}`,
      `description: ${JSON.stringify(description)}`,
      `tools: ${tools}`,
      '---',
      '',
      `You are ${member.name}, a specialist on ${context.lead}'s team${context.company ? ` for the company "${context.company}"` : ''}. You never work on your own: ${context.lead} decides the strategy and briefs you, and reviews your draft before anyone sees it.`,
      '',
      '## Rules',
      '- Work only on the brief you were given. The audience, awareness stage, offer, message and goal come from the brief; do not choose them yourself. If the brief is missing them, stop and return the questions instead of guessing.',
      `- The company brain is ground truth${context.knowledgePath ? ` (${context.knowledgePath}: master-prompt.md, company.md, voice.md, icp.md, pricing.md, lessons.md; the owner's memory is owner.md two folders up)` : ''}. Never invent numbers, prices, client stories, quotes, results or claims it does not give you.`,
      "- Follow the company's voice, its lessons and the owner's memory. A lesson overrides your skill's defaults.",
      `- Write your draft under ./out/team/${member.slug}/. Never publish, send, pay or delete anything.`,
      '- Before you return, check your draft against your review checklist point by point and fix what fails. Report honestly: pass or fail per point, with a reason.',
      '- Return: the file path(s), your checklist self-check, and any open questions.',
      '',
      '## Role',
      member.role,
      '',
      '## Scope',
      member.scope,
      '',
      '## Definition of done',
      member.definitionOfDone,
      '',
      '## Review checklist (your lead checks every point)',
      ...member.checklist.map((point, index) => `${index + 1}. ${point}`),
      '',
      examples.length
        ? `## Examples from the owner (how the work should look; match the level, do not copy)\n${examples.join('\n\n')}`
        : '## Examples from the owner\nNone yet. Follow the skill and the brain.',
      '',
      ...skills.flatMap((skill) => [
        `## Skill: ${skill.entry.name} (references, assets and scripts in ${skill.skillPath})`,
        skill.skillMarkdown.replace(/^---[\s\S]*?\n---\s*/, '')
      ]),
      missing.length ? `\nSkills not available right now: ${missing.join('; ')}.` : ''
    ].join('\n')
    writeFileSync(join(folder, '.claude', 'agents', `${member.slug}.md`), body, 'utf8')
    return { member, skills, missing, examples }
  })
}

/** The lead's side of the team: who is on it and the mandatory review workflow. */
function renderTeam(team: MountedTeamMember[] | undefined): string {
  if (!team?.length) return ''
  const lines = [
    `\n\n# Your team (${team.length} specialists): you lead, they draft, you review`,
    'They are Claude Code sub-agents; call them with the Task/Agent tool by their id. They never work on their own and never decide the strategy.',
    ...team.map((item) => `- ${item.member.slug} — ${item.member.name}: ${item.member.scope}${item.examples.length ? ` (${item.examples.length} owner example${item.examples.length === 1 ? '' : 's'})` : ''}${item.missing.length ? ` [missing skills: ${item.missing.join(', ')}]` : ''}`),
    '',
    '## Team workflow (mandatory, in this order)',
    '1. Diagnose first with your own skill: product, persona, awareness stage, offer, message, 3C funnel stage and the success metric. Write out/diagnosis.md. Never delegate the diagnosis or the decision.',
    '2. Brief only the specialists this task needs, in RCCF form: Role (what they are for this task), Context (the diagnosis, the brain facts and the lessons that matter), Command (exactly what to draft), Format (file and structure).',
    "3. Review every returned draft against: (a) your diagnosis, (b) the brain's facts (nothing invented), (c) the company voice, lessons and the owner's memory, (d) that specialist's checklist below. Mark every point pass or fail with a reason.",
    '4. Send anything that fails back with precise notes. At most 2 rounds per specialist; if it still fails, drop it and say why.',
    '5. Write out/review-log.md: for each specialist — the brief in one line, the rounds, every checklist point pass/fail, what changed, and the final verdict.',
    '6. Your final deliverable contains only work that passed your review. An independent reviewer and then the owner check it after you.',
    '',
    '## Checklists per specialist'
  ]
  for (const item of team) {
    lines.push(`### ${item.member.slug} — ${item.member.name}`, ...item.member.checklist.map((point, index) => `${index + 1}. ${point}`))
  }
  return lines.join('\n')
}

function renderExtraSkills(spec: JobSpec, extras: Array<{ name: string; skill?: SkillResolution; error?: string }> | undefined): string {
  if (!extras?.length) return ''
  const available = extras.filter((item) => item.skill)
  const missing = extras.filter((item) => !item.skill)
  const claude = spec.runner.startsWith('claude')
  const lines = [`\n\n# Your other skills (${available.length})`]
  if (claude && available.length) {
    lines.push(`Each is a sub-agent you can delegate to with the Task/Agent tool: ${available.map((item) => item.name).join(', ')}. Hand each specialist the part of the work its skill covers, then combine their results into your deliverable.`)
  }
  for (const item of available) {
    lines.push(`\n## Skill: ${item.name} (files: skills/${item.name})`)
    if (!claude) lines.push(item.skill!.skillMarkdown)
  }
  if (missing.length) lines.push(`\nNot available right now: ${missing.map((item) => `${item.name} (${item.error})`).join('; ')}. Do the work without them.`)
  return lines.join('\n')
}

function writeJobFiles(folder: string, spec: JobSpec): void {
  mkdirSync(folder, { recursive: true })
  mkdirSync(join(folder, 'inputs'), { recursive: true })
  mkdirSync(join(folder, 'out'), { recursive: true })
  mkdirSync(join(folder, 'evidence'), { recursive: true })
  writeFileSync(join(folder, 'brief.md'), renderBrief(spec), 'utf8')
  writeJsonFile(join(folder, 'contract.json'), JOB_RESULT_SCHEMA)
  writeJsonFile(join(folder, 'result.schema.json'), JOB_RESULT_SCHEMA)
  writeJsonFile(join(folder, 'critique.schema.json'), CRITIQUE_SCHEMA)
  writeJsonFile(join(folder, 'review.schema.json'), REVIEW_SCHEMA)
  writeFileSync(
    join(folder, 'planner.md'),
    spec.plannerPrompt?.trim() || 'You are Fable, Octa Assistant\'s planner. Return only valid JSON for the requested plan schema. Ask blocking questions instead of inventing missing facts.',
    'utf8'
  )
  if (!existsSync(join(folder, 'log.jsonl'))) writeFileSync(join(folder, 'log.jsonl'), '', 'utf8')
}

function normalizeRelativePath(value: string): string {
  return value.replaceAll('\\', '/')
}

function outputType(path: string): string {
  const extension = extname(path).toLowerCase()
  const types: Record<string, string> = {
    '.md': 'markdown',
    '.txt': 'text',
    '.html': 'html',
    '.htm': 'html',
    '.json': 'json',
    '.pdf': 'pdf',
    '.png': 'image',
    '.jpg': 'image',
    '.jpeg': 'image',
    '.xlsx': 'spreadsheet',
    '.docx': 'document'
  }
  return types[extension] ?? 'file'
}

function listOutputFiles(folder: string): JobResult['outputs'] {
  const root = join(folder, 'out')
  const outputs: JobResult['outputs'] = []
  const walk = (directory: string): void => {
    let entries: Dirent<string>[]
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) walk(absolute)
      else if (entry.isFile()) {
        const relativePath = normalizeRelativePath(relative(folder, absolute))
        outputs.push({ path: relativePath, type: outputType(absolute), title: basename(entry.name) })
      }
    }
  }
  walk(root)
  return outputs
}

function countSources(folder: string): number {
  const path = join(folder, 'evidence', 'sources.jsonl')
  if (!existsSync(path)) return 0
  try {
    return readFileSync(path, 'utf8').split(/\r?\n/).filter((line) => line.trim()).length
  } catch {
    return 0
  }
}

function statusValue(value: unknown): FinalJobStatus | undefined {
  return typeof value === 'string' && (JOB_RESULT_STATUSES as readonly string[]).includes(value)
    ? (value as FinalJobStatus)
    : undefined
}

function agentResultFile(folder: string): Record<string, unknown> | undefined {
  for (const path of [join(folder, 'result.json'), join(folder, 'out', 'result.json')]) {
    const record = asRecord(readJsonFile(path))
    if (record) return record
  }
  return undefined
}

function clearAgentResultFiles(folder: string): void {
  for (const path of [join(folder, 'result.json'), join(folder, 'out', 'result.json')]) {
    if (!existsSync(path)) continue
    try {
      unlinkSync(path)
    } catch {
      // An executor may keep the file open briefly; its next result still wins.
    }
  }
}

function structuredFromText(text: string): Record<string, unknown> | undefined {
  const candidates = [text.trim()]
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text.trim())
  if (fenced) candidates.unshift(fenced[1])
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate) as unknown
      const record = asRecord(value)
      if (record) return record
    } catch {
      // The agent may have returned prose instead of the structured contract.
    }
  }
  return undefined
}

function isCapacityError(message: string): boolean {
  return /\b429\b|rate.?limit|quota|capacity|overloaded|temporarily unavailable|\b(?:500|502|503|504)\b/i.test(message)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface KillTreeOptions {
  platform?: NodeJS.Platform
  spawn?: SpawnFunction
}

/** Kill a process and all descendants; Windows uses taskkill /T /F. */
export function killProcessTree(child: ChildProcess, options: KillTreeOptions = {}): Promise<void> {
  const platform = options.platform ?? process.platform
  const spawn: SpawnFunction = options.spawn ?? (nodeSpawn as unknown as SpawnFunction)
  if ((child.exitCode !== null && child.exitCode !== undefined) || (child.signalCode !== null && child.signalCode !== undefined)) return Promise.resolve()
  if (platform === 'win32' && child.pid) {
    return new Promise((resolveKill) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(fallbackTimer)
        resolveKill()
      }
      const fallbackTimer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          // The process may have exited between taskkill and the fallback.
        }
        finish()
      }, 1_500)
      try {
        const killer = spawn(
          'taskkill.exe',
          ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true, shell: false, stdio: 'ignore' }
        )
        killer.once('close', finish)
        killer.once('error', () => {
          try {
            child.kill()
          } catch {
            // Ignore a process that already exited.
          }
          finish()
        })
      } catch {
        try {
          child.kill()
        } catch {
          // Ignore a process that already exited.
        }
        finish()
      }
    })
  }

  try {
    child.kill('SIGTERM')
  } catch {
    return Promise.resolve()
  }
  return new Promise((resolveKill) => {
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // Ignore a process that already exited.
      }
      resolveKill()
    }, 500)
    child.once('close', () => {
      clearTimeout(timer)
      resolveKill()
    })
  })
}

interface UsageTotals {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  costUsd: number
}

interface ActiveJob {
  id: string
  folder: string
  spec: JobSpec
  skill?: SkillResolution
  emitter: EventEmitter
  controller: AbortController
  child?: ChildProcess
  cancelled: boolean
  timedOut: boolean
  overBudget: boolean
  startedAtMs: number
  totalUsage: UsageTotals
  reviewUsage: UsageTotals
  executorStructuredUsage: UsageTotals
  reviewAttempts: number
  review?: ReviewResult
  collectedText: string
  lastStructured?: Record<string, unknown>
  lastError?: string
  /** The agent's other skills, mounted under skills/ (sub-agents for Claude runs). */
  extraSkills?: Array<{ name: string; skill?: SkillResolution; error?: string }>
  /** Specialists under this lead agent, mounted as Claude sub-agents. */
  team?: MountedTeamMember[]
  /** Model the current attempt runs on (spec 018). */
  tierModel?: TierModel
  /** Set once when the tier's model was rejected and the fallback model is being tried. */
  modelOverride?: string
  /** Last recognised CLI error line (auth / model / version / rate limit) in this attempt. */
  cliFailure?: CliFailure
  promise: Promise<JobResult>
}

interface ProcessOutcome {
  exitCode: number | null
  signal: NodeJS.Signals | null
  error?: string
  parserStatus?: FinalJobStatus
}

function emptyUsage(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 }
}

function isReviewedExecutor(runner: JobSpec['runner']): boolean {
  return runner === 'codex-exec' || runner === 'claude-skill'
}

function acceptanceFor(spec: JobSpec): string[] {
  const values = spec.acceptance ?? spec.acceptanceCriteria ?? []
  return values
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean)
}

function usageNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
}

function addUsage(target: UsageTotals, source: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; costUsd?: number }): void {
  target.inputTokens += usageNumber(source.inputTokens)
  target.outputTokens += usageNumber(source.outputTokens)
  target.cachedInputTokens += usageNumber(source.cachedInputTokens)
  target.costUsd = Math.round((target.costUsd + usageNumber(source.costUsd)) * 1_000_000) / 1_000_000
}

function reviewUsage(review: ReviewRunResult): UsageTotals {
  const usage = emptyUsage()
  if (review.cost) addUsage(usage, review.cost)
  return usage
}

function roundCost(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

function costRecord(active: ActiveJob): Record<string, unknown> {
  const streamedExecutor = {
    inputTokens: Math.max(0, active.totalUsage.inputTokens - active.reviewUsage.inputTokens),
    outputTokens: Math.max(0, active.totalUsage.outputTokens - active.reviewUsage.outputTokens),
    costUsd: Math.max(0, active.totalUsage.costUsd - active.reviewUsage.costUsd)
  }
  const executorInputTokens = Math.max(streamedExecutor.inputTokens, active.executorStructuredUsage.inputTokens)
  const executorOutputTokens = Math.max(streamedExecutor.outputTokens, active.executorStructuredUsage.outputTokens)
  const executorCostUsd = Math.max(streamedExecutor.costUsd, active.executorStructuredUsage.costUsd)
  const record: Record<string, unknown> = {
    inputTokens: executorInputTokens + active.reviewUsage.inputTokens,
    outputTokens: executorOutputTokens + active.reviewUsage.outputTokens,
    costUsd: roundCost(executorCostUsd + active.reviewUsage.costUsd)
  }
  if (active.reviewAttempts > 0) {
    record.review = {
      attempts: active.reviewAttempts,
      inputTokens: active.reviewUsage.inputTokens,
      outputTokens: active.reviewUsage.outputTokens,
      costUsd: roundCost(active.reviewUsage.costUsd)
    }
  }
  return record
}

function finalStatusFor(active: ActiveJob, outcome: ProcessOutcome | undefined): FinalJobStatus {
  if (active.cancelled) return 'cancelled'
  if (active.timedOut || active.overBudget) return 'needs_input'
  const fromDisk = agentResultFile(active.folder)
  const fromDiskStatus = statusValue(fromDisk?.status)
  if (fromDiskStatus && fromDiskStatus !== 'ok') return fromDiskStatus
  if (outcome?.parserStatus === 'failed' || outcome?.error || outcome?.exitCode !== null && outcome?.exitCode !== 0) return 'failed'
  return active.spec.gate === 'approve' ? 'needs_approval' : 'ok'
}

export class JobRunner {
  private readonly jobs?: JobsRepository
  private readonly getSettings: () => AppSettings
  private readonly tierFallbacks: Partial<Record<ModelTier, string>>
  private readonly getActiveCompany: () => string | undefined
  private readonly homePath?: string
  private readonly skillsLibraryPath?: string
  private readonly spawn: SpawnFunction
  private readonly platform: NodeJS.Platform
  private readonly now: () => Date
  private readonly onEvent?: (event: JobEvent) => void
  private readonly chatProvider?: ChatProvider
  private readonly claudeBinary?: string
  private readonly codexBinary?: string
  private readonly reviewStepRunner?: ReviewStepRunner
  private readonly activeJobs = new Map<string, ActiveJob>()

  constructor(options: JobRunnerOptions = {}) {
    this.jobs = options.jobs
    this.getSettings = options.getSettings ?? (() => DEFAULT_SETTINGS)
    this.tierFallbacks = options.tierFallbacks ?? {}
    this.getActiveCompany = options.getActiveCompany ?? (() => undefined)
    this.homePath = options.homePath
    this.skillsLibraryPath = options.skillsLibraryPath
    this.spawn = options.spawn ?? (nodeSpawn as unknown as SpawnFunction)
    this.platform = options.platform ?? process.platform
    this.now = options.now ?? (() => new Date())
    this.onEvent = options.onEvent
    this.chatProvider = options.chatProvider
    this.claudeBinary = options.claudeBinary
    this.codexBinary = options.codexBinary
    this.reviewStepRunner = options.reviewStep ?? options.reviewRunner ?? options.review
  }

  resolveSkill(name: string, spec?: Pick<JobSpec, 'skillsLibraryPath'>): SkillResolution {
    const settings = this.getSettings()
    return resolveSkill(name, {
      skillsLibraryPath: spec?.skillsLibraryPath ?? this.skillsLibraryPath ?? settings.skillsLibraryPath,
      settings
    })
  }

  startJob(input: JobSpec): JobHandle {
    const id = safeJobId(input.id)
    const settings = this.getSettings()
    // Every job sees the company brain (the mirror of the vault's knowledge/ in Octa home) unless the
    // caller points elsewhere. Before this, no caller passed knowledgePath, so skills ran without it.
    const brainPath = join(resolve((input.homePath ?? this.homePath ?? settings.octaHomePath) || process.env.OCTA_HOME || DEFAULT_OCTA_HOME), 'knowledge')
    // The job's company folder (named, else the active company), else the knowledge root.
    const knowledgePath = existsSync(brainPath) ? knowledgePathFor(brainPath, input.company, this.getActiveCompany()) : undefined
    const spec: JobSpec = input.knowledgePath || !knowledgePath ? input : { ...input, knowledgePath }
    const skill = spec.skillPath
      ? (() => {
          const skillPath = resolve(spec.skillPath!)
          const skillMarkdown = readFileSync(join(skillPath, 'SKILL.md'), 'utf8')
          return {
            entry: { name: spec.skill ?? 'skill', folder: basename(skillPath) },
            skillPath,
            skillMarkdown,
            frontmatter: parseSkillFrontmatter(skillMarkdown),
            manifestPath: ''
          }
        })()
      : spec.skill
        ? this.resolveSkill(spec.skill, spec)
        : undefined
    const home = resolve((spec.homePath ?? this.homePath ?? settings.octaHomePath) || process.env.OCTA_HOME || DEFAULT_OCTA_HOME)
    const folder = join(home, 'jobs', id)
    writeJobFiles(folder, spec)
    if (skill) mountSkill(folder, skill.skillPath)
    else mkdirSync(join(folder, 'skill'), { recursive: true })
    const extraSkills = mountExtraSkills(folder, (spec.extraSkills ?? []).filter((name) => name !== skill?.entry.name), (name) => this.resolveSkill(name, spec), spec.runner.startsWith('claude'))
    const team = spec.runner.startsWith('claude')
      ? mountTeam(folder, spec.team ?? [], (name) => this.resolveSkill(name, spec), { lead: String(asRecord(spec.input)?.agent || 'the lead agent'), company: spec.company, knowledgePath: spec.knowledgePath })
      : []

    const emitter = new EventEmitter()
    const active: ActiveJob = {
      id,
      folder,
      spec,
      skill,
      extraSkills,
      team,
      emitter,
      controller: new AbortController(),
      cancelled: false,
      timedOut: false,
      overBudget: false,
      startedAtMs: Date.now(),
      totalUsage: emptyUsage(),
      reviewUsage: emptyUsage(),
      executorStructuredUsage: emptyUsage(),
      reviewAttempts: 0,
      collectedText: '',
      promise: Promise.resolve(undefined as never)
    }
    this.jobs?.createJob({
      id,
      workflowRunId: spec.workflowRunId,
      planId: spec.planId,
      workflow: spec.workflow,
      stepId: spec.stepId,
      skill: spec.skill,
      runner: spec.runner,
      department: spec.department,
      status: 'running',
      autonomy: spec.autonomy ?? 'assisted',
      gate: spec.gate ?? 'none',
      input: spec.input
    })
    this.activeJobs.set(id, active)
    const promise = this.execute(active)
    active.promise = promise
    const handle: JobHandle = {
      id,
      jobId: id,
      folder,
      promise,
      result: promise,
      events: emitter,
      onEvent: (listener) => {
        emitter.on('event', listener)
        return () => emitter.removeListener('event', listener)
      },
      cancel: () => this.cancel(id)
    }
    void handle
    return handle
  }

  async cancel(id: string): Promise<boolean> {
    const active = this.activeJobs.get(id)
    if (!active) return Boolean(this.jobs?.getJob(id))
    active.cancelled = true
    active.controller.abort(new Error('Job cancelled by the user.'))
    if (active.child) await killProcessTree(active.child, { platform: this.platform, spawn: this.spawn })
    await active.promise
    return true
  }

  async cancelAll(): Promise<void> {
    await Promise.all([...this.activeJobs.keys()].map((id) => this.cancel(id)))
  }

  getSettingsSnapshot(): AppSettings {
    return this.getSettings()
  }

  private emit(active: ActiveJob, value: JobEventPayload): JobEvent {
    const full = {
      ...value,
      jobId: active.id,
      timestamp: this.now().toISOString()
    } as JobEvent
    appendFileSync(join(active.folder, 'log.jsonl'), `${JSON.stringify(full)}\n`, 'utf8')
    if (value.type === 'text' || value.type === 'error') {
      const failure = classifyCliFailure(value.type === 'text' ? value.text : value.message)
      if (failure) active.cliFailure = failure
    }
    active.emitter.emit('event', full)
    this.onEvent?.(full)
    return full
  }

  private consumeParserEvents(active: ActiveJob, events: JobEvent[]): FinalJobStatus | undefined {
    let parserStatus: FinalJobStatus | undefined
    for (const parsed of events) {
      if (parsed.type === 'done') {
        parserStatus = parsed.status
        continue
      }
      if (parsed.type === 'text') {
        const text = parsed.text
        if (!text) continue
        const structured = structuredFromText(text)
        if (structured) active.lastStructured = structured
        let delta = text
        if (active.collectedText === text || active.collectedText.endsWith(text)) continue
        if (text.startsWith(active.collectedText)) delta = text.slice(active.collectedText.length)
        active.collectedText += delta
        if (delta) this.emit(active, { type: 'text', text: delta })
        continue
      }
      if (parsed.type === 'usage') {
        active.totalUsage.inputTokens = Math.max(active.totalUsage.inputTokens, parsed.inputTokens ?? 0)
        active.totalUsage.outputTokens = Math.max(active.totalUsage.outputTokens, parsed.outputTokens ?? 0)
        active.totalUsage.cachedInputTokens = Math.max(active.totalUsage.cachedInputTokens, parsed.cachedInputTokens ?? 0)
        active.totalUsage.costUsd = Math.max(active.totalUsage.costUsd, parsed.costUsd ?? 0)
        this.emit(active, {
          type: 'usage',
          inputTokens: parsed.inputTokens,
          outputTokens: parsed.outputTokens,
          cachedInputTokens: parsed.cachedInputTokens,
          costUsd: parsed.costUsd
        })
        const budget = active.spec.inputTokenBudget ?? (active.spec.runner === 'codex-scout' ? DEFAULT_SCOUT_TOKEN_BUDGET : DEFAULT_SKILL_TOKEN_BUDGET)
        if ((parsed.inputTokens ?? 0) > budget) {
          active.overBudget = true
          active.lastError = `Input token budget exceeded (${parsed.inputTokens} > ${budget}).`
          this.emit(active, { type: 'error', message: active.lastError })
          if (active.child) void killProcessTree(active.child, { platform: this.platform, spawn: this.spawn })
        }
        continue
      }
      if (parsed.type === 'error') {
        this.emit(active, { type: 'error', message: parsed.message, code: parsed.code })
      } else if (parsed.type === 'tool') {
        this.emit(active, {
          type: 'tool',
          name: parsed.name,
          phase: parsed.phase,
          input: parsed.input,
          output: parsed.output
        })
      }
    }
    return parserStatus
  }

  private async execute(active: ActiveJob): Promise<JobResult> {
    let outcome: ProcessOutcome | undefined
    try {
      if (active.spec.runner === 'gemini-inline') {
        outcome = await this.executeGemini(active)
      } else {
        outcome = await this.executeSubprocessWithRetries(active)
        const acceptance = acceptanceFor(active.spec)
        const shouldReview = isReviewedExecutor(active.spec.runner)
          && (acceptance.length > 0 || Boolean(this.reviewStepRunner))
          && !active.cancelled
          && !active.timedOut
          && !active.overBudget
          && !active.spec.skipReview
          && !outcome.error
          && outcome.exitCode === 0
        if (shouldReview) {
          const firstResult = this.buildResult(active, finalStatusFor(active, outcome), outcome)
          writeJsonFile(join(active.folder, 'result.json'), firstResult)
          const firstReview = await this.reviewExecutorStep(active, firstResult)
          if (firstReview.verdict === 'revise' && !active.cancelled && !active.timedOut && !active.overBudget) {
            // The reviewer-driven correction is deliberately a single extra
            // executor pass. Ordinary subprocess retries remain governed by
            // the existing spec-001 retry policy.
            clearAgentResultFiles(active.folder)
            active.collectedText = ''
            active.lastStructured = undefined
            active.lastError = undefined
            outcome = await this.executeSubprocessWithRetries(active, firstReview)
            const secondResult = this.buildResult(active, finalStatusFor(active, outcome), outcome)
            writeJsonFile(join(active.folder, 'result.json'), secondResult)
            if (!active.cancelled && !active.timedOut && !active.overBudget) {
              await this.reviewExecutorStep(active, secondResult)
            }
          }
        }
      }
    } catch (error) {
      active.lastError = errorMessage(error)
      this.emit(active, { type: 'error', message: active.lastError })
      outcome = { exitCode: 1, signal: null, error: active.lastError }
    }

    const status = finalStatusFor(active, outcome)
    const result = this.buildResult(active, status, outcome, active.reviewAttempts === 0)
    writeJsonFile(join(active.folder, 'result.json'), result)
    this.jobs?.updateJob(active.id, {
      status,
      result,
      sourceCount: result.metrics.source_count,
      review: active.review ?? undefined,
      cost: costRecord(active),
      finishedAt: this.now().toISOString(),
      error: status === 'failed' || status === 'needs_input' ? active.lastError ?? null : null
    })
    this.emit(active, { type: 'done', status, result })
    this.activeJobs.delete(active.id)
    return result
  }

  private async reviewExecutorStep(active: ActiveJob, result: JobResult): Promise<ReviewRunResult> {
    const acceptance = acceptanceFor(active.spec)
    const job: ReviewJob = {
      id: active.id,
      jobId: active.id,
      folder: active.folder,
      workspace: active.folder,
      resultPath: join(active.folder, 'result.json'),
      result,
      outputs: result.outputs
    }
    const step: ReviewStepDefinition = {
      id: active.spec.stepId ?? '',
      stepId: active.spec.stepId ?? '',
      runner: active.spec.runner,
      acceptance,
      acceptanceCriteria: acceptance,
      input: active.spec.input,
      outputs: result.outputs
    }
    const raw = this.reviewStepRunner
      ? await this.reviewStepRunner(job, step)
      : await runReviewStep(job, step, {
          spawn: this.spawn,
          codexBinary: this.codexBinary,
          platform: this.platform
        })
    const review = normalizeReviewRunResult(raw, acceptance)
    const decision: ReviewResult = {
      verdict: review.verdict,
      issues: review.issues,
      ...(review.fixed_output_path ? { fixed_output_path: review.fixed_output_path } : {})
    }
    active.reviewAttempts += 1
    const usage = reviewUsage(review)
    addUsage(active.reviewUsage, usage)
    addUsage(active.totalUsage, usage)
    active.review = decision
    writeJsonFile(join(active.folder, 'review.json'), decision)
    this.jobs?.updateJob(active.id, { review: decision, cost: costRecord(active) })
    return review
  }

  private async executeGemini(active: ActiveJob): Promise<ProcessOutcome> {
    const provider = active.spec.chatProvider ?? this.chatProvider ?? new GeminiChatProvider(requireAiAuth(this.getSettings()))
    const prompt = renderPrompt(active.spec, active.folder, active.skill) + renderExtraSkills(active.spec, active.extraSkills) + renderTeam(active.team)
    const messages = active.spec.messages ?? [{ role: 'user', content: prompt }]
    const timeoutMs = this.remainingBudget(active)
    let timer: ReturnType<typeof setTimeout> | undefined
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        active.timedOut = true
        active.lastError = `Time budget exceeded after ${Math.round((active.spec.timeBudgetMs ?? DEFAULT_JOB_TIME_BUDGET_MS) / 1_000)} seconds.`
        active.controller.abort(new Error(active.lastError!))
      }, timeoutMs)
    }
    try {
      const response = await provider.send(messages, active.spec.tools ?? [], active.controller.signal)
      if (response.text) {
        active.collectedText = response.text
        this.emit(active, { type: 'text', text: response.text })
      }
      for (const call of response.calls) this.emit(active, { type: 'tool', name: call.name, phase: 'complete', input: call.args })
      return { exitCode: 0, signal: null }
    } catch (error) {
      if (!active.cancelled && !active.timedOut) active.lastError = errorMessage(error)
      return { exitCode: 1, signal: null, error: active.lastError ?? errorMessage(error) }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private remainingBudget(active: ActiveJob): number | undefined {
    const budget = active.spec.timeBudgetMs ?? DEFAULT_JOB_TIME_BUDGET_MS
    return Math.max(1, budget - (Date.now() - active.startedAtMs))
  }

  private async executeSubprocessWithRetries(
    active: ActiveJob,
    review?: ReviewResult
  ): Promise<ProcessOutcome> {
    const normalAttempts = 1 + Math.max(0, Math.min(2, Math.trunc(active.spec.maxRetries ?? 1)))
    let retryError: string | undefined
    let attempt = 0
    let lastOutcome: ProcessOutcome = { exitCode: 1, signal: null, error: 'Runner did not start.' }
    while (attempt < Math.max(normalAttempts, 3)) {
      attempt += 1
      if (active.cancelled || active.timedOut || active.overBudget) break
      active.cliFailure = undefined
      lastOutcome = await this.executeSubprocess(active, retryError, review)
      if (!lastOutcome.error && lastOutcome.exitCode === 0) return lastOutcome
      if (active.cancelled || active.timedOut || active.overBudget) break
      retryError = lastOutcome.error ?? `Process exited with code ${lastOutcome.exitCode}.`
      const failure = active.cliFailure ?? classifyCliFailure(retryError)
      const fallback = active.tierModel?.fallbackModel
      if (fallbackCanHelp(failure) && fallback && !active.modelOverride && fallback !== active.tierModel?.model) {
        // The CLI works but rejected this model: one extra attempt on the tier's fallback model.
        active.modelOverride = fallback
        this.emit(active, { type: 'error', message: `Model ${active.tierModel?.model} unavailable (${failure?.kind}); retrying on ${fallback}. ${failure?.fix ?? ''}`.trim() })
        attempt -= 1
        continue
      }
      // Signing in or updating the CLI is on the owner; retrying the same call cannot succeed.
      if (failure?.kind === 'auth' || failure?.kind === 'cli_outdated' || failure?.kind === 'model_unavailable') break
      const capacity = isCapacityError(retryError)
      const maxCapacityAttempts = 3
      const canRetryCapacity = capacity && attempt < maxCapacityAttempts
      const canRetryRegular = !capacity && attempt < normalAttempts
      if (!canRetryCapacity && !canRetryRegular) break
      const delay = active.spec.retryDelayMs ?? (capacity ? (active.spec.runner.startsWith('claude') ? RATE_LIMIT_RETRY_DELAYS_MS.claude : RATE_LIMIT_RETRY_DELAYS_MS.codex) : 0)
      this.emit(active, { type: 'error', message: `Retrying attempt ${attempt + 1}: ${retryError}` })
      if (delay > 0) {
        try {
          await this.delay(delay, active.controller.signal)
        } catch {
          break
        }
      }
    }
    if (lastOutcome.error && !active.timedOut && !active.overBudget) active.lastError = lastOutcome.error
    return lastOutcome
  }

  private delay(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolveDelay, rejectDelay) => {
      if (signal.aborted) {
        rejectDelay(signal.reason)
        return
      }
      const timer = setTimeout(resolveDelay, milliseconds)
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        rejectDelay(signal.reason)
      }, { once: true })
    })
  }

  private commandFor(active: ActiveJob): { executable: string; argv: string[]; parser: 'claude' | 'codex' } {
    const runner = active.spec.runner
    const parser = runner.startsWith('claude') ? 'claude' : 'codex'
    const context: JobRunnerArgvContext = {
      workspace: active.folder,
      skillPath: active.skill?.skillPath,
      allowedTools: active.skill?.frontmatter.allowedTools.length
        ? active.skill.frontmatter.allowedTools
        : undefined,
      systemPromptFile: runner === 'claude-plan' ? 'planner.md' : undefined,
      outputSchema: runner === 'codex-exec' || runner === 'codex-scout' ? 'result.schema.json' : runner === 'codex-critic' ? 'critique.schema.json' : 'review.schema.json'
    }
    context.extraSkillPaths = [...new Set([
      ...(active.extraSkills ?? []).flatMap((item) => item.skill ? [item.skill.skillPath] : []),
      // Team specialists read their skills' references and the company brain.
      ...(active.team ?? []).flatMap((item) => item.skills.map((skill) => skill.skillPath)),
      ...(active.team?.length && active.spec.knowledgePath ? [active.spec.knowledgePath] : [])
    ])]
    if (active.spec.network) context.network = true
    const tier = tierForRunner(runner, active.spec.tier)
    if (tier) {
      const resolved = resolveTier(tier, this.getSettings().phaseModels)
      const fallbackModel = this.tierFallbacks[tier] ?? resolved.fallbackModel
      active.tierModel = { ...resolved, ...(fallbackModel && fallbackModel !== resolved.model ? { fallbackModel } : {}) }
      context.model = { model: active.modelOverride ?? active.tierModel.model, effort: active.tierModel.effort }
    }
    const argv = active.spec.argsOverride ?? buildRunnerArgv(runner, context, active.spec.autonomy)
    const executable = active.spec.executable ?? (parser === 'claude'
      ? this.claudeBinary ?? resolveCliBinary('claude')
      : this.codexBinary ?? resolveCliBinary('codex'))
    if (!executable) throw new Error(`${parser === 'claude' ? 'Claude Code' : 'Codex'} CLI was not found. Install it and sign in before starting a job.`)
    return { executable, argv, parser }
  }

  private async executeSubprocess(
    active: ActiveJob,
    retryError?: string,
    review?: ReviewResult
  ): Promise<ProcessOutcome> {
    const command = this.commandFor(active)
    const prompt = renderPrompt(active.spec, active.folder, active.skill, retryError, review) + renderExtraSkills(active.spec, active.extraSkills) + renderTeam(active.team)
    let child: ChildProcess
    try {
      child = this.spawn(command.executable, command.argv, {
        cwd: active.folder,
        env: { ...process.env, ...active.spec.environment },
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (error) {
      return { exitCode: 1, signal: null, error: errorMessage(error) }
    }
    active.child = child
    return new Promise<ProcessOutcome>((resolveOutcome) => {
      let settled = false
      let stdoutBuffer = ''
      let stdoutWhole = ''
      let stderrBuffer = ''
      let parserStatus: FinalJobStatus | undefined
      let processError: string | undefined
      const budget = this.remainingBudget(active)
      let budgetTimer: ReturnType<typeof setTimeout> | undefined
      let hardKillTimer: ReturnType<typeof setTimeout> | undefined

      const settle = (outcome: ProcessOutcome): void => {
        if (settled) return
        settled = true
        if (budgetTimer) clearTimeout(budgetTimer)
        if (hardKillTimer) clearTimeout(hardKillTimer)
        active.child = undefined
        resolveOutcome({ ...outcome, parserStatus })
      }
      const requestKill = (timedOut: boolean): void => {
        if (timedOut) {
          active.timedOut = true
          active.lastError = `Time budget exceeded after ${Math.round((active.spec.timeBudgetMs ?? DEFAULT_JOB_TIME_BUDGET_MS) / 1_000)} seconds.`
        }
        this.emit(active, { type: 'error', message: active.lastError ?? 'Stopping the job process.' })
        if (child) void killProcessTree(child, { platform: this.platform, spawn: this.spawn })
        hardKillTimer = setTimeout(() => settle({ exitCode: null, signal: null, error: active.lastError }), 1_900)
      }

      const consumeLine = (line: string): void => {
        if (!line.trim()) return
        const parsed = command.parser === 'claude'
          ? parseClaudeStreamJson(line)
          : parseCodexJsonLines(line)
        const status = this.consumeParserEvents(active, parsed)
        if (status) parserStatus = status
      }
      const consumeStdout = (chunk: Buffer): void => {
        const text = chunk.toString('utf8')
        stdoutWhole += text
        if (command.parser === 'claude' && active.spec.runner === 'claude-plan') return
        stdoutBuffer += text
        const lines = stdoutBuffer.split(/\r?\n/)
        stdoutBuffer = lines.pop() ?? ''
        for (const line of lines) consumeLine(line)
      }
      const flushStdout = (): void => {
        if (command.parser === 'claude' && active.spec.runner === 'claude-plan') {
          try {
            const parsed = parseClaudeEvent(JSON.parse(stdoutWhole) as unknown)
            const status = this.consumeParserEvents(active, parsed)
            if (status) parserStatus = status
          } catch {
            if (stdoutWhole.trim()) {
              const structured = structuredFromText(stdoutWhole)
              if (structured) {
                active.collectedText = stdoutWhole.trim()
                this.emit(active, { type: 'text', text: stdoutWhole.trim() })
              }
            }
          }
          return
        }
        if (stdoutBuffer.trim()) consumeLine(stdoutBuffer)
      }

      child.stdout?.on('data', consumeStdout)
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrBuffer += chunk.toString('utf8')
        const lines = stderrBuffer.split(/\r?\n/)
        stderrBuffer = lines.pop() ?? ''
        for (const line of lines) {
          if (line.trim()) this.emit(active, { type: 'error', message: line.trim() })
        }
      })
      child.once('error', (error) => {
        processError = errorMessage(error)
        if (!active.timedOut && !active.cancelled) this.emit(active, { type: 'error', message: processError })
        settle({ exitCode: 1, signal: null, error: processError })
      })
      child.once('close', (code, signal) => {
        flushStdout()
        if (stderrBuffer.trim()) this.emit(active, { type: 'error', message: stderrBuffer.trim() })
        const exitText = `exit code ${code ?? 'unknown'}${signal ? `, ${signal}` : ''}`
        // Prefer the CLI's own reason ("API Error: 401 …", "does not support this model …") over the bare exit code.
        const error = processError ?? (active.cancelled ? undefined : code === 0 ? undefined : active.cliFailure
          ? `${active.cliFailure.message} (${exitText}).`
          : `Process exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}.`)
        settle({ exitCode: code, signal, error })
      })

      if (budget !== undefined) budgetTimer = setTimeout(() => requestKill(true), budget)
      try {
        child.stdin?.end(prompt, 'utf8')
      } catch (error) {
        processError = errorMessage(error)
        requestKill(false)
      }
    })
  }

  private buildResult(
    active: ActiveJob,
    status: FinalJobStatus,
    outcome?: ProcessOutcome,
    captureExecutorMetrics = true
  ): JobResult {
    const disk = agentResultFile(active.folder)
    const structured = disk ?? active.lastStructured ?? structuredFromText(active.collectedText) ?? {}
    const sourceCount = numberValue(asRecord(structured.metrics)?.source_count) ?? countSources(active.folder)
    const seconds = Math.max(0, (Date.now() - active.startedAtMs) / 1_000)
    let notes = textValue(structured.notes) ?? ''
    if (active.timedOut) notes = `${active.lastError ?? 'Time budget exceeded.'}${active.collectedText ? ` Partial output: ${active.collectedText.slice(0, 4_000)}` : ''}`
    else if (active.overBudget) notes = `${active.lastError ?? 'Input token budget exceeded.'}${active.collectedText ? ` Partial output: ${active.collectedText.slice(0, 4_000)}` : ''}`
    else if (status === 'failed' && !notes) notes = active.lastError ?? outcome?.error ?? 'The runner failed.'
    else if (!notes && active.collectedText && !Array.isArray(structured.outputs)) notes = active.collectedText.slice(0, 4_000)
    const metricsRecord = asRecord(structured.metrics)
    const outputs = Array.isArray(structured.outputs)
      ? structured.outputs.filter((value): value is { path: string; type: string; title: string } => {
          const item = asRecord(value)
          return typeof item?.path === 'string' && typeof item.type === 'string' && typeof item.title === 'string'
        })
      : listOutputFiles(active.folder)
    if (captureExecutorMetrics) {
      active.executorStructuredUsage.inputTokens = Math.max(
        active.executorStructuredUsage.inputTokens,
        usageNumber(metricsRecord?.tokens_in)
      )
      active.executorStructuredUsage.outputTokens = Math.max(
        active.executorStructuredUsage.outputTokens,
        usageNumber(metricsRecord?.tokens_out)
      )
      active.executorStructuredUsage.costUsd = Math.max(
        active.executorStructuredUsage.costUsd,
        usageNumber(metricsRecord?.cost_usd)
      )
    }
    const executorInputTokens = Math.max(
      Math.max(0, active.totalUsage.inputTokens - active.reviewUsage.inputTokens),
      active.executorStructuredUsage.inputTokens
    )
    const executorOutputTokens = Math.max(
      Math.max(0, active.totalUsage.outputTokens - active.reviewUsage.outputTokens),
      active.executorStructuredUsage.outputTokens
    )
    const executorCostUsd = Math.max(
      Math.max(0, active.totalUsage.costUsd - active.reviewUsage.costUsd),
      active.executorStructuredUsage.costUsd
    )
    const result: JobResult = {
      job_id: active.id,
      step_id: active.spec.stepId ?? '',
      status,
      outputs,
      sources: typeof structured.sources === 'string' ? structured.sources : 'evidence/sources.jsonl',
      metrics: {
        source_count: sourceCount,
        languages: Array.isArray(metricsRecord?.languages)
          ? metricsRecord.languages.filter((value): value is string => typeof value === 'string')
          : [],
        tokens_in: executorInputTokens + active.reviewUsage.inputTokens,
        tokens_out: executorOutputTokens + active.reviewUsage.outputTokens,
        seconds,
        cost_usd: roundCost(executorCostUsd + active.reviewUsage.costUsd)
      },
      questions: Array.isArray(structured.questions) ? structured.questions : [],
      notes
    }
    if (status === 'needs_input' && result.questions.length === 0) {
      result.questions = [{ id: 'runner', text: active.lastError ?? 'More information is needed to continue.', blocking: true }]
    }
    return result
  }
}

let defaultRunner: JobRunner | undefined
let defaultRepository: JobsRepository | undefined

export function configureJobRunner(options: JobRunnerOptions = {}): JobRunner {
  defaultRepository?.close()
  defaultRepository = undefined
  defaultRunner = new JobRunner(options)
  return defaultRunner
}

export function getJobRunner(): JobRunner {
  if (defaultRunner) return defaultRunner
  const home = process.env.OCTA_HOME?.trim() || DEFAULT_OCTA_HOME
  defaultRepository = new JobsRepository(join(home, 'octa.db'))
  defaultRunner = new JobRunner({ homePath: home, jobs: defaultRepository })
  return defaultRunner
}

export function closeDefaultJobRunner(): void {
  defaultRepository?.close()
  defaultRepository = undefined
  defaultRunner = undefined
}

export function startJob(spec: JobSpec): JobHandle {
  return getJobRunner().startJob(spec)
}

export function runSkill(request: RunSkillRequest, options?: JobRunnerOptions): JobHandle {
  const runner = options ? new JobRunner(options) : getJobRunner()
  const resolution = resolveSkill(request.name, {
    skillsLibraryPath: request.skillsLibraryPath ?? options?.skillsLibraryPath,
    settings: runner.getSettingsSnapshot()
  })
  const manifestRunner = runnerForSkill(
    resolution.entry.folder,
    resolution.frontmatter.runner,
    resolution.entry.runner
  )
  return runner.startJob({
    runner: request.runner ?? manifestRunner,
    skill: request.name,
    skillPath: resolution.skillPath,
    input: request.input,
    department: request.department,
    autonomy: request.autonomy,
    gate: request.gate,
    language: request.language,
    homePath: request.homePath,
    skillsLibraryPath: request.skillsLibraryPath,
    timeBudgetMs: request.timeBudgetMs,
    maxRetries: request.maxRetries
  })
}

// Compatibility aliases make the parser helpers convenient to consume from tests and future specs.
export function parseClaudeJson(output: string): JobEvent[] {
  try {
    return parseClaudeEvent(JSON.parse(output) as unknown)
  } catch {
    return parseClaudeStreamJson(output)
  }
}
export const parseCodexJson = parseCodexJsonLines

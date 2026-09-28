import { DEFAULT_PHASE_MODELS, type PhaseModels } from './core/octa/models'
export type ThemeMode = 'dark' | 'light'
export type Locale = 'ar' | 'en'
export type AiProvider = 'gemini' | 'vertex'
export type TranscriptionLanguage = 'auto' | 'ar' | 'en'
export type TriggerType = 'keyboard' | 'mouse'
export type MouseTriggerButton = 3 | 4 | 5
export type VoiceLanguage = 'ar-EG' | 'en' | 'mixed'
export type VoicePhase = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error'

export interface VoiceState {
  phase: VoicePhase
  source: 'wake-word' | 'push-to-talk' | null
  transcript: string
  language: VoiceLanguage | null
  model: string | null
  error?: string
}

export interface VoiceTranscriptEvent {
  text: string
  final: boolean
  source: 'user' | 'assistant'
  languageHint?: string
}

export interface VoiceAudioEvent {
  data: string
  mimeType: string
}

export type JobRunnerName =
  | 'claude-plan'
  | 'claude-skill'
  | 'codex-exec'
  | 'codex-scout'
  | 'codex-critic'
  | 'codex-review'
  | 'octa-code'
  | 'workflow'
  | 'gemini-inline'

/** Final job states plus the transient state shown while a subprocess runs. */
export type JobStatus = 'running' | 'ok' | 'failed' | 'needs_approval' | 'needs_input' | 'cancelled' | 'stale'
export type JobAutonomy = 'led' | 'assisted' | 'auto'
export type JobGate = 'none' | 'review' | 'approve'

export interface JobOutput {
  path: string
  type: string
  title: string
}

export interface JobMetrics {
  source_count: number
  languages?: string[]
  tokens_in: number
  tokens_out: number
  seconds: number
  cost_usd?: number
}

export interface JobResult {
  job_id: string
  step_id: string
  status: Exclude<JobStatus, 'running'>
  outputs: JobOutput[]
  sources: string
  metrics: JobMetrics
  questions: unknown[]
  notes: string
}

export type TaskStatus = 'inbox' | 'todo' | 'doing' | 'done' | 'dropped'
export type TaskSource = 'manual' | 'voice' | 'screenshot' | 'text' | 'phone' | 'link'

export const TASK_STATUSES: readonly TaskStatus[] = [
  'inbox',
  'todo',
  'doing',
  'done',
  'dropped'
]

export interface TaskRecord {
  id: string
  title: string
  notes: string
  project: string
  status: TaskStatus
  priority: number
  dueAt: number | null
  estimateMinutes: number | null
  trackedSeconds: number
  runningSince: number | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
  source: TaskSource
  vaultNote: string | null
}

export interface TaskSession {
  id: string
  taskId: string
  startedAt: number
  endedAt: number | null
}

export interface TaskFilter {
  status?: TaskStatus
  project?: string
  query?: string
}

export interface NewTask {
  title: string
  notes?: string
  project?: string
  status?: TaskStatus
  priority?: number
  dueAt?: number | null
  estimateMinutes?: number | null
  source?: TaskSource
  vaultNote?: string | null
}

export interface DocumentBrand {
  id: string
  label: string
  name: string
  tagline: string
  website: string
  signatureName: string
  signatureRole: string
  signatureImage: string | null
  signatureWidthMm: number
  accent: string
  isDefault: boolean
}

export const DEFAULT_BRAND: Omit<DocumentBrand, 'id'> = {
  label: 'Tamim Works',
  name: 'ABDULLAH TAMIM',
  tagline: 'BUSINESS DOCUMENT SYSTEM',
  website: 'tamim.works',
  signatureName: '\u0639\u0628\u062f\u0627\u0644\u0644\u0647 \u062a\u0645\u064a\u0645',
  signatureRole: '\u0645\u0637\u0648\u0651\u0631 \u0648\u0645\u0635\u0645\u0651\u0645 \u0645\u0646\u062a\u062c\u0627\u062a \u0631\u0642\u0645\u064a\u0629',
  signatureImage: null,
  signatureWidthMm: 50,
  accent: '#f25b1b',
  isDefault: true
}

export type DocumentKind = 'invoice' | 'contract' | 'proposal'

export interface DocumentRecord {
  id: string
  kind: DocumentKind
  clientId: string | null
  clientName: string
  brandId: string
  reference: string
  title: string
  fields: Record<string, unknown>
  overrides: Record<string, string>
  createdAt: number
  updatedAt: number
  pdfPath: string | null
}

export interface TimeUsageEntry {
  name: string
  seconds: number
}

export interface TimeReport {
  day: string
  available: boolean
  reason?: string
  totalSeconds: number
  apps: TimeUsageEntry[]
  titles: TimeUsageEntry[]
}

export interface SavedLink {
  id: string
  url: string
  title: string
  summary: string
  tags: string[]
  project: string
  createdAt: number
  notePath: string | null
  readable: boolean
}

export interface ClientRecord {
  id: string
  name: string
  email: string
  phone: string
  vaultNote: string | null
  createdAt: number
  notionPageId: string | null
}

export type InvoiceCurrency = 'EGP' | 'USD'
export type InvoiceStoredStatus = 'draft' | 'sent' | 'paid'
export type InvoiceDisplayStatus = InvoiceStoredStatus | 'overdue'

export interface InvoiceItem {
  id?: string
  description: string
  qty: number
  unitPrice: number
}

export interface InvoiceRecord {
  id: string
  clientId: string
  clientName: string
  number: string
  currency: InvoiceCurrency
  issuedAt: number
  dueAt: number
  status: InvoiceDisplayStatus
  storedStatus: InvoiceStoredStatus
  notes: string
  paymentLink: string
  projectNote: string | null
  items: InvoiceItem[]
  total: number
  notionPageId: string | null
}

export interface JobRecord {
  id: string
  workflowRunId: string | null
  planId: string | null
  workflow: string | null
  stepId: string | null
  skill: string | null
  runner: JobRunnerName | string
  department: string | null
  status: JobStatus
  autonomy: JobAutonomy | null
  gate: JobGate | null
  input: unknown
  result: unknown
  review: unknown
  sourceCount: number
  cost: unknown
  startedAt: string | null
  finishedAt: string | null
  approvedBy: string | null
  approvedAt: string | null
  error: string | null
  state: unknown
  gatePayload: unknown
  gateCreatedAt: string | null
  gateExpiresAt: string | null
  gateDecision: string | null
  gateComments: string | null
  attempt: number
}

export interface JobStartRequest {
  id?: string
  workflowRunId?: string | null
  runner: JobRunnerName
  skill?: string
  input?: unknown
  acceptance?: readonly string[]
  acceptanceCriteria?: readonly string[]
  prompt?: string
  brief?: string
  planId?: string | null
  workflow?: string | null
  stepId?: string | null
  department?: string | null
  autonomy?: JobAutonomy
  gate?: JobGate
  language?: string
  timeBudgetMs?: number
  inputTokenBudget?: number
  maxRetries?: number
  retryDelayMs?: number
  /** Workflow orchestration keeps review in spec 006 so it can persist gate state. */
  skipReview?: boolean
  /** Model tier chosen by the planner for this step; falls back to the runner's default tier. */
  tier?: ModelTier
  /** Company this job works for (knowledge/companies/<slug>); the active company when absent. */
  company?: string
  /** More skills the job may use besides `skill` (Claude: sub-agents; Codex: inlined). */
  extraSkills?: string[]
  /** Specialists that work only under this job's agent (Claude sub-agents, reviewed by the lead). */
  team?: SubAgentSpec[]
  /** Allow network access inside the Codex sandbox (web research, site checks). */
  network?: boolean
}

export interface JobStartResponse {
  id: string
  folder: string
}

export interface JobTextEvent {
  type: 'text'
  jobId: string
  timestamp: string
  text: string
}

export interface JobToolEvent {
  type: 'tool'
  jobId: string
  timestamp: string
  name: string
  phase?: 'start' | 'complete'
  input?: unknown
  output?: unknown
}

export interface JobUsageEvent {
  type: 'usage'
  jobId: string
  timestamp: string
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  costUsd?: number
}

export interface JobErrorEvent {
  type: 'error'
  jobId: string
  timestamp: string
  message: string
  code?: string | number
}

export interface JobDoneEvent {
  type: 'done'
  jobId: string
  timestamp: string
  status: Exclude<JobStatus, 'running'>
  result?: JobResult
}

export type JobEvent = JobTextEvent | JobToolEvent | JobUsageEvent | JobErrorEvent | JobDoneEvent

export interface AiTestResult {
  provider: string
  model: string
  latencyMs: number
}

export type UpdateStatus = 'available' | 'current' | 'error' | 'unconfigured'

export interface AppUpdate {
  status: UpdateStatus
  currentVersion: string
  repository: string
  checkedAt: string
  latestVersion?: string
  releaseUrl?: string
  downloadUrl?: string
  /** browser_download_url of the release's app-update.json when the release carries an app-only update. */
  appUpdateUrl?: string
  error?: string
}

export type UpdateProgressPhase = 'idle' | 'checking' | 'available' | 'current' | 'downloading' | 'downloaded' | 'error' | 'unsupported'

/** Live state of the in-app differential download (electron-updater). */
export interface UpdateProgress {
  phase: UpdateProgressPhase
  currentVersion: string
  version?: string
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
  /** True when only the changed blocks of the installer were downloaded. */
  differential: boolean
  /** 'app' = small app-only asar swap; 'full' = installer via electron-updater. */
  mode?: 'app' | 'full'
  error?: string
  updatedAt?: number
}

/** Settings that belong to the Octa foundation and are safe to expose to the renderer. */
/** Model roles. Code names a tier; the concrete model comes from settings (spec 018). */
export type ModelTier = 'manager' | 'critic' | 'executor' | 'executor-fast' | 'reviewer' | 'claude-tools'


export type AgentTrustStage = 'draft-only' | 'approve-each' | 'auto'

/** What W7 (or the owner) specifies for a new agent. */
/**
 * A specialist that works ONLY under its lead agent (owner request, 2026-09-28): it is never in the
 * agent lineup, never runs on its own, takes a brief from the lead, and its draft is reviewed by the
 * lead against its checklist before it reaches the owner.
 */
export interface SubAgentSpec {
  /** File-safe id: lowercase latin, digits, dashes (it becomes .claude/agents/<slug>.md). */
  slug: string
  name: string
  role: string
  scope: string
  definitionOfDone: string
  skills: string[]
  /** What the lead checks before accepting this specialist's work. */
  checklist: string[]
  /** research specialists may browse the web; writers only read the brain and write drafts. */
  tools: 'write' | 'research'
}

export interface AgentSpec {
  name: string
  identity: string
  scope: string
  definitionOfDone: string
  skills: string[]
  tier: ModelTier
  trustStage: AgentTrustStage
  schedule?: 'daily' | 'weekly' | 'monthly'
  /** Department the agent reports into under Octa (e.g. marketing, development). */
  department?: string
  /** Specialists that work only under this agent, reviewed by it (see SubAgentSpec). */
  team?: SubAgentSpec[]
}

export interface AgentRecord extends AgentSpec {
  id: string
  department: string
  status: 'active' | 'paused'
  createdFrom: string | null
  createdAt: string
  updatedAt: string
  cleanStreak: number
  runs: number
  cleanRuns: number
  /** A promotion Octa proposes after a clean streak; applied only when the owner approves. */
  pendingPromotion?: AgentTrustStage
  lastDemotion?: { at: string; from: AgentTrustStage; to: AgentTrustStage; reason: string }
}

export interface AgentRunRecord {
  agentId: string
  jobId: string
  startedAt: string
  result: AgentOutcome['result']
  reason?: string
  /** Task on the Tasks page this run was delegated from. */
  taskId?: string
}

export interface AgentOutcome {
  result: 'clean' | 'rejected' | 'failed' | 'pending'
  reason?: string
}

export interface AppSettings {
  geminiApiKey: string
  groqApiKey: string
  aiProvider: AiProvider
  vertexKeyPath: string
  vertexProjectId: string
  vertexLocation: string
  ntfyTopic: string
  ntfyServer: string
  octaHomePath: string
  updateRepository: string
  skillsLibraryPath: string
  vaultPath: string
  photoshopPath: string
  braveSearchApiKey: string
  theme: ThemeMode
  locale: Locale
  /** The most recently selected native-audio model returned by the model list. */
  geminiLiveModel: string
  /** A non-empty value wins over automatic model selection. */
  geminiLiveModelOverride: string
  wakeWordEnabled: boolean
  wakeWordModelPath: string
  wakeWordSensitivity: number
  pushToTalkEnabled: boolean
  pushToTalkKey: string
  /** Compatibility alias used by the copied global trigger module. */
  hotkey: string
  triggerType: TriggerType
  mouseButton: MouseTriggerButton
  wakeGreeting: string
  /** Model and reasoning level for each phase of the build/workflow engine (Settings → Models). */
  phaseModels: PhaseModels
  /** Octa's spoken voice (Gemini prebuilt voice). */
  voiceName: VoiceName
  /** Whole-interface zoom (1 = original size). */
  uiScale: number
}

/** Warm, natural Gemini voices offered in Settings; Sulafat is the default partner voice. */
export const VOICE_NAMES = ['Sulafat', 'Aoede', 'Despina', 'Achernar', 'Vindemiatrix', 'Callirrhoe', 'Leda', 'Kore', 'Gacrux'] as const
export type VoiceName = (typeof VOICE_NAMES)[number]
export const UI_SCALES = [1, 1.1, 1.2, 1.3, 1.4] as const

export const DEFAULT_SETTINGS: AppSettings = {
  geminiApiKey: '',
  groqApiKey: '',
  aiProvider: 'gemini',
  vertexKeyPath: '',
  vertexProjectId: '',
  vertexLocation: 'global',
  ntfyTopic: '',
  ntfyServer: 'https://ntfy.sh',
  octaHomePath: 'C:\\Octa',
  updateRepository: 'abdutamim/octa',
  skillsLibraryPath: '',
  vaultPath: '',
  photoshopPath: '',
  braveSearchApiKey: '',
  theme: 'dark',
  locale: 'ar',
  geminiLiveModel: '',
  geminiLiveModelOverride: '',
  wakeWordEnabled: true,
  wakeWordModelPath: 'C:\\Octa\\models\\octa.onnx',
  wakeWordSensitivity: 0.55,
  pushToTalkEnabled: true,
  pushToTalkKey: 'CommandOrControl+Alt+Space',
  hotkey: 'CommandOrControl+Alt+Space',
  triggerType: 'keyboard',
  mouseButton: 4,
  wakeGreeting: 'إيه يا عميل، عايز إيه؟',
  phaseModels: DEFAULT_PHASE_MODELS,
  voiceName: 'Sulafat',
  uiScale: 1.2
}

export interface RendererState {
  settings: AppSettings
  firstRun: boolean
  version: string
}

export interface VaultHit {
  path: string
  title: string
  excerpt: string
}

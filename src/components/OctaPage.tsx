import {
  AlertCircle,
  ArrowUpRight,
  Bot,
  Check,
  CheckCircle2,
  Circle,
  CircleDashed,
  FileCode2,
  FileText,
  FolderOpen,
  LoaderCircle,
  MessageCircle,
  Mic,
  Send,
  ShieldAlert,
  Sparkles,
  Terminal,
  X
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { OctaApi } from '../../electron/preload'
import type { PlanRecord } from '../../electron/db/jobs'
import type { HealthReport } from '../../electron/core/octa/health'
import type { WorkflowListItem } from '../../electron/core/octa/workflows'
import type { JobEvent, JobOutput, JobRecord, JobStatus } from '../../electron/types'
import type { PlanStep, PlannerResult } from '../../electron/core/octa/planner'
import type { SourceLedgerEntry } from '../../electron/core/octa/sources'
import type { Locale, TranslationKey } from '../i18n'
import { t } from '../i18n'
import { PlanCard } from './PlanCard'
import { SourcesTable } from './SourcesTable'

export interface ConversationMessage {
  id?: string
  role: 'user' | 'assistant'
  text: string
  timestamp?: string
}

export type OctaOutput = JobOutput & {
  jobId?: string
  content?: string
}

export interface OctaPanelState {
  conversation: readonly ConversationMessage[]
  plan: PlannerResult | null
  jobs: readonly JobRecord[]
  events: readonly JobEvent[]
  outputs: readonly OctaOutput[]
  sources: readonly SourceLedgerEntry[]
  health?: HealthReport | null
  workflows?: readonly WorkflowListItem[]
  recentPlans?: readonly PlanRecord[]
}

export type OctaPageApi = {
  jobs: Pick<OctaApi['jobs'], 'list' | 'cancel' | 'approve' | 'onEvent'>
  plans?: Pick<OctaApi['plans'], 'list'>
  planner: Pick<OctaApi['planner'], 'plan' | 'answer' | 'approve' | 'get' | 'onQuestions' | 'onRound'>
  health?: Pick<OctaApi['health'], 'run'>
  workflows?: Pick<OctaApi['workflows'], 'list'>
  research?: Pick<OctaApi['research'], 'status'>
  files?: Pick<OctaApi['files'], 'read' | 'open'>
}

export interface OctaPageProps {
  locale: Locale
  /** State is useful for parent-owned sessions and deterministic component tests. */
  state?: Partial<OctaPanelState>
  initialState?: Partial<OctaPanelState>
  /** Spec 007 can provide its real VoiceBar here when it lands. */
  voiceBar?: ReactNode
  api?: OctaPageApi
  autoLoad?: boolean
  onOpenSetup?: () => void
  onRejectGate?: (job: JobRecord) => Promise<void> | void
  onCommentGate?: (job: JobRecord, comment: string) => Promise<void> | void
}

type PageState = 'idle' | 'questions' | 'ready' | 'running' | 'gate' | 'done' | 'failed'
type StepStatus = 'pending' | 'running' | 'ok' | 'needs_approval' | 'needs_input' | 'failed' | 'cancelled' | 'stale'

interface ViewerState {
  output: OctaOutput
  content: string | null
  loading: boolean
  unavailable: boolean
}

function label(key: TranslationKey, locale: Locale): string {
  return t(key, locale)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isJobStatus(value: unknown): value is JobStatus {
  return value === 'running' || value === 'ok' || value === 'failed' || value === 'needs_approval' || value === 'needs_input' || value === 'cancelled'
}

function isOutput(value: unknown): value is JobOutput {
  const record = asRecord(value)
  return Boolean(record && nonEmptyString(record.path) && nonEmptyString(record.type) && nonEmptyString(record.title))
}

function outputsFrom(value: unknown, jobId?: string): OctaOutput[] {
  const record = asRecord(value)
  if (!record || !Array.isArray(record.outputs)) return []
  return record.outputs.flatMap((item) => isOutput(item)
    ? [{ ...item, ...(jobId ? { jobId } : {}) }]
    : [])
}

function sourceEntry(value: unknown): SourceLedgerEntry | null {
  const record = asRecord(value)
  if (!record || typeof record.n !== 'number' || !nonEmptyString(record.url) || !nonEmptyString(record.domain) || !nonEmptyString(record.lang) || !nonEmptyString(record.type) || !nonEmptyString(record.fetched)) return null
  return {
    n: record.n,
    url: record.url,
    domain: record.domain,
    lang: record.lang,
    type: record.type,
    fetched: record.fetched,
    title: typeof record.title === 'string' ? record.title : '',
    published: typeof record.published === 'string' ? record.published : '',
    words: typeof record.words === 'number' ? record.words : 0,
    claims: [],
    relevance: typeof record.relevance === 'number' ? record.relevance : Number.NaN
  }
}

function sourcesFrom(value: unknown): SourceLedgerEntry[] {
  const record = asRecord(value)
  const candidates = Array.isArray(value) ? value : record && Array.isArray(record.sources) ? record.sources : []
  return candidates.flatMap((item) => {
    const source = sourceEntry(item)
    return source ? [source] : []
  })
}

function mergeOutputs(...groups: readonly OctaOutput[][]): OctaOutput[] {
  const merged: OctaOutput[] = []
  const seen = new Set<string>()
  for (const group of groups) {
    for (const output of group) {
      const key = `${output.path}:${output.title}`
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(output)
    }
  }
  return merged
}

function mergeSources(...groups: readonly SourceLedgerEntry[][]): SourceLedgerEntry[] {
  const merged: SourceLedgerEntry[] = []
  const seen = new Set<string>()
  for (const group of groups) {
    for (const source of group) {
      const key = `${source.n}:${source.url}`
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(source)
    }
  }
  return merged.sort((a, b) => a.n - b.n)
}

function jobResult(job: JobRecord): Record<string, unknown> | null {
  return asRecord(job.result)
}

function outputsFromJobs(jobs: readonly JobRecord[]): OctaOutput[] {
  return jobs.flatMap((job) => outputsFrom(job.result, job.id))
}

function sourcesFromJobs(jobs: readonly JobRecord[]): SourceLedgerEntry[] {
  return jobs.flatMap((job) => {
    const result = jobResult(job)
    return sourcesFrom(result?.sourceEntries ?? result?.sources)
  })
}

function gatePayload(job: JobRecord): unknown {
  const result = jobResult(job)
  const input = asRecord(job.input)
  if (result?.payload !== undefined) return result.payload
  if (result?.outward_payload !== undefined) return result.outward_payload
  if (input?.payload !== undefined) return input.payload
  return job.result ?? job.input ?? { job_id: job.id, step_id: job.stepId ?? '' }
}

function formatPayload(payload: unknown): string {
  if (typeof payload === 'string') return payload
  try {
    const encoded = JSON.stringify(payload, null, 2)
    return encoded ?? String(payload)
  } catch {
    return String(payload)
  }
}

function isMarkdown(output: OctaOutput): boolean {
  return output.type.toLowerCase().includes('markdown') || /\.(md|markdown)$/iu.test(output.path)
}

function isExternalFile(output: OctaOutput): boolean {
  const type = output.type.toLowerCase()
  return type.includes('pdf') || type.includes('html') || /\.(pdf|html?)$/iu.test(output.path)
}

function pageState(plan: PlannerResult | null, jobs: readonly JobRecord[], planning: boolean): PageState {
  if (planning) return 'running'
  if (jobs.some((job) => job.status === 'failed')) return 'failed'
  if (jobs.some((job) => job.status === 'needs_approval' || (job.gate === 'review' && job.status === 'ok'))) return 'gate'
  if (jobs.some((job) => job.status === 'running')) return 'running'
  if (plan?.status === 'needs_input') return 'questions'
  if (jobs.some((job) => job.status === 'ok')) return 'done'
  if (plan) return 'ready'
  return 'idle'
}

function pageStateKey(state: PageState): TranslationKey {
  return ({
    idle: 'octaStateIdle',
    questions: 'octaStateQuestions',
    ready: 'octaStateReady',
    running: 'octaStateRunning',
    gate: 'octaStateGate',
    done: 'octaStateDone',
    failed: 'octaStateFailed'
  } as const)[state]
}

function stepStatus(step: PlanStep, jobs: readonly JobRecord[], events: readonly JobEvent[]): StepStatus {
  const related = jobs
    .filter((job) => job.stepId === step.id)
    .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))[0]
  if (related) return related.status
  const event = [...events].reverse().find((item) => item.type === 'done' && item.result?.step_id === step.id)
  if (event?.type === 'done' && isJobStatus(event.status)) return event.status
  return 'pending'
}

function stepStatusKey(status: StepStatus): TranslationKey {
  return ({
    pending: 'stepStatusPending',
    running: 'stepStatusRunning',
    ok: 'stepStatusDone',
    needs_approval: 'stepStatusNeedsApproval',
    needs_input: 'stepStatusNeedsInput',
    failed: 'stepStatusFailed',
    cancelled: 'stepStatusCancelled',
    stale: 'stepStatusStale'
  } as const)[status]
}

function jobStatusKey(status: JobStatus): TranslationKey {
  return ({
    running: 'jobStatusRunning',
    ok: 'jobStatusOk',
    failed: 'jobStatusFailed',
    needs_approval: 'jobStatusNeedsApproval',
    needs_input: 'jobStatusNeedsInput',
    cancelled: 'jobStatusCancelled',
    stale: 'jobStatusStale'
  } as const)[status]
}

function eventText(event: JobEvent, locale: Locale): string {
  switch (event.type) {
    case 'text':
      return event.text
    case 'tool':
      return `${label('jobTool', locale)} ${event.name}${event.phase ? ` · ${label(event.phase === 'start' ? 'jobToolStarted' : 'jobToolCompleted', locale)}` : ''}`
    case 'usage':
      return `${label('jobUsage', locale)} ${event.inputTokens ?? 0} in / ${event.outputTokens ?? 0} out`
    case 'error':
      return `${label('jobError', locale)} ${event.message}`
    case 'done':
      return `${label('jobDone', locale)} ${label(jobStatusKey(event.status), locale)}`
  }
}

function outputTypeKey(output: OctaOutput): TranslationKey {
  const type = output.type.toLowerCase()
  if (type.includes('markdown') || /\.(md|markdown)$/iu.test(output.path)) return 'outputTypeMarkdown'
  if (type.includes('pdf') || /\.pdf$/iu.test(output.path)) return 'outputTypePdf'
  if (type.includes('html') || /\.html?$/iu.test(output.path)) return 'outputTypeHtml'
  return 'outputTypeFile'
}

function formatTime(value: string | undefined, locale: Locale): string {
  if (!value) return label('notAvailable', locale)
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG' : 'en-US', { hour: 'numeric', minute: '2-digit' }).format(date)
}

interface HomeWorkflowDefinition {
  id: 'W1' | 'W2' | 'W3' | 'W4' | 'W5' | 'W6'
  titleKey: TranslationKey
  detailKey: TranslationKey
  promptKey: TranslationKey
}

const HOME_WORKFLOWS: readonly HomeWorkflowDefinition[] = [
  { id: 'W1', titleKey: 'homeWorkflowW1Title', detailKey: 'homeWorkflowW1Detail', promptKey: 'homeWorkflowW1Prompt' },
  { id: 'W2', titleKey: 'homeWorkflowW2Title', detailKey: 'homeWorkflowW2Detail', promptKey: 'homeWorkflowW2Prompt' },
  { id: 'W3', titleKey: 'homeWorkflowW3Title', detailKey: 'homeWorkflowW3Detail', promptKey: 'homeWorkflowW3Prompt' },
  { id: 'W4', titleKey: 'homeWorkflowW4Title', detailKey: 'homeWorkflowW4Detail', promptKey: 'homeWorkflowW4Prompt' },
  { id: 'W5', titleKey: 'homeWorkflowW5Title', detailKey: 'homeWorkflowW5Detail', promptKey: 'homeWorkflowW5Prompt' },
  { id: 'W6', titleKey: 'homeWorkflowW6Title', detailKey: 'homeWorkflowW6Detail', promptKey: 'homeWorkflowW6Prompt' }
]

function setupMissingItems(report: HealthReport | null): TranslationKey[] {
  if (!report) return ['setupMissingKeys', 'setupMissingVault', 'setupMissingLogins']
  const failed = new Set(report.checks.filter((check) => !check.ok).map((check) => check.id))
  const missing: TranslationKey[] = []
  if (failed.has('gemini') || failed.has('brave')) missing.push('setupMissingKeys')
  if (failed.has('vault') || failed.has('octa-home')) missing.push('setupMissingVault')
  if (failed.has('research-browser')) missing.push('setupMissingLogins')
  if (missing.length === 0 && !report.ok) missing.push('setupMissingRuntime')
  return missing
}

function recentPlanTitle(record: PlanRecord, locale: Locale): string {
  const plan = asRecord(record.plan)
  for (const key of ['summary', 'title', 'name']) {
    if (nonEmptyString(plan?.[key])) return plan[key]
  }
  const brief = record.briefMd.split(/\r?\n/u).map((line) => line.trim()).find(nonEmptyString)
  return brief ?? `${label('recentPlans', locale)} · ${record.id.slice(0, 8)}`
}

function planStatusKey(status: PlanRecord['status']): TranslationKey {
  return status === 'needs_input'
    ? 'planStatusNeedsInput'
    : status === 'needs_approval'
      ? 'planStatusNeedsApproval'
      : status === 'approved'
        ? 'planStatusApproved'
        : 'planStatusReady'
}

function WelcomeBlock({
  locale,
  health,
  jobs,
  plans,
  workflows,
  onOpenSetup,
  onStartWorkflow
}: {
  locale: Locale
  health: HealthReport | null
  jobs: readonly JobRecord[]
  plans: readonly PlanRecord[]
  workflows: readonly WorkflowListItem[]
  onOpenSetup?: () => void
  onStartWorkflow: (prompt: string) => void
}): React.JSX.Element {
  const registryIds = new Set(workflows.map((workflow) => workflow.id))
  const missing = setupMissingItems(health)
  const setupNeeded = health?.ok !== true
  const recentJobs = jobs.slice(0, 5)
  const recentPlans = plans.slice(0, 5)

  return (
    <section className="octa-welcome" aria-labelledby="octa-welcome-title" data-testid="octa-welcome">
      <div className="octa-welcome-intro">
        <div>
          <span className="octa-eyebrow">{label('octaEyebrow', locale)}</span>
          <h2 id="octa-welcome-title">{label('welcomeGreeting', locale)}</h2>
          <p>{label('welcomeDetail', locale)}</p>
        </div>
        <span className="octa-welcome-spark" aria-hidden="true"><Sparkles size={22} /></span>
      </div>

      {setupNeeded && (
        <aside className="octa-setup-banner" data-testid="setup-banner" role="alert">
          <div className="octa-setup-icon" aria-hidden="true"><ShieldAlert size={19} /></div>
          <div className="octa-setup-copy">
            <strong>{label('setupTitle', locale)}</strong>
            <p>{health ? label('setupDetail', locale) : label('setupChecking', locale)}</p>
            <ul>
              {missing.map((item) => <li key={item}>{label(item, locale)}</li>)}
            </ul>
          </div>
          <button className="accent-button" onClick={() => onOpenSetup?.()} type="button">
            <ArrowUpRight size={15} aria-hidden="true" />
            {label('openSetupWizard', locale)}
          </button>
        </aside>
      )}

      <section className="octa-workflow-home" aria-labelledby="octa-workflow-home-title">
        <header className="octa-welcome-section-heading">
          <div>
            <span className="octa-eyebrow">{label('workflowsEyebrow', locale)}</span>
            <h3 id="octa-workflow-home-title">{label('workflowsHomeTitle', locale)}</h3>
          </div>
          <p>{label('workflowsHomeDetail', locale)}</p>
        </header>
        <div className="octa-workflow-grid">
          {HOME_WORKFLOWS.map((definition, index) => {
            const title = label(definition.titleKey, locale)
            return (
              <article className={`octa-workflow-card ${registryIds.has(definition.id) ? 'is-registered' : ''}`} data-workflow-id={definition.id} key={definition.id}>
                <div className="octa-workflow-card-topline"><span>W{index + 1}</span><span className="octa-workflow-card-dot" aria-hidden="true" /></div>
                <h4>{title}</h4>
                <p>{label(definition.detailKey, locale)}</p>
                <button className="quiet-button" onClick={() => onStartWorkflow(label(definition.promptKey, locale))} type="button">
                  <ArrowUpRight size={14} aria-hidden="true" />
                  {label('workflowStart', locale)}
                </button>
              </article>
            )
          })}
        </div>
      </section>

      <section className="octa-recent-home" aria-labelledby="octa-recent-title">
        <div className="octa-welcome-section-heading octa-recent-heading">
          <div>
            <span className="octa-eyebrow">{label('recentActivity', locale)}</span>
            <h3 id="octa-recent-title">{label('recentActivity', locale)}</h3>
          </div>
        </div>
        <div className="octa-recent-grid">
          <section className="octa-recent-card" aria-labelledby="octa-recent-jobs-title">
            <header><h4 id="octa-recent-jobs-title">{label('recentJobs', locale)}</h4><span>{recentJobs.length}</span></header>
            {recentJobs.length === 0 ? <p className="octa-recent-empty">{label('recentJobsEmpty', locale)}</p> : (
              <ul>
                {recentJobs.map((job) => <li key={job.id}><span className="octa-recent-item-copy"><strong>{job.workflow ?? job.skill ?? job.runner}</strong><small>{formatTime(job.startedAt ?? job.finishedAt ?? undefined, locale)}</small></span><span className={`octa-home-job-status status-${job.status}`}>{label(jobStatusKey(job.status), locale)}</span></li>)}
              </ul>
            )}
          </section>
          <section className="octa-recent-card" aria-labelledby="octa-recent-plans-title">
            <header><h4 id="octa-recent-plans-title">{label('recentPlans', locale)}</h4><span>{recentPlans.length}</span></header>
            {recentPlans.length === 0 ? <p className="octa-recent-empty">{label('recentPlansEmpty', locale)}</p> : (
              <ul>
                {recentPlans.map((record) => <li key={record.id}><span className="octa-recent-item-copy"><strong>{recentPlanTitle(record, locale)}</strong><small>{formatTime(record.createdAt, locale)}</small></span><span className="octa-home-plan-status">{label(planStatusKey(record.status), locale)}</span></li>)}
              </ul>
            )}
          </section>
        </div>
      </section>
    </section>
  )
}

function ConversationColumn({
  locale,
  conversation,
  voiceBar,
  planning,
  draft,
  onDraftChange,
  onSubmit,
  inputRef
}: {
  locale: Locale
  conversation: readonly ConversationMessage[]
  voiceBar?: ReactNode
  planning: boolean
  draft: string
  onDraftChange: (value: string) => void
  onSubmit: () => void
  inputRef: React.RefObject<HTMLTextAreaElement | null>
}): React.JSX.Element {
  const submitOnKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      onSubmit()
    }
  }

  return (
    <section className="octa-panel octa-conversation" aria-labelledby="octa-conversation-title">
      <header className="octa-panel-heading">
        <div>
          <span className="octa-eyebrow">{label('conversationEyebrow', locale)}</span>
          <h2 id="octa-conversation-title">{label('conversationTitle', locale)}</h2>
        </div>
        <span className="octa-live-chip"><span className="octa-live-dot" />{label('conversationLive', locale)}</span>
      </header>

      <div className="octa-message-list" aria-live="polite">
        {conversation.length === 0 && (
          <div className="octa-conversation-empty">
            <span className="octa-empty-glyph" aria-hidden="true"><MessageCircle size={20} /></span>
            <h3>{label('conversationEmptyTitle', locale)}</h3>
            <p>{label('conversationEmptyDetail', locale)}</p>
          </div>
        )}
        {conversation.map((message, index) => (
          <article className={`octa-message octa-message-${message.role}`} key={message.id ?? `${message.role}-${index}`}>
            <div className="octa-message-meta">
              {message.role === 'assistant' ? <Bot size={14} aria-hidden="true" /> : <span className="octa-message-you" aria-hidden="true" />}
              <span>{label(message.role === 'assistant' ? 'conversationOcta' : 'conversationYou', locale)}</span>
              {message.timestamp && <time dateTime={message.timestamp}>{formatTime(message.timestamp, locale)}</time>}
            </div>
            <p>{message.text}</p>
          </article>
        ))}
      </div>

      <div className="octa-composer-wrap">
        <label className="octa-field-label" htmlFor="octa-message-input">{label('conversationInput', locale)}</label>
        <textarea
          aria-describedby="octa-message-shortcut"
          id="octa-message-input"
          ref={inputRef}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={submitOnKeyDown}
          placeholder={label('conversationPlaceholder', locale)}
          rows={4}
          value={draft}
        />
        <div className="octa-composer-actions">
          <span id="octa-message-shortcut" className="octa-shortcut"><kbd>Ctrl</kbd><span>+</span><kbd>Enter</kbd> {label('conversationShortcut', locale)}</span>
          <button className="accent-button octa-send-button" disabled={planning || !draft.trim()} onClick={onSubmit} type="button">
            {planning ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Send size={16} aria-hidden="true" />}
            {planning ? label('conversationPlanning', locale) : label('conversationSend', locale)}
          </button>
        </div>
      </div>

      <div className="octa-voice-slot" aria-label={label('voiceBarSlot', locale)} data-testid="voice-bar-slot">
        {voiceBar ?? <><Mic size={16} aria-hidden="true" /><span>{label('voiceBarPlaceholder', locale)}</span></>}
      </div>
    </section>
  )
}

function PlanEmpty({ locale, planning }: { locale: Locale; planning: boolean }): React.JSX.Element {
  return (
    <section className="octa-plan-empty octa-panel" aria-live="polite">
      <span className="octa-empty-glyph" aria-hidden="true">{planning ? <LoaderCircle className="spin" size={20} /> : <Sparkles size={20} />}</span>
      <span className="octa-eyebrow">{label('planEyebrow', locale)}</span>
      <h2>{planning ? label('octaPlanningTitle', locale) : label('octaPlanEmptyTitle', locale)}</h2>
      <p>{planning ? label('octaPlanningDetail', locale) : label('octaPlanEmptyDetail', locale)}</p>
    </section>
  )
}

function FailureSummary({ locale, jobs }: { locale: Locale; jobs: readonly JobRecord[] }): React.JSX.Element | null {
  const failures = jobs.filter((job) => job.status === 'failed')
  if (failures.length === 0) return null
  return (
    <section className="octa-panel octa-failure-panel" aria-labelledby="octa-failure-title">
      <header className="octa-panel-heading">
        <div>
          <span className="octa-eyebrow">{label('failureEyebrow', locale)}</span>
          <h2 id="octa-failure-title">{label('failureTitle', locale)}</h2>
        </div>
        <AlertCircle size={18} aria-hidden="true" />
      </header>
      <ul className="octa-failure-list">
        {failures.map((job) => {
          const notes = asRecord(job.result)?.notes
          const detail = job.error ?? (nonEmptyString(notes) ? notes : label('failureNoDetail', locale))
          return (
            <li key={job.id}>
              <strong>{job.skill ?? job.stepId ?? job.runner} <small>{formatTime(job.finishedAt ?? job.startedAt ?? undefined, locale)}</small></strong>
              <span>{detail}</span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function StepList({
  locale,
  plan,
  jobs,
  events
}: {
  locale: Locale
  plan: PlannerResult | null
  jobs: readonly JobRecord[]
  events: readonly JobEvent[]
}): React.JSX.Element {
  const steps = plan?.plan.steps ?? []
  const fallbackSteps: PlanStep[] = jobs.map((job) => ({
    id: job.stepId ?? job.id.slice(0, 8),
    runner: job.runner as PlanStep['runner'],
    skill: job.skill ?? undefined,
    prompt: job.skill ? undefined : label('stepJobFallback', locale),
    needs: [],
    gate: job.gate ?? 'none',
    autonomy: job.autonomy ?? 'assisted',
    acceptance: []
  }))
  const visibleSteps = steps.length > 0 ? steps : fallbackSteps
  const recentEvents = events.slice(-5).reverse()

  return (
    <section className="octa-panel octa-steps-panel" aria-labelledby="octa-steps-title">
      <header className="octa-panel-heading">
        <div>
          <span className="octa-eyebrow">{label('stepsEyebrow', locale)}</span>
          <h2 id="octa-steps-title">{label('stepsTitle', locale)}</h2>
        </div>
        <span className="octa-count-badge">{visibleSteps.length}</span>
      </header>
      {visibleSteps.length === 0 ? (
        <div className="octa-section-empty"><CircleDashed size={17} aria-hidden="true" /><span>{label('stepsEmpty', locale)}</span></div>
      ) : (
        <ol className="octa-step-list">
          {visibleSteps.map((item, index) => {
            const status = stepStatus(item, jobs, events)
            return (
              <li className={`octa-step octa-step-${status}`} key={`${item.id}-${index}`}>
                <span className="octa-step-marker" aria-hidden="true">
                  {status === 'running' ? <LoaderCircle className="spin" size={16} /> : status === 'ok' ? <CheckCircle2 size={16} /> : status === 'failed' ? <AlertCircle size={16} /> : status === 'needs_approval' ? <ShieldAlert size={16} /> : status === 'cancelled' ? <X size={16} /> : <Circle size={16} />}
                </span>
                <div className="octa-step-copy">
                  <div className="octa-step-title-row">
                    <strong>{item.id}</strong>
                    <span className={`octa-status octa-status-${status}`}>{label(stepStatusKey(status), locale)}</span>
                  </div>
                  <p>{item.skill ?? item.prompt ?? label('notAvailable', locale)}</p>
                  <small><Terminal size={12} aria-hidden="true" />{item.runner}<span>·</span>{item.gate}</small>
                </div>
              </li>
            )
          })}
        </ol>
      )}
      <div className="octa-live-log" aria-label={label('liveActivity', locale)}>
        <div className="octa-subheading"><span>{label('liveActivity', locale)}</span>{recentEvents.length > 0 && <span className="octa-live-chip"><span className="octa-live-dot" />{label('liveActivityStatus', locale)}</span>}</div>
        {recentEvents.length === 0 ? <p>{label('liveActivityEmpty', locale)}</p> : (
          <ul>
            {recentEvents.map((event, index) => (
              <li key={`${event.jobId}-${event.timestamp}-${index}`}>
                <time dateTime={event.timestamp}>{formatTime(event.timestamp, locale)}</time>
                <span>{eventText(event, locale)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

function GatePanel({
  locale,
  job,
  payload,
  onApprove,
  onReject,
  onComment
}: {
  locale: Locale
  job: JobRecord
  payload: string
  onApprove: (job: JobRecord) => Promise<void>
  onReject: (job: JobRecord) => Promise<void>
  onComment: (job: JobRecord, comment: string) => Promise<void>
}): React.JSX.Element {
  const [comment, setComment] = useState('')
  const [working, setWorking] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const run = async (action: 'approve' | 'reject' | 'comment'): Promise<void> => {
    if (action === 'comment' && !comment.trim()) return
    setWorking(true)
    setNotice(null)
    try {
      if (action === 'approve') await onApprove(job)
      if (action === 'reject') await onReject(job)
      if (action === 'comment') {
        await onComment(job, comment.trim())
        setComment('')
      }
      setNotice(label(action === 'approve' ? 'gateApproved' : action === 'reject' ? 'gateRejected' : 'gateCommentSaved', locale))
    } catch {
      setNotice(label('gateActionFailed', locale))
    } finally {
      setWorking(false)
    }
  }

  return (
    <section className="octa-panel octa-gate-panel" aria-labelledby={`gate-${job.id}`}>
      <header className="octa-panel-heading">
        <div>
          <span className="octa-eyebrow">{label('gateEyebrow', locale)}</span>
          <h2 id={`gate-${job.id}`}>{label('gateTitle', locale)}</h2>
          <p className="octa-panel-detail">{label('gateDetail', locale)}</p>
        </div>
        <span className="octa-status octa-status-needs_approval"><ShieldAlert size={13} aria-hidden="true" />{label(job.gate === 'review' ? 'gateReview' : 'gateApproveLabel', locale)}</span>
      </header>
      <dl className="octa-gate-meta">
        <div><dt>{label('gateStep', locale)}</dt><dd>{job.stepId ?? label('notAvailable', locale)}</dd></div>
        <div><dt>{label('gateAction', locale)}</dt><dd>{job.skill ?? job.runner}</dd></div>
      </dl>
      <div className="octa-gate-payload-wrap">
        <div className="octa-subheading"><span>{label('gatePayload', locale)}</span><span className="octa-exact-badge">{label('gateExactPayload', locale)}</span></div>
        <pre className="octa-gate-payload" tabIndex={0}>{payload}</pre>
      </div>
      <div className="octa-gate-comment">
        <label className="octa-field-label" htmlFor={`gate-comment-${job.id}`}>{label('gateComment', locale)}</label>
        <textarea
          id={`gate-comment-${job.id}`}
          onChange={(event) => setComment(event.target.value)}
          placeholder={label('gateCommentPlaceholder', locale)}
          rows={2}
          value={comment}
        />
      </div>
      {notice && <p className="octa-action-notice" role="status">{notice}</p>}
      <div className="octa-gate-actions">
        <button className="octa-danger-button" disabled={working} onClick={() => void run('reject')} type="button"><X size={15} aria-hidden="true" />{label('gateReject', locale)}</button>
        <button className="quiet-button" disabled={working || !comment.trim()} onClick={() => void run('comment')} type="button"><MessageCircle size={15} aria-hidden="true" />{label('gateAddComment', locale)}</button>
        <button className="accent-button" disabled={working} onClick={() => void run('approve')} type="button">{working ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}{label('gateApprove', locale)}</button>
      </div>
    </section>
  )
}

function Gates({
  locale,
  jobs,
  onApprove,
  onReject,
  onComment
}: {
  locale: Locale
  jobs: readonly JobRecord[]
  onApprove: (job: JobRecord) => Promise<void>
  onReject: (job: JobRecord) => Promise<void>
  onComment: (job: JobRecord, comment: string) => Promise<void>
}): React.JSX.Element {
  const gates = jobs.filter((job) => job.status === 'needs_approval' || (job.gate === 'review' && job.status === 'ok'))
  if (gates.length === 0) return <section className="octa-panel octa-gates-empty" aria-label={label('gateTitle', locale)}><CheckCircle2 size={17} aria-hidden="true" /><span>{label('gateNoPending', locale)}</span></section>
  return <div className="octa-gate-list">{gates.map((job) => <GatePanel key={job.id} job={job} locale={locale} onApprove={onApprove} onReject={onReject} onComment={onComment} payload={formatPayload(gatePayload(job))} />)}</div>
}

function Outputs({
  locale,
  outputs,
  viewer,
  onOpen,
  onClose
}: {
  locale: Locale
  outputs: readonly OctaOutput[]
  viewer: ViewerState | null
  onOpen: (output: OctaOutput) => void
  onClose: () => void
}): React.JSX.Element {
  return (
    <section className="octa-panel octa-outputs-panel" aria-labelledby="octa-outputs-title">
      <header className="octa-panel-heading">
        <div>
          <span className="octa-eyebrow">{label('outputsEyebrow', locale)}</span>
          <h2 id="octa-outputs-title">{label('outputsTitle', locale)}</h2>
        </div>
        <FolderOpen size={17} aria-hidden="true" />
      </header>
      {outputs.length === 0 ? <div className="octa-section-empty"><FileText size={17} aria-hidden="true" /><span>{label('outputsEmpty', locale)}</span></div> : (
        <ul className="octa-output-list">
          {outputs.map((output) => (
            <li key={`${output.jobId ?? ''}-${output.path}-${output.title}`}>
              <span className="octa-output-icon" aria-hidden="true">{isMarkdown(output) ? <FileText size={16} /> : <FileCode2 size={16} />}</span>
              <div className="octa-output-copy"><strong>{output.title}</strong><small>{output.path}</small></div>
              <span className="octa-output-type">{label(outputTypeKey(output), locale)}</span>
              <button className="quiet-button octa-output-open" onClick={() => onOpen(output)} type="button">
                {isMarkdown(output) ? <FileText size={14} aria-hidden="true" /> : isExternalFile(output) ? <ArrowUpRight size={14} aria-hidden="true" /> : <FolderOpen size={14} aria-hidden="true" />}
                {isMarkdown(output) ? label('outputView', locale) : label('outputOpen', locale)}
              </button>
            </li>
          ))}
        </ul>
      )}
      {viewer && (
        <section className="octa-document-viewer" aria-labelledby="octa-document-viewer-title">
          <header className="octa-document-heading">
            <div><span className="octa-eyebrow">{label('documentViewerEyebrow', locale)}</span><h3 id="octa-document-viewer-title">{viewer.output.title}</h3></div>
            <button aria-label={label('closeViewer', locale)} className="icon-button" onClick={onClose} type="button"><X size={15} /></button>
          </header>
          {viewer.loading && <p className="octa-viewer-message"><LoaderCircle className="spin" size={16} />{label('viewerLoading', locale)}</p>}
          {!viewer.loading && viewer.unavailable && <p className="octa-viewer-message" role="alert"><AlertCircle size={16} />{label('viewerUnavailable', locale)}</p>}
          {!viewer.loading && !viewer.unavailable && <pre className="octa-document-content">{viewer.content}</pre>}
        </section>
      )}
    </section>
  )
}

export function OctaPage({
  locale,
  state,
  initialState,
  voiceBar,
  api,
  autoLoad,
  onOpenSetup,
  onRejectGate,
  onCommentGate
}: OctaPageProps): React.JSX.Element {
  const seed = initialState ?? state
  const shouldAutoLoad = autoLoad ?? seed === undefined
  const bridge: OctaPageApi | undefined = api ?? (typeof window !== 'undefined'
    ? (window as Window & { octa?: OctaPageApi }).octa
    : undefined)
  const [conversation, setConversation] = useState<ConversationMessage[]>([...(seed?.conversation ?? [])])
  const [plan, setPlan] = useState<PlannerResult | null>(seed?.plan ?? null)
  const [jobs, setJobs] = useState<JobRecord[]>([...(seed?.jobs ?? [])])
  const [events, setEvents] = useState<JobEvent[]>([...(seed?.events ?? [])])
  const [outputRecords, setOutputRecords] = useState<OctaOutput[]>([...(seed?.outputs ?? [])])
  const [sourceRecords, setSourceRecords] = useState<SourceLedgerEntry[]>([...(seed?.sources ?? [])])
  const [draft, setDraft] = useState('')
  const [planning, setPlanning] = useState(false)
  const [loading, setLoading] = useState(shouldAutoLoad && Boolean(bridge))
  const [error, setError] = useState<string | null>(null)
  const [viewer, setViewer] = useState<ViewerState | null>(null)
  const [gateComments, setGateComments] = useState<Record<string, string>>({})
  const [health, setHealth] = useState<HealthReport | null>(seed?.health ?? null)
  const [workflows, setWorkflows] = useState<WorkflowListItem[]>([...(seed?.workflows ?? [])])
  const [recentPlans, setRecentPlans] = useState<PlanRecord[]>([...(seed?.recentPlans ?? [])])
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const refreshJobs = useCallback(async (showLoading = false): Promise<void> => {
    if (!bridge) return
    if (showLoading) setLoading(true)
    try {
      const nextJobs = await bridge.jobs.list({ limit: 100 })
      setJobs(nextJobs)
      setError(null)
      if (!plan) {
        const planId = nextJobs.find((job) => nonEmptyString(job.planId))?.planId
        if (planId) {
          const nextPlan = await bridge.planner.get(planId)
          if (nextPlan) setPlan(nextPlan)
        }
      }
    } catch {
      setError(label('octaLoadError', locale))
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [bridge, locale, plan])

  useEffect(() => {
    if (!shouldAutoLoad) return
    if (!bridge) {
      setLoading(false)
      return
    }
    void refreshJobs(true)
  }, [bridge, refreshJobs, shouldAutoLoad])

  useEffect(() => {
    if (!shouldAutoLoad || !bridge) return
    let active = true
    if (bridge.health) {
      void bridge.health.run().then((report) => {
        if (active) setHealth(report)
      }).catch(() => undefined)
    }
    if (bridge.plans) {
      void bridge.plans.list(5).then((plans) => {
        if (active) setRecentPlans(plans.slice(0, 5))
      }).catch(() => undefined)
    }
    if (bridge.workflows) {
      void bridge.workflows.list().then((items) => {
        if (active) setWorkflows(items)
      }).catch(() => undefined)
    }
    return () => {
      active = false
    }
  }, [bridge, shouldAutoLoad])

  useEffect(() => {
    if (!bridge) return
    const stopJobs = bridge.jobs.onEvent((event) => {
      setEvents((current) => [...current, event].slice(-100))
      setJobs((current) => {
        const index = current.findIndex((job) => job.id === event.jobId)
        if (index < 0) return current
        const next = [...current]
        const job = next[index]
        if (event.type === 'done') next[index] = { ...job, status: event.status, result: event.result ?? job.result }
        if (event.type === 'error') next[index] = { ...job, error: event.message }
        return next
      })
      if (event.type === 'done' && event.result) setOutputRecords((current) => mergeOutputs(current, outputsFrom(event.result, event.jobId)))
      if (event.type === 'done') void refreshJobs()
    })
    const stopQuestions = bridge.planner.onQuestions((event) => {
      setPlan((current) => current && current.planId === event.planId
        ? { ...current, status: 'needs_input', questions: event.questions, plan: { ...current.plan, questions: event.questions } }
        : current)
    })
    const stopRounds = bridge.planner.onRound((event) => {
      setPlan((current) => current && current.planId === event.planId && event.plan
        ? { ...current, plan: event.plan, questions: event.plan.questions, round: Math.max(current.round, event.round) }
        : current)
    })
    return () => {
      stopJobs()
      stopQuestions()
      stopRounds()
    }
  }, [bridge, refreshJobs])

  useEffect(() => {
    const scout = jobs.find((job) => job.runner === 'codex-scout')
    if (!scout || !bridge?.research) return
    let active = true
    void bridge.research.status(scout.id).then((status) => {
      if (!active) return
      const record = asRecord(status)
      const jobRecord = asRecord(record?.job)
      const sources = sourcesFrom(jobRecord?.sources)
      if (sources.length > 0) setSourceRecords((current) => mergeSources(current, sources))
    }).catch(() => undefined)
    return () => {
      active = false
    }
  }, [bridge, jobs])

  const currentState = pageState(plan, jobs, planning)
  const outputs = useMemo(() => mergeOutputs(outputRecords, outputsFromJobs(jobs)), [jobs, outputRecords])
  const sources = useMemo(() => mergeSources(sourceRecords, sourcesFromJobs(jobs)), [jobs, sourceRecords])

  const startWorkflowPrompt = (prompt: string): void => {
    setDraft(prompt)
    if (typeof window !== 'undefined') window.requestAnimationFrame(() => inputRef.current?.focus())
  }

  const submitConversation = async (): Promise<void> => {
    const text = draft.trim()
    if (!text || !bridge) return
    const nextConversation = [...conversation, { role: 'user' as const, text }]
    setConversation(nextConversation)
    setDraft('')
    setPlanning(true)
    setError(null)
    try {
      const nextPlan = await bridge.planner.plan({
        conversation: nextConversation.map((message) => ({ role: message.role, content: message.text })),
        language: locale === 'ar' ? 'ar-EG' : 'en'
      })
      setPlan(nextPlan)
    } catch {
      setError(label('octaPlanningError', locale))
    } finally {
      setPlanning(false)
    }
  }

  const answerPlan = async (answers: Record<string, string>): Promise<void> => {
    if (!plan || !bridge) return
    try {
      setPlan(await bridge.planner.answer({ planId: plan.planId, answers }))
      setError(null)
    } catch {
      setError(label('octaAnswerError', locale))
    }
  }

  const approvePlan = async (): Promise<void> => {
    if (!plan || !bridge) return
    try {
      setPlan(await bridge.planner.approve(plan.planId))
      setError(null)
    } catch {
      setError(label('octaApproveError', locale))
    }
  }

  const approveGate = async (job: JobRecord): Promise<void> => {
    if (!bridge) return
    const result = await bridge.jobs.approve(job.id)
    if (result) setJobs((current) => current.map((item) => item.id === result.id ? result : item))
    else await refreshJobs()
  }

  const rejectGate = async (job: JobRecord): Promise<void> => {
    if (onRejectGate) {
      await onRejectGate(job)
    } else if (bridge) {
      await bridge.jobs.cancel(job.id)
    }
    setJobs((current) => current.map((item) => item.id === job.id ? { ...item, status: 'cancelled' } : item))
  }

  const commentGate = async (job: JobRecord, comment: string): Promise<void> => {
    setGateComments((current) => ({ ...current, [job.id]: comment }))
    if (onCommentGate) await onCommentGate(job, comment)
  }

  const openOutput = async (output: OctaOutput): Promise<void> => {
    if (isMarkdown(output)) {
      setViewer({ output, content: null, loading: true, unavailable: false })
      if (output.content !== undefined) {
        setViewer({ output, content: output.content, loading: false, unavailable: false })
        return
      }
      if (!bridge?.files) {
        setViewer({ output, content: null, loading: false, unavailable: true })
        return
      }
      try {
        const content = await bridge.files.read(output.path)
        setViewer({ output, content, loading: false, unavailable: false })
      } catch {
        setViewer({ output, content: null, loading: false, unavailable: true })
      }
      return
    }
    if (isExternalFile(output) && bridge?.files) {
      await bridge.files.open(output.path)
      return
    }
    if (typeof window !== 'undefined') window.open(output.path, '_blank', 'noopener,noreferrer')
  }

  return (
    <main className="page octa-page" dir={locale === 'ar' ? 'rtl' : 'ltr'}>
      <header className="page-heading octa-page-heading">
        <div>
          <span className="eyebrow">{label('octaEyebrow', locale)}</span>
          <h1>{label('octaTitle', locale)}</h1>
          <p>{label('octaIntro', locale)}</p>
        </div>
        <div className="octa-heading-state" aria-live="polite">
          <span className={`octa-session-state octa-session-${currentState}`}><span className="octa-session-dot" />{label(pageStateKey(currentState), locale)}</span>
          {loading && <span className="octa-refreshing"><LoaderCircle className="spin" size={14} />{label('octaRefreshing', locale)}</span>}
        </div>
      </header>

      {error && <p className="octa-page-error" role="alert"><AlertCircle size={15} />{error}</p>}

      {!plan && !planning && <WelcomeBlock health={health} jobs={jobs} locale={locale} onOpenSetup={onOpenSetup} onStartWorkflow={startWorkflowPrompt} plans={recentPlans} workflows={workflows} />}

      <div className="octa-layout">
        <ConversationColumn conversation={conversation} draft={draft} inputRef={inputRef} locale={locale} onDraftChange={setDraft} onSubmit={() => void submitConversation()} planning={planning} voiceBar={voiceBar} />
        <div className="octa-main-column">
          {plan ? <PlanCard locale={locale} onAnswer={answerPlan} onApprove={approvePlan} result={plan} /> : <PlanEmpty locale={locale} planning={planning} />}
          <FailureSummary jobs={jobs} locale={locale} />
          <StepList events={events} jobs={jobs} locale={locale} plan={plan} />
          <Gates jobs={jobs} locale={locale} onApprove={approveGate} onComment={commentGate} onReject={rejectGate} />
          <Outputs locale={locale} onClose={() => setViewer(null)} onOpen={(output) => void openOutput(output)} outputs={outputs} viewer={viewer} />
          <SourcesTable locale={locale} sources={sources} />
          {Object.keys(gateComments).length > 0 && <span className="sr-only" aria-live="polite">{label('gateCommentSaved', locale)}</span>}
        </div>
      </div>
    </main>
  )
}

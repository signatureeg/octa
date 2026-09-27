import { Check, GitBranch, MessageSquare, Play, RefreshCw, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type {
  WorkflowDefinition,
  WorkflowAutonomy,
  WorkflowGateActionRequest,
  WorkflowGate,
  WorkflowListItem,
  WorkflowRunRecord,
  WorkflowStepDefinition,
  WorkflowStepStatus
} from '../../electron/core/octa/workflows'
import type { Locale, TranslationKey } from '../i18n'
import { t } from '../i18n'

function isRun(value: WorkflowDefinition | WorkflowRunRecord | null): value is WorkflowRunRecord {
  return Boolean(value && 'runId' in value)
}

function statusKey(status: WorkflowStepStatus): TranslationKey {
  const keys: Record<WorkflowStepStatus, TranslationKey> = {
    pending: 'workflowStatusPending',
    running: 'workflowStatusRunning',
    reviewing: 'workflowStatusReviewing',
    retrying: 'workflowStatusRetrying',
    waiting_gate: 'workflowStatusWaitingGate',
    completed: 'workflowStatusCompleted',
    failed: 'workflowStatusFailed',
    skipped: 'workflowStatusSkipped',
    cancelled: 'workflowStatusCancelled'
  }
  return keys[status]
}

function runStatusKey(status: WorkflowRunRecord['status']): TranslationKey {
  const keys: Record<WorkflowRunRecord['status'], TranslationKey> = {
    running: 'workflowStatusRunning',
    waiting_gate: 'workflowStatusWaitingGate',
    ok: 'workflowStatusCompleted',
    failed: 'workflowStatusFailed',
    stale: 'workflowStatusStale',
    cancelled: 'workflowStatusCancelled'
  }
  return keys[status]
}

function displayValue(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

function interpolateLabel(value: string, date: string): string {
  return value.replace('{date}', date)
}

function interpolate(value: string, replacements: Record<string, string | number>): string {
  return Object.entries(replacements).reduce(
    (result, [key, replacement]) => result.replaceAll(`{${key}}`, String(replacement)),
    value
  )
}

const WORKFLOW_COPY: Record<string, { title: TranslationKey; detail: TranslationKey }> = {
  W1: { title: 'homeWorkflowW1Title', detail: 'homeWorkflowW1Detail' },
  W2: { title: 'homeWorkflowW2Title', detail: 'homeWorkflowW2Detail' },
  W3: { title: 'homeWorkflowW3Title', detail: 'homeWorkflowW3Detail' },
  W4: { title: 'homeWorkflowW4Title', detail: 'homeWorkflowW4Detail' },
  W5: { title: 'homeWorkflowW5Title', detail: 'homeWorkflowW5Detail' },
  W6: { title: 'homeWorkflowW6Title', detail: 'homeWorkflowW6Detail' }
}

function autonomyLabel(value: WorkflowAutonomy, locale: Locale): string {
  const keys: Record<WorkflowAutonomy, TranslationKey> = {
    auto: 'skillAutonomyAuto',
    assisted: 'skillAutonomyAssisted',
    led: 'skillAutonomyLed'
  }
  return t(keys[value], locale)
}

function gateLabel(value: WorkflowGate, locale: Locale): string {
  const keys: Record<WorkflowGate, TranslationKey> = {
    none: 'workflowGateNone',
    review: 'workflowGateReview',
    approve: 'workflowGateApprove'
  }
  return t(keys[value], locale)
}

export function WorkflowsPage({ locale }: { locale: Locale }): React.JSX.Element {
  const [workflows, setWorkflows] = useState<WorkflowListItem[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [run, setRun] = useState<WorkflowRunRecord | null>(null)
  const [brief, setBrief] = useState('')
  const [comment, setComment] = useState('')
  const [loading, setLoading] = useState(false)
  const [starting, setStarting] = useState(false)
  const [gateBusy, setGateBusy] = useState(false)
  const [error, setError] = useState('')

  const label = (key: TranslationKey): string => t(key, locale)
  const workflowTitle = (workflow: WorkflowListItem): string => {
    const copy = WORKFLOW_COPY[workflow.id]
    return copy ? label(copy.title) : workflow.name
  }
  const workflowDetail = (workflow: WorkflowListItem): string => {
    const copy = WORKFLOW_COPY[workflow.id]
    return copy ? label(copy.detail) : workflow.description ?? label('workflowsIntro')
  }
  const selected = useMemo(
    () => workflows.find((workflow) => workflow.id === selectedId) ?? workflows[0],
    [selectedId, workflows]
  )

  const reloadRun = async (runId: string): Promise<void> => {
    const value = await window.octa.workflows.get(runId)
    if (isRun(value)) setRun(value)
  }

  const load = async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const next = await window.octa.workflows.list()
      setWorkflows(next)
      const nextId = selectedId && next.some((workflow) => workflow.id === selectedId) ? selectedId : next[0]?.id ?? null
      setSelectedId(nextId)
      const latest = next.find((workflow) => workflow.id === nextId)?.latestRun
      setRun(latest ?? null)
      if (latest) await reloadRun(latest.runId)
    } catch {
      setError(label('workflowError'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    const stopStep = window.octa.workflows.onStep((event) => {
      void reloadRun(event.runId)
    })
    const stopGate = window.octa.workflows.onGate((event) => {
      void reloadRun(event.runId)
    })
    return () => {
      stopStep()
      stopGate()
    }
  }, [])

  useEffect(() => {
    if (!selected) return
    setRun(selected.latestRun)
    if (selected.latestRun) void reloadRun(selected.latestRun.runId)
  }, [selected?.id, selected?.latestRun?.runId])

  const selectWorkflow = (workflow: WorkflowListItem): void => {
    setSelectedId(workflow.id)
    setRun(workflow.latestRun)
    setError('')
  }

  const start = async (): Promise<void> => {
    if (!selected || !brief.trim()) return
    setStarting(true)
    setError('')
    try {
      const started = await window.octa.workflows.start({
        workflow: selected.id,
        brief: { text: brief.trim() },
        language: locale
      })
      await reloadRun(started.runId)
      await load()
    } catch {
      setError(label('workflowError'))
    } finally {
      setStarting(false)
    }
  }

  const gateAction = async (action: 'approve' | 'reject' | 'comment'): Promise<void> => {
    if (!run?.currentGate || gateBusy) return
    const request: WorkflowGateActionRequest = {
      runId: run.runId,
      stepId: run.currentGate.stepId,
      payload: run.currentGate.payload
    }
    if (action === 'comment') request.comment = comment
    if (action === 'reject') request.reason = comment
    setGateBusy(true)
    setError('')
    try {
      const next = action === 'approve'
        ? await window.octa.workflows.approve(request)
        : action === 'reject'
          ? await window.octa.workflows.reject(request)
          : await window.octa.workflows.comment(request)
      setRun(next)
      setComment('')
      await load()
    } catch {
      setError(label('workflowError'))
    } finally {
      setGateBusy(false)
    }
  }

  const stepState = (step: WorkflowStepDefinition): WorkflowRunRecord['steps'][number] | undefined =>
    run?.steps.find((item) => item.id === step.id)

  return (
    <main className="page workflows-page" dir={locale === 'ar' ? 'rtl' : 'ltr'}>
      <header className="page-heading">
        <div>
          <span className="eyebrow">{label('workflowsEyebrow')}</span>
          <h1>{label('workflowsTitle')}</h1>
          <p>{label('workflowsIntro')}</p>
        </div>
        <button className="language-chip" disabled={loading} onClick={() => void load()} type="button">
          <RefreshCw className={loading ? 'spin' : ''} size={15} aria-hidden="true" />
          {label('refreshWorkflows')}
        </button>
      </header>

      {error && <p className="planner-error" role="alert">{error}</p>}

      <div className="workflows-layout">
        <section className="workflows-list glass" aria-label={label('workflowRuns')}>
          <div className="jobs-section-heading">
            <div>
              <span className="job-card-eyebrow">{label('workflowRuns')}</span>
              <h2>{workflows.length}</h2>
            </div>
            <GitBranch size={16} aria-hidden="true" />
          </div>
          <div className="workflow-list-items">
            {workflows.length === 0 && <p className="workflow-empty-state">{label('workflowNoWorkflows')}</p>}
            {workflows.map((workflow) => (
              <button
                className={`workflow-list-item ${selected?.id === workflow.id ? 'selected' : ''}`}
                key={workflow.id}
                onClick={() => selectWorkflow(workflow)}
                aria-label={`${label('workflowCardSelect')}: ${workflowTitle(workflow)}`}
                type="button"
              >
                <span className="workflow-card-topline">
                  <span>{workflow.id}</span>
                  <span className="workflow-card-dot" aria-hidden="true" />
                </span>
                <span className="workflow-list-copy">
                  <strong>{workflowTitle(workflow)}</strong>
                  <small>{workflowDetail(workflow)}</small>
                </span>
                <span className="workflow-card-footer">
                  <span className="workflow-list-count">{interpolate(label('workflowCardSteps'), { count: workflow.steps.length })}</span>
                  <span>{autonomyLabel(workflow.stats.autonomy, locale)}</span>
                </span>
              </button>
            ))}
          </div>
        </section>

        <section className="workflow-control glass">
          {!selected && <p className="empty-state">{label('workflowSelect')}</p>}
          {selected && (
            <>
              <header className="workflow-control-heading">
                <div>
                  <span className="job-card-eyebrow">{selected.id}</span>
                  <h2>{workflowTitle(selected)}</h2>
                  <p>{workflowDetail(selected)}</p>
                </div>
                <div className="workflow-stats">
                  <span>{label('workflowCleanRuns')} <strong>{selected.stats.cleanRuns}</strong></span>
                  <span>{label('workflowRejections')} <strong>{selected.stats.rejectionCount}</strong></span>
                  <span>{label('workflowAutonomy')} <strong>{autonomyLabel(selected.stats.autonomy, locale)}</strong></span>
                </div>
              </header>

              <div className="workflow-launcher">
                <label htmlFor="workflow-brief">{label('workflowBrief')}</label>
                <textarea
                  id="workflow-brief"
                  onChange={(event) => setBrief(event.target.value)}
                  placeholder={label('workflowBriefPlaceholder')}
                  rows={3}
                  value={brief}
                />
                <button className="accent-button" disabled={starting || !brief.trim()} onClick={() => void start()} type="button">
                  <Play size={14} aria-hidden="true" />
                  {starting ? label('startingWorkflow') : label('startWorkflow')}
                </button>
              </div>

              <div className="workflow-run-heading">
                <span className="job-card-eyebrow">{label('workflowRunStatus')}</span>
                <strong>{run ? label(runStatusKey(run.status)) : label('workflowNoRuns')}</strong>
                {run && <small>{run.runId}</small>}
              </div>

              <div className="workflow-graph" aria-label={label('workflowSteps')}>
                {selected.steps.map((step) => {
                  const state = stepState(step)
                  const status = state?.status ?? 'pending'
                  return (
                    <article className={`workflow-step-card status-${status}`} key={step.id}>
                      <div className="workflow-step-topline">
                        <span className="workflow-step-index">{step.id}</span>
                        <span className={`workflow-status status-${status}`}>{label(statusKey(status))}</span>
                      </div>
                      <h3>{step.name ?? step.skill ?? step.runner}</h3>
                      <p><span>{label('workflowRunner')}</span> {step.runner}{step.skill ? ` · ${step.skill}` : ''}</p>
                      <p><span>{label('workflowNeeds')}</span> {step.needs.join(', ') || label('notAvailable')}</p>
                      <p><span>{label('workflowGate')}</span> {gateLabel(step.gate, locale)}</p>
                      {step.todo && <small className="workflow-todo">{label('workflowTodo')}</small>}
                      {step.acceptance.length > 0 && (
                        <ul>
                          {step.acceptance.map((criterion) => <li dir="auto" key={criterion}>{criterion}</li>)}
                        </ul>
                      )}
                    </article>
                  )
                })}
              </div>

              {run?.currentGate ? (
                <section className="workflow-gate glass-heavy" aria-label={label('workflowPayload')}>
                  <div className="workflow-gate-heading">
                    <div>
                      <span className="job-card-eyebrow">{gateLabel(run.currentGate.gate, locale)}</span>
                      <h3>{label('workflowPayload')}</h3>
                    </div>
                    <small>{interpolateLabel(label('workflowGateExpires'), new Date(run.currentGate.expiresAt).toLocaleString(locale === 'ar' ? 'ar-EG' : 'en-US'))}</small>
                  </div>
                  <pre className="workflow-payload">{run.currentGate.payload}</pre>
                  {run.currentGate.gate === 'review' && (
                    <label className="workflow-comment-field">
                      <span>{label('workflowComment')}</span>
                      <textarea
                        onChange={(event) => setComment(event.target.value)}
                        placeholder={label('workflowCommentPlaceholder')}
                        rows={3}
                        value={comment}
                      />
                    </label>
                  )}
                  <div className="workflow-gate-actions">
                    <button className="accent-button" disabled={gateBusy} onClick={() => void gateAction('approve')} type="button">
                      <Check size={14} aria-hidden="true" /> {label('workflowApprove')}
                    </button>
                    {run.currentGate.gate === 'review' && (
                      <button className="quiet-button" disabled={gateBusy || !comment.trim()} onClick={() => void gateAction('comment')} type="button">
                        <MessageSquare size={14} aria-hidden="true" /> {label('workflowSendComment')}
                      </button>
                    )}
                    <button className="quiet-button danger-button" disabled={gateBusy} onClick={() => void gateAction('reject')} type="button">
                      <X size={14} aria-hidden="true" /> {label('workflowReject')}
                    </button>
                  </div>
                </section>
              ) : (
                <p className="workflow-no-gate">{label('workflowNoGate')}</p>
              )}
            </>
          )}
        </section>
      </div>
    </main>
  )
}

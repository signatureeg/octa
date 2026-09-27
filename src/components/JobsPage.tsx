import { useEffect, useState } from 'react'
import { Ban, Check, Play, RefreshCw } from 'lucide-react'
import type { Locale, TranslationKey } from '../i18n'
import { t } from '../i18n'
import type { JobEvent as RuntimeJobEvent, JobRecord as RuntimeJobRecord, JobStatus } from '../../electron/types'
import type { PlannerResult } from '../../electron/core/octa/planner'
import { PlanCard } from './PlanCard'
import type { SourceLedgerEntry } from '../../electron/core/octa/sources'
import { SourcesTable } from './SourcesTable'

function statusKey(status: JobStatus): TranslationKey {
  const keys: Record<JobStatus, TranslationKey> = {
    running: 'jobStatusRunning',
    ok: 'jobStatusOk',
    failed: 'jobStatusFailed',
    needs_approval: 'jobStatusNeedsApproval',
    needs_input: 'jobStatusNeedsInput',
    cancelled: 'jobStatusCancelled',
    stale: 'jobStatusStale'
  }
  return keys[status]
}

function eventLine(event: RuntimeJobEvent, locale: Locale): string {
  switch (event.type) {
    case 'text':
      return event.text
    case 'tool':
      return `${t('jobTool', locale)} ${event.name}${event.phase ? ` · ${t(event.phase === 'start' ? 'jobToolStarted' : 'jobToolCompleted', locale)}` : ''}`
    case 'usage':
      return `${t('jobUsage', locale)} ${event.inputTokens ?? 0} in / ${event.outputTokens ?? 0} out`
    case 'error':
      return `${t('jobError', locale)} ${event.message}`
    case 'done':
      return `${t('jobDone', locale)} ${t(statusKey(event.status), locale)}`
  }
}

export function JobsPage({ locale }: { locale: Locale }): React.JSX.Element {
  const [jobs, setJobs] = useState<RuntimeJobRecord[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [logs, setLogs] = useState<Record<string, RuntimeJobEvent[]>>({})
  const [draft, setDraft] = useState('')
  const [plannerDraft, setPlannerDraft] = useState('')
  const [plannerResult, setPlannerResult] = useState<PlannerResult | null>(null)
  const [plannerError, setPlannerError] = useState<string | null>(null)
  const [planning, setPlanning] = useState(false)
  const [starting, setStarting] = useState(false)
  const [loading, setLoading] = useState(false)
  const [selectedSources, setSelectedSources] = useState<SourceLedgerEntry[]>([])

  const label = (key: TranslationKey): string => t(key, locale)
  const loadJobs = async (): Promise<void> => {
    setLoading(true)
    try {
      setJobs(await window.octa.jobs.list({ limit: 100 }))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadJobs()
    const stopJobsEvents = window.octa.jobs.onEvent((event) => {
      setSelectedId((current) => current ?? event.jobId)
      setLogs((current) => ({
        ...current,
        [event.jobId]: [...(current[event.jobId] ?? []), event].slice(-500)
      }))
      if (event.type === 'done') void loadJobs()
    })
    const stopPlannerQuestions = window.octa.planner.onQuestions((event) => {
      setPlannerResult((current) => current && current.planId === event.planId
        ? { ...current, status: 'needs_input', questions: event.questions, plan: { ...current.plan, questions: event.questions } }
        : current)
    })
    const stopPlannerRounds = window.octa.planner.onRound((event) => {
      setPlannerResult((current) => current && current.planId === event.planId && event.plan
        ? { ...current, plan: event.plan, questions: event.plan.questions, round: Math.max(current.round, event.round) }
        : current)
    })
    return () => {
      stopJobsEvents()
      stopPlannerQuestions()
      stopPlannerRounds()
    }
  }, [])

  const startPlanner = async (): Promise<void> => {
    if (!plannerDraft.trim()) return
    setPlanning(true)
    setPlannerError(null)
    try {
      const result = await window.octa.planner.plan({ brief: plannerDraft.trim(), language: locale === 'ar' ? 'ar-EG' : 'en' })
      setPlannerResult(result)
      setPlannerDraft('')
    } catch (error) {
      setPlannerError(error instanceof Error ? error.message : String(error))
    } finally {
      setPlanning(false)
    }
  }

  const answerPlanner = async (answers: Record<string, string>): Promise<void> => {
    if (!plannerResult) return
    try {
      setPlannerError(null)
      setPlannerResult(await window.octa.planner.answer({ planId: plannerResult.planId, answers }))
    } catch (error) {
      setPlannerError(error instanceof Error ? error.message : String(error))
    }
  }

  const approvePlanner = async (): Promise<void> => {
    if (!plannerResult) return
    try {
      setPlannerError(null)
      setPlannerResult(await window.octa.planner.approve(plannerResult.planId))
    } catch (error) {
      setPlannerError(error instanceof Error ? error.message : String(error))
    }
  }

  const savePlannerWorkflow = async (): Promise<void> => {
    if (!plannerResult) return
    const name = window.prompt(label('planWorkflowNamePrompt'), plannerResult.plan.workflow)
    if (!name?.trim()) return
    try {
      setPlannerError(null)
      await window.octa.workflows.save(name.trim(), plannerResult.plan)
      setPlannerError(label('planSavedWorkflow'))
    } catch {
      setPlannerError(label('workflowError'))
    }
  }
  const selected = jobs.find((job) => job.id === selectedId) ?? jobs[0]

  useEffect(() => {
    let active = true
    if (!selected || selected.runner !== 'codex-scout') {
      setSelectedSources([])
      return () => { active = false }
    }
    void window.octa.research.status(selected.id).then((status) => {
      if (active) setSelectedSources(status.job?.sources ?? [])
    }).catch(() => {
      if (active) setSelectedSources([])
    })
    return () => { active = false }
  }, [selected?.id, selected?.runner])

  const startStopSlop = async (): Promise<void> => {
    if (!draft.trim()) return
    setStarting(true)
    try {
      const started = await window.octa.jobs.start({
        runner: 'codex-exec',
        skill: 'stop-slop',
        input: { text: draft.trim() },
        language: locale,
        gate: 'none'
      })
      setSelectedId(started.id)
      setDraft('')
      await loadJobs()
    } finally {
      setStarting(false)
    }
  }

  const cancel = async (id: string): Promise<void> => {
    await window.octa.jobs.cancel(id)
    await loadJobs()
  }

  const approve = async (id: string): Promise<void> => {
    await window.octa.jobs.approve(id)
    await loadJobs()
  }

  const selectedLogs = selected ? logs[selected.id] ?? [] : []

  return (
    <main className="page jobs-page">
      <header className="page-heading">
        <div>
          <span className="eyebrow">{label('jobsEyebrow')}</span>
          <h1>{label('jobsTitle')}</h1>
          <p>{label('jobsIntro')}</p>
        </div>
        <button className="language-chip" disabled={loading} onClick={() => void loadJobs()} type="button">
          <RefreshCw className={loading ? 'spin' : ''} size={15} />
          {label('refreshJobs')}
        </button>
      </header>

      <section className="planner-launcher glass">
        <div>
          <span className="job-card-eyebrow">{label('planPlannerLauncher')}</span>
          <h2>{label('planTitle')}</h2>
          <p>{label('planPlannerDetail')}</p>
        </div>
        <textarea
          aria-label={label('planBrief')}
          onChange={(event) => setPlannerDraft(event.target.value)}
          placeholder={label('planBriefPlaceholder')}
          rows={3}
          value={plannerDraft}
        />
        <button className="accent-button" disabled={planning || !plannerDraft.trim()} onClick={() => void startPlanner()} type="button">
          <Play size={15} />
          {planning ? label('planWorking') : label('planStart')}
        </button>
      </section>
      {plannerError && <p className="planner-error" role="alert">{plannerError}</p>}
      {plannerResult && <PlanCard result={plannerResult} locale={locale} onAnswer={answerPlanner} onApprove={approvePlanner} onSaveAsWorkflow={savePlannerWorkflow} />}

      <section className="job-launcher glass">
        <div>
          <span className="job-card-eyebrow">{label('jobDemoEyebrow')}</span>
          <h2>{label('jobDemoTitle')}</h2>
          <p>{label('jobDemoDetail')}</p>
        </div>
        <textarea
          aria-label={label('jobInput')}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={label('jobInputPlaceholder')}
          rows={4}
          value={draft}
        />
        <button className="accent-button" disabled={starting || !draft.trim()} onClick={() => void startStopSlop()} type="button">
          <Play size={15} />
          {starting ? label('startingJob') : label('runStopSlop')}
        </button>
      </section>

      <div className="jobs-layout">
        <section className="jobs-list glass" aria-label={label('jobRuns')}>
          <div className="jobs-section-heading">
            <div>
              <span className="job-card-eyebrow">{label('jobRuns')}</span>
              <h2>{jobs.length}</h2>
            </div>
          </div>
          <div className="job-list-items">
            {jobs.length === 0 && <p className="empty-state">{label('noJobs')}</p>}
            {jobs.map((job) => (
              <button
                className={`job-list-item ${selected?.id === job.id ? 'selected' : ''}`}
                key={job.id}
                onClick={() => setSelectedId(job.id)}
                type="button"
              >
                <span className={`job-status-dot status-${job.status}`} />
                <span className="job-list-copy">
                  <strong>{job.skill ?? job.runner}</strong>
                  <small>{job.runner} · <span dir="ltr">{job.id.slice(-8)}</span></small>
                </span>
                <span className={`job-status status-${job.status}`}>{label(statusKey(job.status))}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="job-log glass" aria-label={label('liveLog')}>
          <header className="job-log-heading">
            <div>
              <span className="job-card-eyebrow">{label('liveLog')}</span>
              <h2>{selected?.skill ?? selected?.runner ?? label('selectJob')}</h2>
            </div>
            {selected?.status === 'running' && (
              <button className="quiet-button" onClick={() => void cancel(selected.id)} type="button">
                <Ban size={14} />
                {label('cancelJob')}
              </button>
            )}
            {selected?.status === 'needs_approval' && (
              <button className="accent-button" onClick={() => void approve(selected.id)} type="button">
                <Check size={14} />
                {label('approveJob')}
              </button>
            )}
          </header>
          <pre className="job-log-output">
            {selectedLogs.length > 0
              ? selectedLogs.map((event, index) => `${eventLine(event, locale)}${index === selectedLogs.length - 1 ? '' : '\n'}`).join('')
              : label('noLiveEvents')}
          </pre>
          {selected && <p className="job-folder">{selected.id} · {label(statusKey(selected.status))}</p>}
        </section>
      </div>
      {selected?.runner === 'codex-scout' && <SourcesTable locale={locale} sources={selectedSources} />}
    </main>
  )
}

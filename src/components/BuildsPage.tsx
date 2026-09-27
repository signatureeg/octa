import { useEffect, useMemo, useState } from 'react'
import { GitBranch, Hammer, RefreshCw, ShieldCheck, Sparkles } from 'lucide-react'
import type { BuildEvent, BuildPhaseType, BuildState, BuildSubtaskStatus } from '../../electron/core/octa/build'
import type { Locale, TranslationKey } from '../i18n'
import { t } from '../i18n'

function statusKey(status: BuildState['status']): TranslationKey {
  const keys: Record<BuildState['status'], TranslationKey> = {
    planning: 'buildStatusPlanning',
    ready: 'buildStatusReady',
    coding: 'buildStatusCoding',
    qa: 'buildStatusQa',
    ready_to_merge: 'buildStatusReadyToMerge',
    merged: 'buildStatusMerged',
    failed: 'buildStatusFailed',
    stuck: 'buildStatusStuck',
    discarded: 'buildStatusDiscarded'
  }
  return keys[status]
}

function taskClass(status: BuildSubtaskStatus): string {
  return `build-task-status status-${status}`
}

function taskStatusKey(status: BuildSubtaskStatus): TranslationKey {
  const keys: Record<BuildSubtaskStatus, TranslationKey> = {
    pending: 'buildTaskPending',
    in_progress: 'buildTaskInProgress',
    completed: 'buildTaskCompleted',
    failed: 'buildTaskFailed',
    blocked: 'buildTaskBlocked',
    stuck: 'buildTaskStuck'
  }
  return keys[status]
}

function phaseTypeKey(type: BuildPhaseType): TranslationKey {
  const keys: Record<BuildPhaseType, TranslationKey> = {
    setup: 'buildPhaseSetup',
    implementation: 'buildPhaseImplementation',
    investigation: 'buildPhaseInvestigation',
    integration: 'buildPhaseIntegration',
    cleanup: 'buildPhaseCleanup'
  }
  return keys[type]
}

export function BuildsPage({ locale }: { locale: Locale }): React.JSX.Element {
  const [builds, setBuilds] = useState<BuildState[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [mode, setMode] = useState<'isolated' | 'direct'>('isolated')
  const [starting, setStarting] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reviewText, setReviewText] = useState('')
  const [analysisText, setAnalysisText] = useState('')

  const label = (key: TranslationKey): string => t(key, locale)
  const selected = useMemo(() => builds.find((build) => build.id === selectedId) ?? builds[0], [builds, selectedId])

  const refresh = async (): Promise<void> => {
    setLoading(true)
    try {
      const result = await window.octa.builds.status()
      setBuilds(Array.isArray(result) ? result : [result])
      setSelectedId((current) => current ?? (Array.isArray(result) ? result[0]?.id ?? null : result.id))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
    const stop = window.octa.builds.onEvent((_event: BuildEvent) => { void refresh() })
    return stop
  }, [])

  const start = async (): Promise<void> => {
    if (!draft.trim()) return
    setStarting(true)
    setError(null)
    try {
      const result = await window.octa.builds.start({
        request: draft.trim(),
        mode,
        language: locale === 'ar' ? 'ar-EG' : 'en'
      })
      setDraft('')
      setSelectedId(result.id)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setStarting(false)
    }
  }

  const runAction = async (action: () => Promise<unknown>): Promise<void> => {
    setError(null)
    try {
      await action()
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const review = (): void => {
    if (!selected) return
    void runAction(async () => {
      const value = await window.octa.builds.review(selected.id)
      setReviewText(JSON.stringify(value, null, 2))
      return value
    })
  }

  const analyze = (): void => {
    void runAction(async () => {
      const value = await window.octa.builds.analyze({ brief: draft.trim() || selected?.request })
      setAnalysisText(JSON.stringify(value, null, 2))
      return value
    })
  }

  return (
    <main className="page builds-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow"><Hammer size={13} /> {label('buildsEyebrow')}</p>
          <h1>{label('buildsTitle')}</h1>
          <p>{label('buildsIntro')}</p>
        </div>
        <button className="quiet-button" type="button" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw size={14} className={loading ? 'spin' : ''} /> {label('buildRefresh')}
        </button>
      </header>

      <section className="glass build-launcher">
        <div>
          <p className="job-card-eyebrow">{label('buildsEyebrow')}</p>
          <h2>{label('buildRequest')}</h2>
          <p>{label('buildMode')}</p>
        </div>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={label('buildRequestPlaceholder')}
          aria-label={label('buildRequest')}
        />
        <div className="build-launcher-controls">
          <select value={mode} onChange={(event) => setMode(event.target.value as 'isolated' | 'direct')} aria-label={label('buildMode')}>
            <option value="isolated">{label('buildIsolated')}</option>
            <option value="direct">{label('buildDirect')}</option>
          </select>
          <button className="primary-button" type="button" onClick={() => void start()} disabled={starting || !draft.trim()}>
            <Sparkles size={14} /> {starting ? label('buildStarting') : label('buildStart')}
          </button>
        </div>
      </section>

      {error && <p className="inline-error"><strong>{label('buildError')}:</strong> {error}</p>}

      <div className={`builds-layout${builds.length === 0 ? ' builds-layout-empty' : ''}`}>
        <section className="glass builds-list">
          <div className="build-section-heading">
            <div><h2>{label('buildsTitle')}</h2></div>
            <GitBranch size={17} />
          </div>
          <div className="build-list-items">
            {builds.length === 0 && <p className="empty-state">{label('buildNoBuilds')}</p>}
            {builds.map((build) => (
              <button className={`build-list-item ${selected?.id === build.id ? 'selected' : ''}`} key={build.id} type="button" onClick={() => setSelectedId(build.id)}>
                <span className={`build-status-dot status-${build.status}`} />
                <span className="build-list-copy"><strong>{build.spec.title}</strong><small>{build.id}</small></span>
                <span className={`build-status status-${build.status}`}>{label(statusKey(build.status))}</span>
              </button>
            ))}
          </div>
        </section>

        {builds.length > 0 && <section className="glass build-detail">
          {selected && (
            <>
              <div className="build-detail-heading">
                <div><p className="job-card-eyebrow">{selected.spec.complexity.toUpperCase()} · {selected.spec.workflowType}</p><h2>{selected.spec.title}</h2><p>{selected.request}</p></div>
                <span className={`build-status-pill status-${selected.status}`}>{label(statusKey(selected.status))}</span>
              </div>
              <div className="build-meta-grid">
                <span><small>{label('buildBranch')}</small><code>{selected.branch}</code></span>
                <span><small>{label('buildWorkspace')}</small><code>{selected.workspacePath}</code></span>
              </div>
              <div className="build-phases">
                <h3>{label('buildPhases')}</h3>
                {selected.plan.phases.map((phase) => (
                  <article className="build-phase" key={phase.id}>
                    <div className="build-phase-heading"><strong>{phase.phase}. {phase.name}</strong><small>{label(phaseTypeKey(phase.type))}</small></div>
                    <div className="build-task-list">
                      {phase.subtasks.map((task) => (
                        <div className="build-task" key={task.id}>
                          <span className={taskClass(task.status)} />
                          <div><strong>{task.description}</strong><small>{task.id} · {task.acceptance.join(' · ')}</small></div>
                          <em>{label(taskStatusKey(task.status))}</em>
                        </div>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
              <div className="build-acceptance"><h3>{label('buildAcceptance')}</h3>{selected.spec.acceptance.map((item) => <p key={item}>✓ {item}</p>)}</div>
              <div className="build-actions">
                {(selected.status === 'failed' || selected.status === 'stuck') && <button className="quiet-button" type="button" onClick={() => void runAction(() => window.octa.builds.resume(selected.id))}>{label('buildResume')}</button>}
                <button className="quiet-button" type="button" onClick={review}>{label('buildReview')}</button>
                {selected.status === 'ready_to_merge' && <button className="primary-button" type="button" onClick={() => void runAction(() => window.octa.builds.merge(selected.id))}>{label('buildMerge')}</button>}
                {selected.status !== 'merged' && <button className="danger-button" type="button" onClick={() => void runAction(() => window.octa.builds.discard(selected.id))}>{label('buildDiscard')}</button>}
              </div>
              {selected.qa && <div className="build-qa"><h3><ShieldCheck size={14} /> {label('buildQaLog')}</h3>{selected.qa.history.map((entry) => <p key={entry.loop}><strong>#{entry.loop}</strong> · {label(entry.review.verdict === 'pass' ? 'buildQaPass' : 'buildQaRevise')} · {entry.tests.map((test) => `${test.command}: ${test.passed ? label('buildQaPass') : label('buildQaRevise')}`).join(' · ')}</p>)}</div>}
              {reviewText && <pre className="build-output">{reviewText}</pre>}
            </>
          )}
        </section>}
      </div>
      <section className="glass build-analysis">
        <div><h2>{label('buildAnalyze')}</h2><p>{label('buildAnalyzeIntro')}</p></div>
        <button className="quiet-button" type="button" onClick={analyze}><Sparkles size={14} /> {label('buildAnalyze')}</button>
        {analysisText && <pre className="build-output">{analysisText}</pre>}
      </section>
    </main>
  )
}

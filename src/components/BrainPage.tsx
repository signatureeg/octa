import { useEffect, useState } from 'react'
import { Check, FileText, RefreshCw, Sparkles, X } from 'lucide-react'
import type { BrainProposal, BrainStatus, ProposalStatus } from '../../electron/core/octa/brain'
import type { IntakeQuestion, IntakeState } from '../../electron/core/octa/intake'
import type { Locale, TranslationKey } from '../i18n'
import { t } from '../i18n'
import { LearningPanel } from './LearningPanel'

const emptyStatus: BrainStatus = {
  files: [],
  proposals: [],
  mirrorPath: '',
  watching: false
}
function interpolation(value: string, values: Record<string, string | number>): string {
  return value.replace(/\{(\w+)\}/g, (_match, key: string) => String(values[key] ?? ''))
}

function statusLabel(status: ProposalStatus, locale: Locale): string {
  const key: Record<ProposalStatus, TranslationKey> = {
    pending: 'brainPending',
    approved: 'brainApproved',
    rejected: 'brainRejected'
  }
  return t(key[status], locale)
}

export function BrainPage({ locale }: { locale: Locale }): React.JSX.Element {
  const [brainStatus, setBrainStatus] = useState<BrainStatus>(emptyStatus)
  const [question, setQuestion] = useState<IntakeQuestion | null>(null)
  const [intakeState, setIntakeState] = useState<IntakeState | null>(null)
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const label = (key: TranslationKey): string => t(key, locale)

  const refresh = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const [nextStatus, nextState] = await Promise.all([
        window.octa.brain.status(),
        window.octa.intake.state()
      ])
      setBrainStatus(nextStatus)
      setIntakeState(nextState)
      if (nextState && !nextState.completed) setQuestion(await window.octa.intake.next())
      else setQuestion(null)
    } catch {
      setError(label('brainLoadError'))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const startIntake = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const nextQuestion = await window.octa.intake.next({ mode: 'company', reset: true })
      setQuestion(nextQuestion)
      setIntakeState(await window.octa.intake.state())
      setAnswer('')
    } catch {
      setError(label('intakeLoadError'))
    } finally {
      setBusy(false)
    }
  }

  const saveAnswer = async (): Promise<void> => {
    if (!question || busy) return
    setBusy(true)
    setError('')
    try {
      const result = await window.octa.intake.answer({ answer, questionId: question.id })
      setIntakeState(result.state)
      setQuestion(result.nextQuestion)
      setAnswer('')
      setBrainStatus(await window.octa.brain.status())
    } catch {
      setError(label('intakeLoadError'))
    } finally {
      setBusy(false)
    }
  }

  const updateProposal = async (proposal: BrainProposal, action: 'approve' | 'reject'): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      if (action === 'approve') await window.octa.brain.approve(proposal.id)
      else await window.octa.brain.reject(proposal.id)
      setBrainStatus(await window.octa.brain.status())
    } catch {
      setError(label('brainLoadError'))
    } finally {
      setBusy(false)
    }
  }

  const progress = intakeState
    ? interpolation(label('intakeProgress'), { current: Math.min(intakeState.currentQuestion, 20), total: 20 })
    : ''

  return (
    <main className="page brain-page">
      <header className="page-heading">
        <div>
          <span className="eyebrow">{label('brainEyebrow')}</span>
          <h1>{label('brainTitle')}</h1>
          <p>{label('brainIntro')}</p>
        </div>
        <button className="language-chip" disabled={busy} onClick={() => void refresh()} type="button">
          <RefreshCw size={15} className={busy ? 'spin' : ''} />
          {label('refresh')}
        </button>
      </header>

      {error && <p className="inline-status error brain-error">{error}</p>}

      <div className="brain-grid">
        <section className="glass brain-card">
          <header className="brain-card-heading">
            <FileText size={18} />
            <h2>{label('brainFiles')}</h2>
          </header>
          <div className="brain-file-list">
            {brainStatus.files.length === 0 ? (
              <p className="brain-empty">{label('brainNoFiles')}</p>
            ) : (
              brainStatus.files.map((file) => (
                <div className="brain-file" key={file}>
                  <FileText size={14} />
                  <span>{file}</span>
                </div>
              ))
            )}
          </div>
          {brainStatus.mirrorPath && <code className="brain-path" dir="ltr">{brainStatus.mirrorPath}</code>}
        </section>

        <section className="glass brain-card">
          <header className="brain-card-heading">
            <Sparkles size={18} />
            <h2>{label('brainProposals')}</h2>
          </header>
          <div className="brain-proposal-list">
            {brainStatus.proposals.length === 0 ? (
              <p className="brain-empty">{label('brainNoProposals')}</p>
            ) : (
              brainStatus.proposals.map((proposal) => (
                <article className="brain-proposal" key={proposal.id}>
                  <div className="brain-proposal-meta">
                    <strong>{proposal.targetFile}</strong>
                    <span>{statusLabel(proposal.status, locale)}</span>
                  </div>
                  <pre>{proposal.diffOrContent}</pre>
                  {proposal.sourceJob && <small>{proposal.sourceJob}</small>}
                  {proposal.status === 'pending' && (
                    <div className="section-action-row">
                      <button className="accent-button" disabled={busy} onClick={() => void updateProposal(proposal, 'approve')} type="button">
                        <Check size={14} /> {label('approve')}
                      </button>
                      <button className="quiet-button" disabled={busy} onClick={() => void updateProposal(proposal, 'reject')} type="button">
                        <X size={14} /> {label('reject')}
                      </button>
                    </div>
                  )}
                </article>
              ))
            )}
          </div>
        </section>

        <section className="glass brain-card brain-intake-card">
          <header className="brain-card-heading">
            <Sparkles size={18} />
            <div>
              <h2>{label('intakeTitle')}</h2>
              {progress && <p>{progress}</p>}
            </div>
          </header>
          {!question ? (
            <>
              {intakeState?.completed && <p className="brain-empty">{label('intakeComplete')}</p>}
              <button className="accent-button" disabled={busy} onClick={() => void startIntake()} type="button">
                <Sparkles size={14} /> {label('startIntake')}
              </button>
            </>
          ) : (
            <div className="brain-intake-flow">
              <p className="brain-question-arabic">{question.arabic}</p>
              {locale !== 'ar' && <p className="brain-question-english">{t(question.translationKey as TranslationKey, locale)}</p>}
              <textarea
                aria-label={t(question.translationKey as TranslationKey, locale)}
                disabled={busy}
                onChange={(event) => setAnswer(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') void saveAnswer()
                }}
                placeholder={label('intakeAnswerPlaceholder')}
                value={answer}
              />
              <button className="accent-button" disabled={busy || !answer.trim()} onClick={() => void saveAnswer()} type="button">
                <Check size={14} /> {label('submitAnswer')}
              </button>
            </div>
          )}
        </section>
      </div>

      <LearningPanel locale={locale} />
    </main>
  )
}

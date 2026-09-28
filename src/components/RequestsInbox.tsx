import { useCallback, useEffect, useState } from 'react'
import { Check, ClipboardList, Play, ShieldCheck, X } from 'lucide-react'
import type { WorkRequest } from '../../electron/db/requests'
import type { Locale, TranslationKey } from '../i18n'
import { t } from '../i18n'

/**
 * Workflow-first inbox: every ask (button, voice, delegated task) waits here as a proposed request
 * showing its workflow steps and approval gates. Nothing runs until the owner presses Start.
 */
export function RequestsInbox({ locale, compact = false }: { locale: Locale; compact?: boolean }): React.JSX.Element | null {
  const label = (key: TranslationKey): string => t(key, locale)
  const [requests, setRequests] = useState<WorkRequest[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    if (!window.octa?.requests) return
    try {
      setRequests(await window.octa.requests.list('proposed'))
    } catch {
      setRequests([])
    }
  }, [])

  useEffect(() => {
    void refresh()
    return window.octa?.requests?.onChanged?.((proposed) => setRequests(proposed))
  }, [refresh])

  const act = async (id: string, action: 'start' | 'cancel'): Promise<void> => {
    setBusy(id)
    setMessage('')
    try {
      await window.octa.requests[action](id)
      if (action === 'start') setMessage(label('requestStarted'))
      await refresh()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  if (compact && requests.length === 0) return null
  return (
    <section className="requests-inbox glass" aria-label={label('requestsTitle')}>
      <header>
        <ClipboardList size={17} aria-hidden="true" />
        <div>
          <h2>{label('requestsTitle')} <span className="count-chip">{requests.length}</span></h2>
          <p>{label('requestsDetail')}</p>
        </div>
      </header>
      {requests.length === 0 && <p className="requests-empty">{label('requestsEmpty')}</p>}
      <ol className="requests-list">
        {requests.map((request) => (
          <li key={request.id}>
            <div className="request-copy">
              <strong dir="auto">{request.title}</strong>
              <small>{request.company} · {request.workflowId}{request.tier ? ` · ${request.tier}` : ''} · {label(request.source === 'voice' ? 'requestFromVoice' : request.source === 'task' ? 'requestFromTask' : 'requestFromApp')}</small>
              <ul className="request-steps">
                {request.steps.map((step) => (
                  <li key={step.id}>
                    <span dir="auto">{step.name}</span>
                    <small dir="auto">{step.who}</small>
                    {step.gate !== 'none' && <em><ShieldCheck size={12} aria-hidden="true" /> {label(step.gate === 'approve' ? 'requestNeedsApproval' : 'requestNeedsReview')}</em>}
                  </li>
                ))}
              </ul>
            </div>
            <div className="request-actions">
              <button className="accent-button" disabled={busy === request.id} onClick={() => void act(request.id, 'start')} type="button"><Play size={14} aria-hidden="true" /> {label('requestStart')}</button>
              <button className="quiet-button" disabled={busy === request.id} onClick={() => void act(request.id, 'cancel')} type="button"><X size={14} aria-hidden="true" /> {label('requestCancel')}</button>
            </div>
          </li>
        ))}
      </ol>
      {message && <p className="inline-status" role="status" dir="auto"><Check size={13} aria-hidden="true" /> {message}</p>}
    </section>
  )
}

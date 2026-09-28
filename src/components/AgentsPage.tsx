import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowUpCircle, Bot, CalendarClock, CircleAlert, Pause, Play, Plus, RefreshCw, ShieldCheck, X } from 'lucide-react'
import type { AgentRecord, AgentTrustStage, ModelTier } from '../../electron/types'
import type { Locale, TranslationKey } from '../i18n'
import { t } from '../i18n'
import { OctaMark } from './OctaMark'
import { RequestsInbox } from './RequestsInbox'

const STAGE_KEYS: Record<AgentTrustStage, TranslationKey> = {
  'draft-only': 'agentStageDraft',
  'approve-each': 'agentStageApprove',
  auto: 'agentStageAuto'
}

const STAGES: AgentTrustStage[] = ['draft-only', 'approve-each', 'auto']

/** Departments Octa manages, in the order they appear. Unknown departments are listed after these. */
const DEPARTMENTS: Array<{ id: string; key: TranslationKey }> = [
  { id: 'marketing', key: 'deptMarketing' },
  { id: 'security', key: 'deptSecurity' },
  { id: 'sales', key: 'deptSales' },
  { id: 'email', key: 'deptEmail' },
  { id: 'operations', key: 'deptOperations' },
  { id: 'planning', key: 'deptPlanning' },
  { id: 'development', key: 'deptDevelopment' },
  { id: 'finance', key: 'deptFinance' },
  { id: 'general', key: 'deptGeneral' }
]

const TIERS: ModelTier[] = ['executor', 'executor-fast', 'manager', 'claude-tools']
const SCHEDULES = ['', 'daily', 'weekly', 'monthly'] as const
const SCHEDULE_KEYS: Record<(typeof SCHEDULES)[number], TranslationKey> = {
  '': 'agentScheduleNone',
  daily: 'agentScheduleDaily',
  weekly: 'agentScheduleWeekly',
  monthly: 'agentScheduleMonthly'
}

function departmentName(id: string, locale: Locale): string {
  const known = DEPARTMENTS.find((item) => item.id === id)
  return known ? t(known.key, locale) : id
}

function AgentCard({ agent, locale, onChanged }: { agent: AgentRecord; locale: Locale; onChanged: () => Promise<void> }): React.JSX.Element {
  const label = (key: TranslationKey): string => t(key, locale)
  const [task, setTask] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const act = async (action: () => Promise<unknown>, done?: string): Promise<void> => {
    setBusy(true)
    setMessage('')
    try {
      await action()
      if (done) setMessage(done)
      await onChanged()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <article className={`agent-card glass${agent.status === 'paused' ? ' paused' : ''}`}>
      <header className="agent-card-heading">
        <span className="agent-icon" aria-hidden="true"><Bot size={18} /></span>
        <div>
          <h2 dir="auto">{agent.name}</h2>
          <p><span className={`agent-stage stage-${agent.trustStage}`}>{label(STAGE_KEYS[agent.trustStage])}</span> · <span dir="ltr">{agent.tier}</span>{agent.schedule ? ` · ${label(SCHEDULE_KEYS[agent.schedule])}` : ''}{agent.status === 'paused' ? ` · ${label('agentPaused')}` : ''}</p>
        </div>
      </header>

      {agent.pendingPromotion && (
        <div className="agent-notice promotion" role="status">
          <ArrowUpCircle size={16} aria-hidden="true" />
          <span>{t('agentPromotionOffer', locale).replace('{count}', String(agent.cleanStreak)).replace('{stage}', label(STAGE_KEYS[agent.pendingPromotion]))}</span>
          <button className="accent-button" disabled={busy} onClick={() => void act(() => window.octa.agents.approvePromotion(agent.id))} type="button">{label('agentPromote')}</button>
          <button className="quiet-button" disabled={busy} onClick={() => void act(() => window.octa.agents.dismissPromotion(agent.id))} type="button">{label('agentNotYet')}</button>
        </div>
      )}
      {agent.lastDemotion && !agent.pendingPromotion && (
        <div className="agent-notice demotion">
          <CircleAlert size={16} aria-hidden="true" />
          <span>{label('agentDemoted')} {label(STAGE_KEYS[agent.lastDemotion.to])}: <bdi>{agent.lastDemotion.reason}</bdi></span>
        </div>
      )}

      <dl className="agent-facts">
        <div><dt>{label('agentScope')}</dt><dd dir="auto">{agent.scope}</dd></div>
        <div><dt>{label('agentDone')}</dt><dd dir="auto">{agent.definitionOfDone}</dd></div>
        <div><dt>{label('agentSkills')}</dt><dd dir="ltr">{agent.skills.join(', ') || '—'}</dd></div>
        {agent.team?.length ? (
          <div className="agent-team">
            <dt>{t('agentTeam', locale).replace('{count}', String(agent.team.length))}</dt>
            <dd>
              <p className="agent-team-note">{label('agentTeamNote')}</p>
              <ul>
                {agent.team.map((member) => (
                  <li key={member.slug} title={member.checklist.map((point, index) => `${index + 1}. ${point}`).join('\n')}>
                    <strong dir="auto">{member.name}</strong>
                    <span dir="auto">{member.scope}</span>
                    <small>{t('agentTeamChecks', locale).replace('{count}', String(member.checklist.length))} · <span dir="ltr">{member.skills.join(', ')}</span></small>
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        ) : null}
        <div><dt>{label('agentRecord')}</dt><dd>{t('agentRecordValue', locale).replace('{runs}', String(agent.runs)).replace('{clean}', String(agent.cleanRuns)).replace('{streak}', String(agent.cleanStreak))}</dd></div>
      </dl>

      <label className="agent-task">
        <span>{label('agentTask')}</span>
        <textarea dir="auto" disabled={busy || agent.status === 'paused'} onChange={(event) => setTask(event.target.value)} placeholder={label('agentTaskPlaceholder')} rows={2} value={task} />
      </label>

      <footer className="agent-actions">
        <button className="accent-button" disabled={busy || agent.status === 'paused'} onClick={() => void act(async () => { await window.octa.agents.run(agent.id, task); setTask('') }, label('agentRequested'))} type="button">
          <Play size={14} aria-hidden="true" /> {label('agentRequest')}
        </button>
        <button className="quiet-button" disabled={busy} onClick={() => void act(() => window.octa.agents.update(agent.id, { status: agent.status === 'paused' ? 'active' : 'paused' }))} type="button">
          {agent.status === 'paused' ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />} {label(agent.status === 'paused' ? 'agentResume' : 'agentPause')}
        </button>
        <label className="agent-select">
          <CalendarClock size={14} aria-hidden="true" />
          <span className="sr-only">{label('agentSchedule')}</span>
          <select aria-label={label('agentSchedule')} disabled={busy} onChange={(event) => void act(() => window.octa.agents.update(agent.id, { schedule: (event.target.value || null) as AgentRecord['schedule'] | null }))} value={agent.schedule ?? ''}>
            {SCHEDULES.map((value) => <option key={value || 'none'} value={value}>{label(SCHEDULE_KEYS[value])}</option>)}
          </select>
        </label>
        <label className="agent-select">
          <ShieldCheck size={14} aria-hidden="true" />
          <span className="sr-only">{label('agentTrust')}</span>
          <select aria-label={label('agentTrust')} disabled={busy} onChange={(event) => void act(() => window.octa.agents.setTrust(agent.id, event.target.value as AgentTrustStage))} value={agent.trustStage}>
            {STAGES.map((stage) => <option key={stage} value={stage}>{label(STAGE_KEYS[stage])}</option>)}
          </select>
        </label>
      </footer>
      {message && <p className="inline-status" role="status" dir="auto">{message}</p>}
    </article>
  )
}

interface Draft {
  name: string
  department: string
  identity: string
  scope: string
  definitionOfDone: string
  skills: string
  tier: ModelTier
  schedule: string
  trustStage: AgentTrustStage
}

const EMPTY_DRAFT: Draft = { name: '', department: 'marketing', identity: '', scope: '', definitionOfDone: '', skills: '', tier: 'executor', schedule: '', trustStage: 'draft-only' }

function NewAgentForm({ locale, onCreated, onClose }: { locale: Locale; onCreated: () => Promise<void>; onClose: () => void }): React.JSX.Element {
  const label = (key: TranslationKey): string => t(key, locale)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = <K extends keyof Draft>(key: K, value: Draft[K]): void => setDraft((current) => ({ ...current, [key]: value }))

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await window.octa.agents.create({
        ...draft,
        skills: draft.skills.split(/[,،\n]/).map((item) => item.trim()).filter(Boolean),
        schedule: (draft.schedule || undefined) as AgentRecord['schedule']
      })
      setDraft(EMPTY_DRAFT)
      await onCreated()
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="agent-form glass" aria-label={label('agentNew')}>
      <header>
        <h2>{label('agentNew')}</h2>
        <button aria-label={label('close')} className="icon-button" onClick={onClose} type="button"><X size={15} /></button>
      </header>
      <div className="agent-form-grid">
        <label><span>{label('agentName')}</span><input dir="auto" onChange={(event) => set('name', event.target.value)} value={draft.name} /></label>
        <label><span>{label('agentDepartment')}</span>
          <select onChange={(event) => set('department', event.target.value)} value={draft.department}>
            {DEPARTMENTS.map((item) => <option key={item.id} value={item.id}>{label(item.key)}</option>)}
          </select>
        </label>
        <label className="wide"><span>{label('agentIdentity')}</span><textarea dir="auto" onChange={(event) => set('identity', event.target.value)} placeholder={label('agentIdentityHint')} rows={3} value={draft.identity} /></label>
        <label className="wide"><span>{label('agentScope')}</span><textarea dir="auto" onChange={(event) => set('scope', event.target.value)} placeholder={label('agentScopeHint')} rows={2} value={draft.scope} /></label>
        <label className="wide"><span>{label('agentDone')}</span><textarea dir="auto" onChange={(event) => set('definitionOfDone', event.target.value)} placeholder={label('agentDoneHint')} rows={2} value={draft.definitionOfDone} /></label>
        <label className="wide"><span>{label('agentSkills')}</span><input dir="ltr" onChange={(event) => set('skills', event.target.value)} placeholder="copywriting, content-strategy" value={draft.skills} /></label>
        <label><span>{label('agentTier')}</span>
          <select onChange={(event) => set('tier', event.target.value as ModelTier)} value={draft.tier}>
            {TIERS.map((tier) => <option key={tier} value={tier}>{tier}</option>)}
          </select>
        </label>
        <label><span>{label('agentSchedule')}</span>
          <select onChange={(event) => set('schedule', event.target.value)} value={draft.schedule}>
            {SCHEDULES.map((value) => <option key={value || 'none'} value={value}>{label(SCHEDULE_KEYS[value])}</option>)}
          </select>
        </label>
        <label><span>{label('agentTrust')}</span>
          <select onChange={(event) => set('trustStage', event.target.value as AgentTrustStage)} value={draft.trustStage}>
            <option value="draft-only">{label('agentStageDraft')}</option>
            <option value="approve-each">{label('agentStageApprove')}</option>
          </select>
        </label>
      </div>
      {error && <p className="inline-status error" dir="auto">{error}</p>}
      <footer className="agent-actions">
        <button className="accent-button" disabled={busy} onClick={() => void submit()} type="button"><Plus size={14} aria-hidden="true" /> {label('agentCreate')}</button>
      </footer>
    </section>
  )
}

export function AgentsPage({ locale }: { locale: Locale }): React.JSX.Element {
  const label = (key: TranslationKey): string => t(key, locale)
  const [agents, setAgents] = useState<AgentRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    if (!window.octa?.agents) return
    setLoading(true)
    try {
      setAgents(await window.octa.agents.list())
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const groups = useMemo(() => {
    const known = DEPARTMENTS.map((item) => item.id)
    const ids = [...known, ...[...new Set(agents.map((agent) => agent.department))].filter((id) => !known.includes(id)).sort()]
    return ids.map((id) => ({ id, agents: agents.filter((agent) => agent.department === id) })).filter((group) => group.agents.length > 0)
  }, [agents])

  return (
    <main className="page agents-page" dir={locale === 'ar' ? 'rtl' : 'ltr'}>
      <header className="page-heading">
        <div>
          <span className="eyebrow">{label('agentsEyebrow')}</span>
          <h1>{label('agentsTitle')}</h1>
          <p>{label('agentsIntro')}</p>
        </div>
        <div className="agents-heading-actions">
          <button className="accent-button" onClick={() => setCreating((value) => !value)} type="button"><Plus size={14} aria-hidden="true" /> {label('agentNew')}</button>
          <button className="language-chip" disabled={loading} onClick={() => void refresh()} type="button">
            <RefreshCw className={loading ? 'spin' : ''} size={15} aria-hidden="true" /> {label('refresh')}
          </button>
        </div>
      </header>

      <RequestsInbox locale={locale} />

      <section className="org-manager glass" aria-label={label('orgManager')}>
        <OctaMark className="org-mark" />
        <div>
          <strong>{label('orgManager')}</strong>
          <p>{label('orgManagerDetail')}</p>
        </div>
        <ul className="org-departments">
          {DEPARTMENTS.filter((item) => item.id !== 'general').map((item) => {
            const count = agents.filter((agent) => agent.department === item.id).length
            return <li className={count ? 'staffed' : ''} key={item.id}>{label(item.key)} <span>{count}</span></li>
          })}
        </ul>
      </section>

      {creating && <NewAgentForm locale={locale} onClose={() => setCreating(false)} onCreated={refresh} />}
      {error && <p className="inline-status error" dir="auto">{error}</p>}

      {!loading && agents.length === 0 && (
        <div className="agents-empty glass">
          <Bot size={22} aria-hidden="true" />
          <h2>{label('agentsEmptyTitle')}</h2>
          <p>{label('agentsEmptyDetail')}</p>
        </div>
      )}
      {groups.map((group) => (
        <section className="agents-department" key={group.id} aria-label={departmentName(group.id, locale)}>
          <h2 className="agents-department-title">{departmentName(group.id, locale)} <span>{group.agents.length}</span></h2>
          <div className="agents-grid">
            {group.agents.map((agent) => <AgentCard agent={agent} key={agent.id} locale={locale} onChanged={refresh} />)}
          </div>
        </section>
      ))}
      <p className="agents-ladder-note">{label('agentsLadderNote')}</p>
    </main>
  )
}

import { useEffect, useReducer, useState } from 'react'
import {
  FolderOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleUserRound,
  FolderCog,
  Globe2,
  KeyRound,
  Languages,
  LogIn,
  RefreshCw,
  ShieldCheck,
  X
} from 'lucide-react'
import type { ResearchBrowserStatus, ResearchLoginSite } from '../../electron/core/octa/browser'
import type {
  GuidedInstallKind,
  GuidedInstallResult,
  HealthReport
} from '../../electron/core/octa/health'
import type { OctaApi } from '../../electron/preload'
import type { AppSettings } from '../../electron/types'
import type { Locale, TranslationKey } from '../i18n'
import { t } from '../i18n'
import { HealthPage, type HealthInstallOutput } from './HealthPage'
import { OctaMark } from './OctaMark'

export const FIRST_RUN_STEPS = ['language', 'credentials', 'paths', 'health', 'research', 'photoshop', 'done'] as const
export type FirstRunStep = (typeof FIRST_RUN_STEPS)[number]

export interface FirstRunState {
  step: FirstRunStep
  completed: boolean
}

export type FirstRunAction =
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'go-to'; step: FirstRunStep }
  | { type: 'complete' }
  | { type: 'reset' }

export const INITIAL_FIRST_RUN_STATE: FirstRunState = { step: 'language', completed: false }

export function nextFirstRunStep(step: FirstRunStep): FirstRunStep {
  const index = FIRST_RUN_STEPS.indexOf(step)
  return FIRST_RUN_STEPS[Math.min(FIRST_RUN_STEPS.length - 1, index + 1)]
}

export function previousFirstRunStep(step: FirstRunStep): FirstRunStep {
  const index = FIRST_RUN_STEPS.indexOf(step)
  return FIRST_RUN_STEPS[Math.max(0, index - 1)]
}

export function firstRunReducer(state: FirstRunState, action: FirstRunAction): FirstRunState {
  switch (action.type) {
    case 'next':
      return { ...state, step: nextFirstRunStep(state.step) }
    case 'back':
      return { ...state, step: previousFirstRunStep(state.step) }
    case 'go-to':
      return { ...state, step: action.step }
    case 'complete':
      return { ...state, completed: true }
    case 'reset':
      return INITIAL_FIRST_RUN_STATE
  }
}

interface FirstRunProps {
  settings: AppSettings
  locale: Locale
  required?: boolean
  onUpdate: (update: Partial<AppSettings>) => Promise<AppSettings>
  onComplete: (settings: AppSettings) => Promise<void>
  onCancel?: () => void
  onRunHealth: () => Promise<HealthReport>
  onInstall: (kind: GuidedInstallKind) => Promise<GuidedInstallResult>
  onInstallOutput?: (listener: (event: HealthInstallOutput) => void) => () => void
}

const LOGIN_SITES: readonly ResearchLoginSite[] = ['facebook', 'x', 'reddit']

function octaApi(): OctaApi | null {
  return (globalThis as typeof globalThis & { octa?: OctaApi }).octa ?? null
}

function siteLabelKey(site: ResearchLoginSite): TranslationKey {
  return site === 'facebook' ? 'researchFacebook' : site === 'x' ? 'researchX' : 'researchReddit'
}

const STEP_LABELS: Record<FirstRunStep, TranslationKey> = {
  language: 'firstRunLanguage',
  credentials: 'firstRunCredentials',
  paths: 'firstRunPaths',
  health: 'firstRunHealth',
  research: 'firstRunResearch',
  photoshop: 'firstRunPhotoshop',
  done: 'firstRunDone'
}

function Field({
  label,
  detail,
  value,
  type = 'text',
  placeholder,
  required,
  browse,
  browseLabel,
  onChange
}: {
  label: string
  detail: string
  value: string
  type?: 'text' | 'password' | 'url'
  placeholder?: string
  required?: boolean
  /** Adds a Browse button that opens the native picker. */
  browse?: { kind: 'file' | 'folder'; extensions?: string[] }
  browseLabel?: string
  onChange: (value: string) => void
}): React.JSX.Element {
  return (
    <label className="first-run-field">
      <span className="first-run-field-label">{label}{required && <b aria-hidden="true"> *</b>}</span>
      <span className="first-run-field-detail">{detail}</span>
      <span className={browse ? 'first-run-input-row' : 'first-run-input-single'}>
        <input
          autoComplete="off"
          dir="ltr"
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          type={type}
          value={value}
        />
        {browse && (
          <button
            className="quiet-button first-run-browse"
            onClick={async (event) => {
              event.preventDefault()
              const picked = await window.octa.dialog.pickPath({ ...browse, defaultPath: value || undefined })
              if (picked) onChange(picked)
            }}
            type="button"
          >
            <FolderOpen size={14} aria-hidden="true" />
            {browseLabel}
          </button>
        )}
      </span>
    </label>
  )
}

export function FirstRun({
  settings,
  locale,
  required = false,
  onUpdate,
  onComplete,
  onCancel,
  onRunHealth,
  onInstall,
  onInstallOutput
}: FirstRunProps): React.JSX.Element {
  const [state, dispatch] = useReducer(firstRunReducer, INITIAL_FIRST_RUN_STATE)
  const [draft, setDraft] = useState(settings)
  const [saving, setSaving] = useState(false)
  const [finishing, setFinishing] = useState(false)
  const [error, setError] = useState('')
  const [browserStatus, setBrowserStatus] = useState<ResearchBrowserStatus | null>(null)
  const [loginOpen, setLoginOpen] = useState<ResearchLoginSite | null>(null)
  const [loginPending, setLoginPending] = useState<ResearchLoginSite | null>(null)
  const [researchError, setResearchError] = useState('')

  const wizardLocale = draft.locale || locale
  const label = (key: TranslationKey): string => t(key, wizardLocale)

  useEffect(() => setDraft(settings), [settings])

  useEffect(() => {
    if (typeof document === 'undefined') return
    document.documentElement.lang = wizardLocale
    document.documentElement.dir = wizardLocale === 'ar' ? 'rtl' : 'ltr'
  }, [wizardLocale])

  const updateDraft = <K extends keyof AppSettings>(key: K, value: AppSettings[K]): void => {
    setDraft((current) => ({ ...current, [key]: value }))
    setError('')
  }

  const saveDraft = async (): Promise<AppSettings | null> => {
    setSaving(true)
    setError('')
    try {
      const next = await onUpdate(draft)
      setDraft(next)
      return next
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value))
      return null
    } finally {
      setSaving(false)
    }
  }

  const goNext = async (): Promise<void> => {
    if (state.step === 'language' || state.step === 'credentials' || state.step === 'paths' || state.step === 'photoshop') {
      if (!await saveDraft()) return
    }
    dispatch({ type: 'next' })
  }

  const finish = async (): Promise<void> => {
    const saved = await saveDraft()
    if (!saved) return
    setFinishing(true)
    setError('')
    try {
      dispatch({ type: 'complete' })
      await onComplete(saved)
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value))
      setFinishing(false)
    }
  }

  const skip = async (): Promise<void> => {
    if (!required) {
      onCancel?.()
      return
    }
    const saved = await saveDraft()
    if (!saved) return
    setFinishing(true)
    try {
      dispatch({ type: 'complete' })
      await onComplete(saved)
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value))
      setFinishing(false)
    }
  }

  const refreshResearch = async (): Promise<void> => {
    const api = octaApi()
    if (!api?.research) return
    try {
      setBrowserStatus((await api.research.status()).browser)
      setResearchError('')
    } catch (value) {
      setResearchError(value instanceof Error ? value.message : String(value))
    }
  }

  useEffect(() => {
    const api = octaApi()
    if (state.step !== 'research' || !api?.research) return undefined
    void refreshResearch()
    return api.research.onChallenge(() => void refreshResearch())
    // The login flow is only refreshed when its wizard step becomes visible.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.step])

  const startLogin = async (site: ResearchLoginSite): Promise<void> => {
    const api = octaApi()
    if (!api?.research) return
    setLoginPending(site)
    setResearchError('')
    try {
      await api.research.loginStart(site)
      setLoginOpen(site)
      await refreshResearch()
    } catch (value) {
      setResearchError(value instanceof Error ? value.message : String(value))
    } finally {
      setLoginPending(null)
    }
  }

  const finishLogin = async (site: ResearchLoginSite): Promise<void> => {
    const api = octaApi()
    if (!api?.research) return
    setLoginPending(site)
    try {
      await api.research.loginDone(site)
      setLoginOpen(null)
      await refreshResearch()
    } catch (value) {
      setResearchError(value instanceof Error ? value.message : String(value))
    } finally {
      setLoginPending(null)
    }
  }

  const renderCredentials = (): React.JSX.Element => (
    <div className="first-run-form">
      <div className="first-run-form-intro"><KeyRound size={18} aria-hidden="true" /><p>{label('firstRunCredentialsDetail')}</p></div>
      <Field label={label('geminiApiKey')} detail={label('geminiApiKeyDetail')} placeholder={label('geminiApiKeyPlaceholder')} required type="password" value={draft.geminiApiKey} onChange={(value) => updateDraft('geminiApiKey', value)} />
      <Field label={label('groqApiKey')} detail={label('groqApiKeyDetail')} placeholder={label('groqApiKeyPlaceholder')} type="password" value={draft.groqApiKey} onChange={(value) => updateDraft('groqApiKey', value)} />
      <Field label={label('braveSearchApiKey')} detail={label('braveSearchApiKeyDetail')} placeholder={label('braveSearchApiKeyPlaceholder')} type="password" value={draft.braveSearchApiKey} onChange={(value) => updateDraft('braveSearchApiKey', value)} />
      <Field label={label('ntfyTopic')} detail={label('ntfyTopicDetail')} placeholder={label('ntfyTopicPlaceholder')} type="password" value={draft.ntfyTopic} onChange={(value) => updateDraft('ntfyTopic', value)} />
      <Field label={label('ntfyServer')} detail={label('ntfyServerDetail')} placeholder={label('ntfyServerPlaceholder')} type="url" value={draft.ntfyServer} onChange={(value) => updateDraft('ntfyServer', value)} />
    </div>
  )

  const renderPaths = (): React.JSX.Element => (
    <div className="first-run-form">
      <div className="first-run-form-intro"><FolderCog size={18} aria-hidden="true" /><p>{label('firstRunPathsDetail')}</p></div>
      <Field label={label('octaHomePath')} detail={label('octaHomePathDetail')} placeholder={label('octaHomePathPlaceholder')} required browse={{ kind: 'folder' }} browseLabel={label('browse')} value={draft.octaHomePath} onChange={(value) => updateDraft('octaHomePath', value)} />
      <Field label={label('vaultPath')} detail={label('vaultPathDetail')} placeholder={label('vaultPathPlaceholder')} required browse={{ kind: 'folder' }} browseLabel={label('browse')} value={draft.vaultPath} onChange={(value) => updateDraft('vaultPath', value)} />
      <Field label={label('wakeWordModelPath')} detail={label('wakeWordModelPathDetail')} browse={{ kind: 'file', extensions: ['onnx'] }} browseLabel={label('browse')} value={draft.wakeWordModelPath} onChange={(value) => updateDraft('wakeWordModelPath', value)} />
    </div>
  )

  const renderLanguage = (): React.JSX.Element => (
    <div className="first-run-form">
      <div className="first-run-form-intro"><Languages size={18} aria-hidden="true" /><p>{label('firstRunLanguageDetail')}</p></div>
      <div aria-label={label('locale')} className="first-run-language-options" role="group">
        {(['ar', 'en'] as const).map((choice) => (
          <button
            className={`first-run-language-option ${draft.locale === choice ? 'selected' : ''}`}
            key={choice}
            onClick={() => updateDraft('locale', choice)}
            type="button"
          >
            <strong>{t(choice === 'ar' ? 'arabic' : 'english', 'ar')}</strong>
            <span>{t(choice === 'ar' ? 'arabic' : 'english', 'en')}</span>
            {draft.locale === choice && <Check size={15} aria-hidden="true" />}
          </button>
        ))}
      </div>
    </div>
  )

  const renderPhotoshop = (): React.JSX.Element => (
    <div className="first-run-form">
      <div className="first-run-form-intro"><FolderCog size={18} aria-hidden="true" /><p>{label('firstRunPhotoshopDetail')}</p></div>
      <Field label={label('photoshopPath')} detail={label('photoshopPathDetail')} placeholder={label('photoshopPathPlaceholder')} browse={{ kind: 'file', extensions: ['exe'] }} browseLabel={label('browse')} value={draft.photoshopPath} onChange={(value) => updateDraft('photoshopPath', value)} />
      <div className="first-run-note"><ShieldCheck size={15} aria-hidden="true" /><span>{label('firstRunPhotoshopFallback')}</span></div>
    </div>
  )

  const renderResearch = (): React.JSX.Element => (
    <div className="first-run-research">
      <div className="first-run-form-intro"><Globe2 size={18} aria-hidden="true" /><p>{label('firstRunResearchDetail')}</p></div>
      <div className="first-run-login-list">
        {LOGIN_SITES.map((site) => {
          const status = browserStatus?.sites[site]
          const isOpen = loginOpen === site
          const busy = loginPending === site
          return (
            <div className="first-run-login-row" key={site}>
              <span className="first-run-login-icon"><CircleUserRound size={17} aria-hidden="true" /></span>
              <div><strong>{label(siteLabelKey(site))}</strong><span>{status?.loggedIn ? label('researchLoggedIn') : label('researchNotLoggedIn')}</span></div>
              <button className={isOpen ? 'accent-button' : 'quiet-button'} disabled={busy} onClick={() => void (isOpen ? finishLogin(site) : startLogin(site))} type="button">
                {busy ? <RefreshCw className="spin" size={14} aria-hidden="true" /> : <LogIn size={14} aria-hidden="true" />}
                {isOpen ? label('researchConfirmLogin') : label('researchLogin')}
              </button>
            </div>
          )
        })}
      </div>
      <div className="first-run-research-footer"><span>{browserStatus?.profilePath ?? label('researchBrowserNotStarted')}</span><button className="quiet-button" onClick={() => void refreshResearch()} type="button"><RefreshCw size={14} aria-hidden="true" />{label('refresh')}</button></div>
      {researchError && <p className="first-run-error" role="alert">{researchError}</p>}
    </div>
  )

  const renderHealth = (done: boolean): React.JSX.Element => (
    <>
      {done && <div className="first-run-form-intro first-run-done-note"><ShieldCheck size={18} aria-hidden="true" /><p>{label('firstRunDoneDetail')}</p></div>}
      <HealthPage
        compact
        key={state.step}
        locale={wizardLocale}
        onInstall={onInstall}
        onInstallOutput={onInstallOutput}
        onRun={onRunHealth}
        settings={draft}
      />
    </>
  )

  const content = state.step === 'language'
    ? renderLanguage()
    : state.step === 'credentials'
      ? renderCredentials()
      : state.step === 'paths'
      ? renderPaths()
      : state.step === 'research'
        ? renderResearch()
      : state.step === 'photoshop'
          ? renderPhotoshop()
          : renderHealth(state.step === 'done')

  const stepIndex = FIRST_RUN_STEPS.indexOf(state.step)
  const isDone = state.step === 'done'

  return (
    <main className="first-run-shell">
      <section className="first-run-panel">
        <aside className="first-run-rail">
          <div className="first-run-brand"><OctaMark className="brand-mark" /><div><strong>{label('brandName')}</strong><span>{label('firstRunEyebrow')}</span></div></div>
          <div className="first-run-rail-copy"><span>{label('firstRunWelcome')}</span><p>{label('firstRunIntro')}</p></div>
          <ol className="first-run-steps">
            {FIRST_RUN_STEPS.map((step, index) => (
              <li className={`${step === state.step ? 'active' : ''} ${index < stepIndex ? 'done' : ''}`} key={step}>
                <button disabled={index > stepIndex || saving || finishing} onClick={() => dispatch({ type: 'go-to', step })} type="button">
                  <span>{index < stepIndex ? <Check size={13} aria-hidden="true" /> : index + 1}</span>
                  {label(STEP_LABELS[step])}
                </button>
              </li>
            ))}
          </ol>
        </aside>
        <div className="first-run-main">
          <header className="first-run-heading">
            <div><span className="eyebrow">{label('firstRunEyebrow')}</span><h1>{label('firstRunTitle')}</h1><p>{label('firstRunIntro')}</p></div>
            {!required && onCancel && <button aria-label={label('firstRunClose')} className="icon-button" onClick={onCancel} type="button"><X size={16} aria-hidden="true" /></button>}
          </header>
          <div className="first-run-step-heading"><span>{label(STEP_LABELS[state.step])}</span><small>{label('firstRunProgress').replace('{current}', String(stepIndex + 1)).replace('{total}', String(FIRST_RUN_STEPS.length))}</small></div>
          {content}
          {error && <p className="first-run-error" role="alert">{error}</p>}
          <footer className="first-run-footer">
            <button className="quiet-button" disabled={saving || finishing} onClick={() => void skip()} type="button">{required ? label('firstRunSkip') : label('firstRunClose')}</button>
            <div className="first-run-nav">
              {stepIndex > 0 && <button className="quiet-button" disabled={saving || finishing} onClick={() => dispatch({ type: 'back' })} type="button"><ChevronLeft size={14} aria-hidden="true" />{label('firstRunBack')}</button>}
              {isDone ? (
                <button className="accent-button" disabled={saving || finishing} onClick={() => void finish()} type="button"><ShieldCheck size={14} aria-hidden="true" />{finishing ? label('firstRunFinishing') : label('firstRunFinish')}</button>
              ) : (
                <button className="accent-button" disabled={saving || finishing} onClick={() => void goNext()} type="button">{saving ? label('saving') : label('firstRunContinue')}<ChevronRight size={14} aria-hidden="true" /></button>
              )}
            </div>
          </footer>
        </div>
      </section>
    </main>
  )
}

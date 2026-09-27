import { useEffect, useState } from 'react'
import {
  BellRing,
  Check,
  Cloud,
  FolderOpen,
  Github,
  Globe2,
  HeartPulse,
  KeyRound,
  Languages,
  LogIn,
  Mic,
  MousePointer2,
  Moon,
  Palette,
  RefreshCw,
  Search,
  Send,
  ShieldAlert,
  Sun,
  Wrench
} from 'lucide-react'
import type { AiTestResult, AppSettings } from '../../electron/types'
import type { BrowserChallengeEvent, ResearchBrowserStatus, ResearchLoginSite } from '../../electron/core/octa/browser'
import type { Locale, TranslationKey } from '../i18n'
import { t } from '../i18n'

type SaveState = 'idle' | 'saving' | 'saved' | 'error'
type NotificationState = 'idle' | 'sending' | 'sent' | 'failed'
const LOGIN_SITES: readonly ResearchLoginSite[] = ['facebook', 'x', 'reddit']

function siteLabelKey(site: ResearchLoginSite): TranslationKey {
  return site === 'facebook' ? 'researchFacebook' : site === 'x' ? 'researchX' : 'researchReddit'
}

function SettingField({
  icon,
  label,
  detail,
  children
}: {
  icon: React.ReactNode
  label: string
  detail: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="setting-field">
      <span className="setting-icon">{icon}</span>
      <div className="setting-copy">
        <strong>{label}</strong>
        <span>{detail}</span>
      </div>
      <div className="setting-control">{children}</div>
    </div>
  )
}

function SectionHeading({
  icon,
  title,
  detail
}: {
  icon: React.ReactNode
  title: string
  detail: string
}): React.JSX.Element {
  return (
    <header className="settings-section-heading">
      <span className="section-icon">{icon}</span>
      <div>
        <h2>{title}</h2>
        <p>{detail}</p>
      </div>
    </header>
  )
}

export function SettingsPage({
  settings,
  locale,
  onUpdate,
  onAiTest,
  onNotifyTest,
  onOpenFirstRun,
  version
}: {
  settings: AppSettings
  locale: Locale
  onUpdate: (update: Partial<AppSettings>) => Promise<AppSettings>
  onAiTest: () => Promise<AiTestResult>
  onNotifyTest: () => Promise<boolean>
  onOpenFirstRun: () => void
  version: string
}): React.JSX.Element {
  const [draft, setDraft] = useState<AppSettings>(settings)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [aiState, setAiState] = useState<'idle' | 'testing' | 'success' | 'error'>('idle')
  const [aiMessage, setAiMessage] = useState('')
  const [notificationState, setNotificationState] = useState<NotificationState>('idle')
  const [browserStatus, setBrowserStatus] = useState<ResearchBrowserStatus | null>(null)
  const [browserError, setBrowserError] = useState('')
  const [loginOpen, setLoginOpen] = useState<ResearchLoginSite | null>(null)
  const [loginPending, setLoginPending] = useState<ResearchLoginSite | null>(null)
  const [challenge, setChallenge] = useState<BrowserChallengeEvent | null>(null)

  const label = (key: TranslationKey): string => t(key, locale)

  useEffect(() => setDraft(settings), [settings])

  const refreshBrowserStatus = async (): Promise<void> => {
    if (!window.octa?.research) return
    try {
      setBrowserStatus((await window.octa.research.status())?.browser ?? null)
      setBrowserError('')
    } catch (error) {
      setBrowserError(error instanceof Error ? error.message : String(error))
    }
  }

  useEffect(() => {
    void refreshBrowserStatus()
    if (!window.octa?.research) return
    return window.octa.research.onChallenge((event) => {
      setChallenge(event)
      void refreshBrowserStatus()
    })
  }, [])

  const setValue = <K extends keyof AppSettings>(key: K, value: AppSettings[K]): void => {
    setDraft((current) => ({ ...current, [key]: value }))
    setSaveState('idle')
  }

  const save = async (): Promise<AppSettings | undefined> => {
    setSaveState('saving')
    try {
      const next = await onUpdate(draft)
      setDraft(next)
      setSaveState('saved')
      return next
    } catch {
      setSaveState('error')
      return undefined
    }
  }

  const testAi = async (): Promise<void> => {
    const saved = await save()
    if (!saved) return
    setAiState('testing')
    setAiMessage('')
    try {
      const result = await onAiTest()
      setAiState('success')
      setAiMessage(`${label('aiConnected')} · ${result.provider} · ${result.latencyMs} ${label('millisecondsShort')}`)
    } catch (error) {
      setAiState('error')
      setAiMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const testNotifications = async (): Promise<void> => {
    const saved = await save()
    if (!saved) return
    setNotificationState('sending')
    try {
      setNotificationState((await onNotifyTest()) ? 'sent' : 'failed')
    } catch {
      setNotificationState('failed')
    }
  }

  const startLogin = async (site: ResearchLoginSite): Promise<void> => {
    setLoginPending(site)
    setBrowserError('')
    try {
      await window.octa.research.loginStart(site)
      setLoginOpen(site)
      await refreshBrowserStatus()
    } catch (error) {
      setBrowserError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoginPending(null)
    }
  }

  const finishLogin = async (site: ResearchLoginSite): Promise<void> => {
    setLoginPending(site)
    try {
      await window.octa.research.loginDone(site)
      setLoginOpen(null)
      await refreshBrowserStatus()
    } catch (error) {
      setBrowserError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoginPending(null)
    }
  }

  const resolveChallenge = async (): Promise<void> => {
    if (!challenge) return
    try {
      await window.octa.research.challengeResolved(challenge.site)
      setChallenge(null)
      await refreshBrowserStatus()
    } catch (error) {
      setBrowserError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <main className="page settings-page">
      <header className="page-heading">
        <div>
          <span className="eyebrow">{label('settingsEyebrow')}</span>
          <h1>{label('settingsTitle')}</h1>
          <p>{label('settingsIntro')}</p>
        </div>
        <div className="settings-heading-actions">
          <span className="settings-version">{label('versionLabel')} {version}</span>
          <button className="quiet-button" onClick={onOpenFirstRun} type="button">
            <HeartPulse size={15} aria-hidden="true" />
            {label('openSetupWizard')}
          </button>
          <button className="language-chip" onClick={() => void onUpdate({ locale: locale === 'ar' ? 'en' : 'ar' })} type="button">
            <Languages size={15} />
            {locale === 'ar' ? label('english') : label('arabic')}
          </button>
        </div>
      </header>

      <div className="settings-card glass">
        <section className="settings-section">
          <SectionHeading icon={<Cloud size={19} />} title={label('aiSection')} detail={label('aiSectionDetail')} />
          <div className="settings-fields">
            <SettingField icon={<KeyRound size={18} />} label={label('geminiApiKey')} detail={label('geminiApiKeyDetail')}>
              <input
                dir="ltr"
                aria-label={label('geminiApiKey')}
                autoComplete="off"
                onChange={(event) => setValue('geminiApiKey', event.target.value)}
                placeholder={label('geminiApiKeyPlaceholder')}
                spellCheck={false}
                type="password"
                value={draft.geminiApiKey}
              />
            </SettingField>
            <SettingField icon={<KeyRound size={18} />} label={label('groqApiKey')} detail={label('groqApiKeyDetail')}>
              <input
                dir="ltr"
                aria-label={label('groqApiKey')}
                autoComplete="off"
                onChange={(event) => setValue('groqApiKey', event.target.value)}
                placeholder={label('groqApiKeyPlaceholder')}
                spellCheck={false}
                type="password"
                value={draft.groqApiKey}
              />
            </SettingField>
            <SettingField icon={<Wrench size={18} />} label={label('aiProvider')} detail={label('aiProviderDetail')}>
              <select aria-label={label('aiProvider')} onChange={(event) => setValue('aiProvider', event.target.value as AppSettings['aiProvider'])} value={draft.aiProvider}>
                <option value="gemini">{label('geminiProvider')}</option>
                <option value="vertex">{label('vertexProvider')}</option>
              </select>
            </SettingField>
            {draft.aiProvider === 'vertex' && (
              <>
                <SettingField icon={<Globe2 size={18} />} label={label('vertexProjectId')} detail={label('vertexProjectIdDetail')}>
                  <input dir="ltr" aria-label={label('vertexProjectId')} onChange={(event) => setValue('vertexProjectId', event.target.value)} placeholder={label('vertexProjectIdPlaceholder')} spellCheck={false} value={draft.vertexProjectId} />
                </SettingField>
                <SettingField icon={<KeyRound size={18} />} label={label('vertexKeyPath')} detail={label('vertexKeyPathDetail')}>
                  <input dir="ltr" aria-label={label('vertexKeyPath')} onChange={(event) => setValue('vertexKeyPath', event.target.value)} placeholder={label('vertexKeyPathPlaceholder')} spellCheck={false} value={draft.vertexKeyPath} />
                  <button className="quiet-button setting-browse" onClick={async () => { const picked = await window.octa.dialog.pickPath({ ...{ kind: 'file', extensions: ['json'] }, defaultPath: draft.vertexKeyPath || undefined }); if (picked) setValue('vertexKeyPath', picked) }} type="button"><FolderOpen size={14} aria-hidden="true" />{label('browse')}</button>
                </SettingField>
                <SettingField icon={<Globe2 size={18} />} label={label('vertexLocation')} detail={label('vertexLocationDetail')}>
                  <input dir="ltr" aria-label={label('vertexLocation')} onChange={(event) => setValue('vertexLocation', event.target.value)} placeholder={label('vertexLocationPlaceholder')} spellCheck={false} value={draft.vertexLocation} />
                </SettingField>
              </>
            )}
          </div>
          <div className="section-action-row">
            <button className="accent-button" disabled={aiState === 'testing'} onClick={() => void testAi()} type="button">
              <RefreshCw className={aiState === 'testing' ? 'spin' : ''} size={15} />
              {aiState === 'testing' ? label('testingAi') : label('testAi')}
            </button>
            {aiMessage && <span className={`inline-status ${aiState === 'error' ? 'error' : 'success'}`}>{aiMessage}</span>}
          </div>
        </section>

        <section className="settings-section voice-settings-section">
          <SectionHeading icon={<Mic size={19} />} title={label('voiceSection')} detail={label('voiceSectionDetail')} />
          <div className="settings-fields">
            <SettingField icon={<Mic size={18} />} label={label('voiceLiveModel')} detail={label('voiceLiveModelDetail')}>
              <input dir="ltr" aria-label={label('voiceLiveModel')} readOnly spellCheck={false} value={draft.geminiLiveModel || label('notAvailable')} />
            </SettingField>
            <SettingField icon={<Wrench size={18} />} label={label('voiceLiveModelOverride')} detail={label('voiceLiveModelOverrideDetail')}>
              <input dir="ltr" aria-label={label('voiceLiveModelOverride')} onChange={(event) => setValue('geminiLiveModelOverride', event.target.value)} placeholder={label('notAvailable')} spellCheck={false} value={draft.geminiLiveModelOverride} />
            </SettingField>
            <SettingField icon={<FolderOpen size={18} />} label={label('wakeWordModelPath')} detail={label('wakeWordModelPathDetail')}>
              <input dir="ltr" aria-label={label('wakeWordModelPath')} onChange={(event) => setValue('wakeWordModelPath', event.target.value)} spellCheck={false} value={draft.wakeWordModelPath} />
              <button className="quiet-button setting-browse" onClick={async () => { const picked = await window.octa.dialog.pickPath({ ...{ kind: 'file', extensions: ['onnx'] }, defaultPath: draft.wakeWordModelPath || undefined }); if (picked) setValue('wakeWordModelPath', picked) }} type="button"><FolderOpen size={14} aria-hidden="true" />{label('browse')}</button>
            </SettingField>
            <SettingField icon={<Mic size={18} />} label={label('wakeWordSensitivity')} detail={label('wakeWordSensitivityDetail')}>
              <input aria-label={label('wakeWordSensitivity')} max="1" min="0" onChange={(event) => setValue('wakeWordSensitivity', Number(event.target.value))} step="0.01" type="range" value={draft.wakeWordSensitivity} />
            </SettingField>
            <SettingField icon={<Mic size={18} />} label={label('wakeGreeting')} detail={label('wakeGreetingDetail')}>
              <input aria-label={label('wakeGreeting')} onChange={(event) => setValue('wakeGreeting', event.target.value)} value={draft.wakeGreeting} />
            </SettingField>
            <SettingField icon={<MousePointer2 size={18} />} label={label('triggerType')} detail={label('triggerTypeDetail')}>
              <select aria-label={label('triggerType')} onChange={(event) => setValue('triggerType', event.target.value as AppSettings['triggerType'])} value={draft.triggerType}>
                <option value="keyboard">{label('keyboardTrigger')}</option>
                <option value="mouse">{label('mouseTrigger')}</option>
              </select>
            </SettingField>
            {draft.triggerType === 'mouse' ? (
              <SettingField icon={<MousePointer2 size={18} />} label={label('mouseButton')} detail={label('mouseButtonDetail')}>
                <select aria-label={label('mouseButton')} onChange={(event) => setValue('mouseButton', Number(event.target.value) as AppSettings['mouseButton'])} value={draft.mouseButton}>
                  <option value="3">3</option>
                  <option value="4">4</option>
                  <option value="5">5</option>
                </select>
              </SettingField>
            ) : (
              <SettingField icon={<KeyRound size={18} />} label={label('pushToTalkKey')} detail={label('pushToTalkKeyDetail')}>
                <input dir="ltr" aria-label={label('pushToTalkKey')} onChange={(event) => {
                  setDraft((current) => ({ ...current, pushToTalkKey: event.target.value, hotkey: event.target.value }))
                  setSaveState('idle')
                }} spellCheck={false} value={draft.pushToTalkKey} />
              </SettingField>
            )}
          </div>
          <div className="voice-toggle-row">
            <label><input checked={draft.wakeWordEnabled} onChange={(event) => setValue('wakeWordEnabled', event.target.checked)} type="checkbox" /> {label('wakeWordEnabled')}</label>
            <label><input checked={draft.pushToTalkEnabled} onChange={(event) => setValue('pushToTalkEnabled', event.target.checked)} type="checkbox" /> {label('pushToTalkEnabled')}</label>
          </div>
        </section>

        <section className="settings-section">
          <SectionHeading icon={<BellRing size={19} />} title={label('notificationsSection')} detail={label('notificationsSectionDetail')} />
          <div className="settings-fields">
            <SettingField icon={<BellRing size={18} />} label={label('ntfyTopic')} detail={label('ntfyTopicDetail')}>
              <input dir="ltr" aria-label={label('ntfyTopic')} autoComplete="off" onChange={(event) => setValue('ntfyTopic', event.target.value)} placeholder={label('ntfyTopicPlaceholder')} spellCheck={false} value={draft.ntfyTopic} />
            </SettingField>
            <SettingField icon={<Globe2 size={18} />} label={label('ntfyServer')} detail={label('ntfyServerDetail')}>
              <input dir="ltr" aria-label={label('ntfyServer')} onChange={(event) => setValue('ntfyServer', event.target.value)} placeholder={label('ntfyServerPlaceholder')} spellCheck={false} type="url" value={draft.ntfyServer} />
            </SettingField>
          </div>
          <div className="section-action-row">
            <button className="quiet-button" disabled={notificationState === 'sending'} onClick={() => void testNotifications()} type="button">
              <Send size={15} />
              {notificationState === 'sending'
                ? label('sendingNotification')
                : notificationState === 'sent'
                  ? label('notificationSent')
                  : notificationState === 'failed'
                    ? label('notificationFailed')
                    : label('testNotifications')}
            </button>
          </div>
        </section>

        <section className="settings-section">
          <SectionHeading icon={<FolderOpen size={19} />} title={label('pathsSection')} detail={label('pathsSectionDetail')} />
          <div className="settings-fields">
            <SettingField icon={<FolderOpen size={18} />} label={label('octaHomePath')} detail={label('octaHomePathDetail')}>
              <input dir="ltr" aria-label={label('octaHomePath')} onChange={(event) => setValue('octaHomePath', event.target.value)} placeholder={label('octaHomePathPlaceholder')} spellCheck={false} value={draft.octaHomePath} />
              <button className="quiet-button setting-browse" onClick={async () => { const picked = await window.octa.dialog.pickPath({ ...{ kind: 'folder' }, defaultPath: draft.octaHomePath || undefined }); if (picked) setValue('octaHomePath', picked) }} type="button"><FolderOpen size={14} aria-hidden="true" />{label('browse')}</button>
            </SettingField>
            <SettingField icon={<FolderOpen size={18} />} label={label('skillsLibraryPath')} detail={label('skillsLibraryPathDetail')}>
              <input dir="ltr" aria-label={label('skillsLibraryPath')} onChange={(event) => setValue('skillsLibraryPath', event.target.value)} placeholder={label('skillsLibraryPathPlaceholder')} spellCheck={false} value={draft.skillsLibraryPath} />
              <button className="quiet-button setting-browse" onClick={async () => { const picked = await window.octa.dialog.pickPath({ ...{ kind: 'folder' }, defaultPath: draft.skillsLibraryPath || undefined }); if (picked) setValue('skillsLibraryPath', picked) }} type="button"><FolderOpen size={14} aria-hidden="true" />{label('browse')}</button>
            </SettingField>
            <SettingField icon={<FolderOpen size={18} />} label={label('vaultPath')} detail={label('vaultPathDetail')}>
              <input dir="ltr" aria-label={label('vaultPath')} onChange={(event) => setValue('vaultPath', event.target.value)} placeholder={label('vaultPathPlaceholder')} spellCheck={false} value={draft.vaultPath} />
              <button className="quiet-button setting-browse" onClick={async () => { const picked = await window.octa.dialog.pickPath({ ...{ kind: 'folder' }, defaultPath: draft.vaultPath || undefined }); if (picked) setValue('vaultPath', picked) }} type="button"><FolderOpen size={14} aria-hidden="true" />{label('browse')}</button>
            </SettingField>
            <SettingField icon={<Wrench size={18} />} label={label('photoshopPath')} detail={label('photoshopPathDetail')}>
              <input dir="ltr" aria-label={label('photoshopPath')} onChange={(event) => setValue('photoshopPath', event.target.value)} placeholder={label('photoshopPathPlaceholder')} spellCheck={false} value={draft.photoshopPath} />
              <button className="quiet-button setting-browse" onClick={async () => { const picked = await window.octa.dialog.pickPath({ ...{ kind: 'file', extensions: ['exe'] }, defaultPath: draft.photoshopPath || undefined }); if (picked) setValue('photoshopPath', picked) }} type="button"><FolderOpen size={14} aria-hidden="true" />{label('browse')}</button>
            </SettingField>
          </div>
        </section>

        <section className="settings-section">
          <SectionHeading icon={<Github size={19} />} title={label('updatesSection')} detail={label('updatesSectionDetail')} />
          <div className="settings-fields">
            <SettingField icon={<Github size={18} />} label={label('updateRepository')} detail={label('updateRepositoryDetail')}>
              <input dir="ltr" aria-label={label('updateRepository')} onChange={(event) => setValue('updateRepository', event.target.value)} placeholder={label('updateRepositoryPlaceholder')} spellCheck={false} value={draft.updateRepository} />
            </SettingField>
          </div>
        </section>

        <section className="settings-section">
          <SectionHeading icon={<Search size={19} />} title={label('searchSection')} detail={label('searchSectionDetail')} />
          <div className="settings-fields">
            <SettingField icon={<Search size={18} />} label={label('braveSearchApiKey')} detail={label('braveSearchApiKeyDetail')}>
              <input dir="ltr" aria-label={label('braveSearchApiKey')} autoComplete="off" onChange={(event) => setValue('braveSearchApiKey', event.target.value)} placeholder={label('braveSearchApiKeyPlaceholder')} spellCheck={false} type="password" value={draft.braveSearchApiKey} />
            </SettingField>
          </div>
        </section>

        <section className="settings-section">
          <SectionHeading icon={<Globe2 size={19} />} title={label('researchBrowserSection')} detail={label('researchBrowserSectionDetail')} />
          <div className="research-browser-summary">
            <span className="research-browser-path">{browserStatus?.profilePath ?? label('researchBrowserNotStarted')}</span>
            <button className="quiet-button" disabled={!browserStatus} onClick={() => void refreshBrowserStatus()} type="button">
              <RefreshCw size={14} />
              {label('refresh')}
            </button>
          </div>
          <div className="research-site-list">
            {LOGIN_SITES.map((site) => {
              const siteStatus = browserStatus?.sites[site]
              const isOpen = loginOpen === site
              const isBusy = loginPending === site
              return (
                <div className="research-site-row" key={site}>
                  <span className="setting-icon"><Globe2 size={16} /></span>
                  <div className="setting-copy">
                    <strong>{label(siteLabelKey(site))}</strong>
                    <span>{siteStatus?.loggedIn ? label('researchLoggedIn') : label('researchNotLoggedIn')}</span>
                    {siteStatus?.challengeBackoffUntil && <small>{label('researchBackoffUntil')} · {siteStatus.challengeBackoffUntil}</small>}
                  </div>
                  <button className={isOpen ? 'accent-button' : 'quiet-button'} disabled={isBusy} onClick={() => void (isOpen ? finishLogin(site) : startLogin(site))} type="button">
                    {isBusy ? <RefreshCw className="spin" size={14} /> : <LogIn size={14} />}
                    {isOpen ? label('researchConfirmLogin') : label('researchLogin')}
                  </button>
                </div>
              )
            })}
          </div>
          {challenge && (
            <div className="research-challenge" role="alert">
              <ShieldAlert size={16} />
              <span>{label('researchChallengeMessage')} · {['facebook', 'x', 'reddit'].includes(challenge.site) ? label(siteLabelKey(challenge.site as ResearchLoginSite)) : challenge.site}</span>
              <button className="quiet-button" onClick={() => void resolveChallenge()} type="button">{label('researchChallengeResolved')}</button>
            </div>
          )}
          {browserError && <span className="inline-status error" title={browserError}>{label('researchBrowserUnavailable')}</span>}
        </section>

        <section className="settings-section">
          <SectionHeading icon={<Palette size={19} />} title={label('appearanceSection')} detail={label('appearanceDetail')} />
          <div className="settings-fields">
            <SettingField icon={draft.theme === 'dark' ? <Moon size={18} /> : <Sun size={18} />} label={label('theme')} detail={label('themeDetail')}>
              <select aria-label={label('theme')} onChange={(event) => setValue('theme', event.target.value as AppSettings['theme'])} value={draft.theme}>
                <option value="dark">{label('dark')}</option>
                <option value="light">{label('light')}</option>
              </select>
            </SettingField>
            <SettingField icon={<Languages size={18} />} label={label('locale')} detail={label('languageHint')}>
              <select aria-label={label('locale')} onChange={(event) => setValue('locale', event.target.value as AppSettings['locale'])} value={draft.locale}>
                <option value="ar">{label('arabic')}</option>
                <option value="en">{label('english')}</option>
              </select>
            </SettingField>
          </div>
        </section>

        <footer className="settings-footer">
          <span className="save-note"><Check size={15} /> {label('localStorageNote')}</span>
          <button className="save-button" disabled={saveState === 'saving'} onClick={() => void save()} type="button">
            {saveState === 'saving' ? label('saving') : saveState === 'saved' ? label('saved') : saveState === 'error' ? label('saveError') : label('saveChanges')}
          </button>
        </footer>
      </div>
    </main>
  )
}

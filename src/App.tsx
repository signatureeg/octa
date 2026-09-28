import { useEffect, useState } from 'react'
import type { AppSettings, AppUpdate, UpdateProgress } from '../electron/types'
import { DEFAULT_SETTINGS } from '../electron/types'
import { applyLocale, type Locale } from './i18n'
import { t } from './i18n'
import { SettingsPage } from './components/SettingsPage'
import { FirstRun } from './components/FirstRun'
import { HealthPage } from './components/HealthPage'
import { BrainPage } from './components/BrainPage'
import { JobsPage } from './components/JobsPage'
import { MapPage } from './components/MapPage'
import { SkillsPage } from './components/SkillsPage'
import { OctaPage } from './components/OctaPage'
import { WorkflowsPage } from './components/WorkflowsPage'
import { AgentsPage } from './components/AgentsPage'
import { BuildsPage } from './components/BuildsPage'
import { TasksPage } from './components/TasksPage'
import { ClientsPage } from './components/ClientsPage'
import { Sidebar, type Page } from './components/Sidebar'
import { VoiceBar } from './components/VoiceBar'
import { VoiceAudioPlayback } from './components/VoiceAudioPlayback'
import { VoiceInputBridge } from './components/VoiceInputBridge'
import { OctaMark } from './components/OctaMark'
import { WindowChrome } from './components/WindowChrome'

function formatBytes(value: number, locale: Locale): string {
  const units = locale === 'ar' ? ['بايت', 'ك.ب', 'م.ب', 'ج.ب'] : ['B', 'KB', 'MB', 'GB']
  let size = Math.max(0, value)
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${new Intl.NumberFormat(locale === 'ar' ? 'ar-EG' : 'en-US', { maximumFractionDigits: unit >= 2 ? 1 : 0 }).format(size)} ${units[unit]}`
}

function fill(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, value), template)
}

function UpdateBanner({
  update,
  progress,
  locale,
  onOpen,
  onDownload,
  onInstall
}: {
  update: AppUpdate
  progress: UpdateProgress | null
  locale: Locale
  onOpen: (url: string) => Promise<void>
  onDownload: () => Promise<void>
  onInstall: () => Promise<void>
}): React.JSX.Element | null {
  if (update.status !== 'available' || !update.downloadUrl || !update.latestVersion) return null
  const version = update.latestVersion.replace(/^v/i, '')
  const phase = progress?.phase ?? 'idle'
  const numbers = new Intl.NumberFormat(locale === 'ar' ? 'ar-EG' : 'en-US')
  const releaseUrl = update.releaseUrl ?? update.downloadUrl
  const releaseLink = (
    <a className="update-banner-link secondary" href={releaseUrl} onClick={(event) => { event.preventDefault(); void onOpen(releaseUrl) }} rel="noreferrer" target="_blank">
      {t('updateOpenRelease', locale)}
    </a>
  )

  let detail = t('updateBannerDetail', locale)
  let action: React.ReactNode = (
    <button className="update-banner-link" onClick={() => void onDownload()} type="button">{t('updateDownload', locale)}</button>
  )
  if (phase === 'checking' || phase === 'available') {
    detail = t('updateChecking', locale)
    action = null
  } else if (phase === 'downloading' && progress) {
    detail = fill(t(progress.mode === 'app' ? 'updateDownloadingApp' : progress.differential ? 'updateDownloadingDelta' : 'updateDownloading', locale), {
      percent: numbers.format(progress.percent),
      transferred: formatBytes(progress.transferred, locale),
      total: formatBytes(progress.total, locale)
    })
    action = null
  } else if (phase === 'downloaded') {
    detail = fill(t('updateDownloaded', locale), { version })
    action = <button className="update-banner-link" onClick={() => void onInstall()} type="button">{t('updateInstall', locale)}</button>
  } else if (phase === 'error' && progress) {
    detail = fill(t('updateFailed', locale), { error: progress.error ?? '' })
    action = (
      <>
        <button className="update-banner-link" onClick={() => void onDownload()} type="button">{t('updateRetry', locale)}</button>
        {releaseLink}
      </>
    )
  } else if (phase === 'unsupported') {
    detail = t('updateUnsupported', locale)
    action = releaseLink
  }

  return (
    <aside className="update-banner" role="status" aria-live="polite">
      <div className="update-banner-copy">
        <strong>{fill(t('updateAvailable', locale), { version })}</strong>
        <span>{detail}</span>
        {phase === 'downloading' && progress && (
          <div className="update-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent}>
            <div className="update-progress-fill" style={{ width: `${progress.percent}%` }} />
          </div>
        )}
      </div>
      <div className="update-banner-actions">{action}</div>
    </aside>
  )
}

export function App(): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [page, setPage] = useState<Page>('octa')
  const [loading, setLoading] = useState(true)
  const [firstRun, setFirstRun] = useState(true)
  const [showFirstRun, setShowFirstRun] = useState(false)
  const [version, setVersion] = useState('0.1.0')
  const [update, setUpdate] = useState<AppUpdate | null>(null)
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress | null>(null)
  const locale: Locale = settings.locale

  useEffect(() => {
    applyLocale(locale)
    document.documentElement.dataset.theme = settings.theme
  }, [locale, settings.theme])

  useEffect(() => {
    let active = true
    void window.octa.state().then((state) => {
      if (!active) return
      setSettings(state.settings)
      setFirstRun(state.firstRun)
      setShowFirstRun(state.firstRun)
      setVersion(state.version)
      setLoading(false)
    }).catch(() => {
      if (active) setLoading(false)
    })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => window.octa.onSettingsChanged(setSettings), [])
  useEffect(() => window.octa.update.onProgress(setUpdateProgress), [])

  useEffect(() => {
    let active = true
    void window.octa.update.check().then((result) => {
      if (active) setUpdate(result)
    }).catch(() => {
      // An unavailable network must not block the desktop app.
    })
    return () => {
      active = false
    }
  }, [])

  const updateSettings = async (update: Partial<AppSettings>): Promise<AppSettings> => {
    const next = await window.octa.settings.update(update)
    setSettings(next)
    return next
  }

  const toggleLocale = (): void => {
    void updateSettings({ locale: locale === 'ar' ? 'en' : 'ar' })
  }

  const runHealth = (): Promise<import('../electron/core/octa/health').HealthReport> => window.octa.health.run()
  const installHealthDependency = (kind: import('../electron/core/octa/health').GuidedInstallKind): Promise<import('../electron/core/octa/health').GuidedInstallResult> => window.octa.health.install(kind)
  const onHealthInstallOutput = (listener: Parameters<typeof window.octa.health.onInstallOutput>[0]): (() => void) => window.octa.health.onInstallOutput(listener)

  const completeFirstRun = async (): Promise<void> => {
    const state = await window.octa.firstRun.complete()
    setSettings(state.settings)
    setFirstRun(state.firstRun)
    setShowFirstRun(false)
  }

  if (loading) {
    return (
      <WindowChrome locale={locale}>
        <div className="app-loading">
          <OctaMark className="brand-mark" alt={t('brandName', locale)} />
        </div>
      </WindowChrome>
    )
  }

  if (showFirstRun) {
    return (
      <WindowChrome locale={locale}>
      <FirstRun
        locale={locale}
        onCancel={() => setShowFirstRun(false)}
        onComplete={completeFirstRun}
        onInstall={installHealthDependency}
        onInstallOutput={onHealthInstallOutput}
        onRunHealth={runHealth}
        onUpdate={updateSettings}
        required={firstRun}
        settings={settings}
      />
      </WindowChrome>
    )
  }

  return (
    <WindowChrome locale={locale}>
    <div className="app-shell octa-shell">
      <VoiceAudioPlayback />
      <VoiceInputBridge enabled={settings.wakeWordEnabled || settings.pushToTalkEnabled} />
      <div className="workspace">
        <Sidebar page={page} locale={locale} onChange={setPage} onToggleLocale={toggleLocale} />
        <section className="content">
          {update && (
            <UpdateBanner
              update={update}
              progress={updateProgress}
              locale={locale}
              onOpen={(url) => window.octa.update.open(url)}
              onDownload={async () => { setUpdateProgress(await window.octa.update.download()) }}
              onInstall={async () => { await window.octa.update.install() }}
            />
          )}
          <VoiceBar locale={locale} />
          {page === 'octa' && <OctaPage locale={locale} onOpenSetup={() => setShowFirstRun(true)} />}
          {page === 'settings' && (
            <SettingsPage
              settings={settings}
              locale={locale}
              onUpdate={updateSettings}
              onAiTest={() => window.octa.ai.test()}
              onNotifyTest={() => window.octa.notify.test()}
              onOpenFirstRun={() => setShowFirstRun(true)}
              version={version}
            />
          )}
          {page === 'health' && (
            <HealthPage
              locale={locale}
              onInstall={installHealthDependency}
              onInstallOutput={onHealthInstallOutput}
              onOpenSetup={() => setShowFirstRun(true)}
              onRun={runHealth}
              settings={settings}
            />
          )}
          {page === 'brain' && <BrainPage locale={locale} />}
          {page === 'map' && <MapPage locale={locale} />}
          {page === 'jobs' && <JobsPage locale={locale} />}
          {page === 'tasks' && <TasksPage locale={locale} onBack={() => setPage('octa')} />}
          {page === 'clients' && <ClientsPage locale={locale} onBack={() => setPage('octa')} />}
          {page === 'workflows' && <WorkflowsPage locale={locale} />}
          {page === 'agents' && <AgentsPage locale={locale} />}
          {page === 'skills' && <SkillsPage locale={locale} />}
          {page === 'builds' && <BuildsPage locale={locale} />}
        </section>
      </div>
    </div>
    </WindowChrome>
  )
}

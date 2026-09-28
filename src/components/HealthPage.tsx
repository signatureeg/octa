import { useEffect, useState } from 'react'
import {
  Check,
  CircleAlert,
  Download,
  HeartPulse,
  RefreshCw,
  Terminal,
  Wrench
} from 'lucide-react'
import type {
  GuidedInstallKind,
  GuidedInstallResult,
  HealthCheckEntry,
  HealthCheckId,
  HealthOutputStream,
  HealthReport
} from '../../electron/core/octa/health'
import type { AppSettings } from '../../electron/types'
import type { Locale, TranslationKey } from '../i18n'
import { t } from '../i18n'

export interface HealthInstallOutput {
  kind: GuidedInstallKind
  stream: HealthOutputStream
  text: string
}

export interface HealthPageProps {
  settings: AppSettings
  locale: Locale
  onRun: () => Promise<HealthReport>
  onInstall: (kind: GuidedInstallKind) => Promise<GuidedInstallResult>
  onInstallOutput?: (listener: (event: HealthInstallOutput) => void) => () => void
  onOpenSetup?: () => void
  compact?: boolean
}

const HEALTH_LABELS: Record<HealthCheckId, TranslationKey> = {
  node: 'healthNode',
  claude: 'healthClaude',
  codex: 'healthCodex',
  python: 'healthPython',
  playwright: 'healthPlaywright',
  ffmpeg: 'healthFfmpeg',
  photoshop: 'healthPhotoshop',
  brave: 'healthBrave',
  gemini: 'healthGemini',
  vault: 'healthVault',
  'octa-home': 'healthOctaHome',
  'research-browser': 'healthResearchBrowser',
  'wake-word': 'healthWakeWord',
  models: 'healthModels'
}

function installLabel(kind: GuidedInstallKind, locale: Locale): string {
  return t(kind === 'python' ? 'healthInstallPython' : 'healthInstallPlaywright', locale)
}

/** Health fixes are written "English / عربي"; show the half that matches the UI language. */
function localizedFix(fix: string, locale: Locale): string {
  const [english, arabic] = fix.split(' / ')
  return (locale === 'ar' ? arabic : english)?.trim() || fix
}

function actionFor(check: HealthCheckEntry): 'python' | 'playwright' | 'setup' | null {
  if (check.id === 'python') return check.ok ? null : 'python'
  if (check.id === 'playwright') return check.ok ? null : 'playwright'
  return check.fix ? 'setup' : null
}

export function HealthPage({
  settings,
  locale,
  onRun,
  onInstall,
  onInstallOutput,
  onOpenSetup,
  compact = false
}: HealthPageProps): React.JSX.Element {
  const [report, setReport] = useState<HealthReport | null>(null)
  const [running, setRunning] = useState(false)
  const [installing, setInstalling] = useState<GuidedInstallKind | null>(null)
  const [installOutput, setInstallOutput] = useState('')
  const [error, setError] = useState('')

  const label = (key: TranslationKey): string => t(key, locale)

  const run = async (): Promise<void> => {
    setRunning(true)
    setError('')
    try {
      setReport(await onRun())
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value))
    } finally {
      setRunning(false)
    }
  }

  useEffect(() => {
    void run()
    // The health page runs once when it becomes visible. The button can run it
    // again without restarting the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!onInstallOutput) return undefined
    return onInstallOutput((event) => {
      if (event.kind !== installing) return
      setInstallOutput((current) => `${current}${event.text}`)
    })
  }, [installing, onInstallOutput])

  const install = async (kind: GuidedInstallKind): Promise<void> => {
    setInstalling(kind)
    setInstallOutput('')
    setError('')
    try {
      const result = await onInstall(kind)
      if (result.output || result.error) {
        setInstallOutput(`${result.output}${result.error ? `\n${result.error}` : ''}`)
      }
      if (!result.ok) setError(result.error || label('healthInstallFailed'))
      await run()
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value))
    } finally {
      setInstalling(null)
    }
  }

  const checkStatus = (check: HealthCheckEntry): string => {
    if (check.ok && check.fix) return label('healthOptional')
    return check.ok ? label('healthPassed') : label('healthFailed')
  }

  const action = (check: HealthCheckEntry): React.JSX.Element | null => {
    const target = actionFor(check)
    if (!target) return null
    if (target === 'setup') {
      return onOpenSetup ? (
        <button className="quiet-button health-action" onClick={onOpenSetup} type="button">
          <Wrench size={14} aria-hidden="true" />
          {label('healthOpenSetup')}
        </button>
      ) : null
    }
    const busy = installing === target
    return (
      <button
        className="quiet-button health-action"
        disabled={installing !== null || running}
        onClick={() => void install(target)}
        type="button"
      >
        {busy ? <RefreshCw className="spin" size={14} aria-hidden="true" /> : <Download size={14} aria-hidden="true" />}
        {busy ? label('healthInstalling') : installLabel(target, locale)}
      </button>
    )
  }

  const body = report ? (
    <>
      <div className={`health-summary${report.ok ? '' : ' health-summary-failed'}`} role="status">
        {report.ok ? <Check size={17} aria-hidden="true" /> : <CircleAlert size={17} aria-hidden="true" />}
        <div>
          <strong>{report.ok ? label('healthPassed') : label('healthNeedsAttention')}</strong>
          <span>{label('healthLastRun')} · {new Date(report.checkedAt).toLocaleString(locale === 'ar' ? 'ar-EG' : 'en-US')}</span>
        </div>
      </div>
      <div className="health-list" role="list">
        {report.checks.map((check) => (
          <div className={`health-row ${check.ok ? 'health-row-ok' : 'health-row-failed'}`} key={check.id} role="listitem">
            <span className="health-row-icon" aria-hidden="true">
              {check.ok ? <Check size={15} /> : <CircleAlert size={15} />}
            </span>
            <div className="health-row-copy">
              <strong>{label(HEALTH_LABELS[check.id])}</strong>
              <span><bdi>{check.detail}</bdi></span>
              {check.fix && <small><Wrench size={12} aria-hidden="true" /> <bdi>{localizedFix(check.fix, locale)}</bdi></small>}
            </div>
            <div className="health-row-end">
              <span className={`health-status ${check.ok ? 'health-status-ok' : 'health-status-failed'}`}>{checkStatus(check)}</span>
              {action(check)}
            </div>
          </div>
        ))}
      </div>
    </>
  ) : (
    <div className="health-empty">
      <HeartPulse size={20} aria-hidden="true" />
      <span>{label('healthNotRun')}</span>
    </div>
  )

  const output = installOutput ? (
    <section className="health-output" aria-live="polite">
      <header><Terminal size={14} aria-hidden="true" /><strong>{label('healthInstallOutput')}</strong></header>
      <pre>{installOutput}</pre>
    </section>
  ) : null

  if (compact) {
    return (
      <div className="health-compact">
        <div className="health-compact-heading">
          <div><span className="health-kicker">{label('healthEyebrow')}</span><h2>{label('healthTitle')}</h2></div>
          <button className="quiet-button" disabled={running || installing !== null} onClick={() => void run()} type="button">
            <RefreshCw className={running ? 'spin' : ''} size={14} aria-hidden="true" />
            {running ? label('healthRunning') : label('healthRun')}
          </button>
        </div>
        <div className="health-panel glass">{body}</div>
        {error && <p className="health-error" role="alert">{error}</p>}
        {output}
      </div>
    )
  }

  return (
    <main className="page health-page">
      <header className="page-heading">
        <div>
          <span className="eyebrow">{label('healthEyebrow')}</span>
          <h1>{label('healthTitle')}</h1>
          <p>{label('healthIntro')}</p>
        </div>
        <button className="accent-button" disabled={running || installing !== null} onClick={() => void run()} type="button">
          <RefreshCw className={running ? 'spin' : ''} size={15} aria-hidden="true" />
          {running ? label('healthRunning') : label('healthRun')}
        </button>
      </header>
      <section className="health-panel glass">
        <div className="health-context"><HeartPulse size={17} aria-hidden="true" /><span>{settings.octaHomePath}</span></div>
        {body}
      </section>
      {error && <p className="health-error" role="alert">{error}</p>}
      {output}
    </main>
  )
}

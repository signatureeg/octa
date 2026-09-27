import type { AppUpdate, UpdateProgress } from '../../types'
import { normalizeRepository, DEFAULT_UPDATE_REPOSITORY } from './update'

/**
 * Differential in-app updates.
 *
 * electron-builder publishes, next to every NSIS installer, a `.blockmap` and a `latest.yml`.
 * electron-updater compares the blockmap of the installed version with the blockmap of the new
 * one and downloads only the blocks that changed (HTTP range requests against the GitHub release
 * asset), so a small fix does not re-download the whole ~150 MB installer. Both releases must keep
 * their assets on GitHub for this to work; when the old blockmap is missing the updater silently
 * falls back to a full download and `differential` is reported as false.
 */

export type UpdateFeed =
  | { provider: 'github'; owner: string; repo: string }
  | { provider: 'generic'; url: string }

/** Minimal surface of electron-updater's autoUpdater used here, so tests can inject a fake. */
export interface UpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowDowngrade: boolean
  disableDifferentialDownload: boolean
  setFeedURL(feed: UpdateFeed): void
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  on(event: string, listener: (...args: any[]) => void): unknown
}

export interface AutoUpdateOptions {
  updater: UpdaterLike
  /** Whether the running app is a packaged install; dev builds only open the browser. */
  packaged: boolean
  currentVersion: string
  getRepository: () => string | undefined
  /** Optional: a specific release's download base when the latest release has no installer (app-only). */
  resolveFeed?: () => Promise<UpdateFeed | null>
  onProgress: (progress: UpdateProgress) => void
  now?: () => number
}

export function feedForRepository(configured: string | undefined): UpdateFeed {
  const slug = normalizeRepository(configured?.trim() || DEFAULT_UPDATE_REPOSITORY) ?? DEFAULT_UPDATE_REPOSITORY
  const [owner, repo] = slug.split('/')
  return { provider: 'github', owner, repo }
}

/** electron-updater errors embed whole HTTP responses; keep the first line so the banner stays readable. */
export function shortError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const firstLine = text.split(/\r?\n/).find((line) => line.trim()) ?? ''
  return firstLine.length > 240 ? firstLine.slice(0, 237) + '…' : firstLine
}

export function idleProgress(currentVersion: string): UpdateProgress {
  return { phase: 'idle', currentVersion, percent: 0, transferred: 0, total: 0, bytesPerSecond: 0, differential: false }
}

interface DownloadProgressEvent {
  percent?: number
  transferred?: number
  total?: number
  bytesPerSecond?: number
}

export class AutoUpdateController {
  private progress: UpdateProgress
  private feedRepository = ''
  private differential = false

  constructor(private readonly options: AutoUpdateOptions) {
    this.progress = { ...idleProgress(options.currentVersion), mode: 'full' }
    const updater = options.updater
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = true
    updater.allowDowngrade = false
    updater.disableDifferentialDownload = false
    updater.on('checking-for-update', () => this.set({ phase: 'checking' }))
    updater.on('update-available', (info: { version?: string }) => this.set({ phase: 'available', version: info?.version }))
    updater.on('update-not-available', (info: { version?: string }) => this.set({ phase: 'current', version: info?.version }))
    updater.on('download-progress', (event: DownloadProgressEvent) => this.set({
      phase: 'downloading',
      percent: Math.max(0, Math.min(100, Math.round(event.percent ?? 0))),
      transferred: event.transferred ?? 0,
      total: event.total ?? 0,
      bytesPerSecond: event.bytesPerSecond ?? 0,
      differential: this.differential
    }))
    updater.on('update-downloaded', (info: { version?: string }) => this.set({ phase: 'downloaded', percent: 100, version: info?.version ?? this.progress.version, differential: this.differential }))
    updater.on('error', (error: unknown) => this.set({ phase: 'error', error: shortError(error) }))
  }

  /** electron-updater logs "Differential download" through its logger; the main process forwards that signal here. */
  markDifferential(value: boolean): void {
    this.differential = value
  }

  state(): UpdateProgress {
    return this.progress
  }

  get supported(): boolean {
    return this.options.packaged
  }

  private set(patch: Partial<UpdateProgress>): void {
    this.progress = { ...this.progress, ...patch, mode: 'full', currentVersion: this.options.currentVersion, updatedAt: (this.options.now ?? Date.now)() }
    this.options.onProgress(this.progress)
  }

  private async applyFeed(): Promise<void> {
    const feed = (await this.options.resolveFeed?.()) ?? feedForRepository(this.options.getRepository())
    const key = feed.provider === 'github' ? `${feed.owner}/${feed.repo}` : feed.url
    if (key === this.feedRepository) return
    this.options.updater.setFeedURL(feed)
    this.feedRepository = key
  }

  /** Start (or restart) a differential download of the latest release. Resolves once the download has been requested. */
  async download(latest?: AppUpdate): Promise<UpdateProgress> {
    if (!this.supported) {
      this.set({ phase: 'unsupported', version: latest?.latestVersion })
      return this.progress
    }
    if (this.progress.phase === 'downloading' || this.progress.phase === 'downloaded') return this.progress
    await this.applyFeed()
    this.differential = false
    this.set({ phase: 'checking', version: latest?.latestVersion, percent: 0, transferred: 0, total: 0, error: undefined })
    try {
      await this.options.updater.checkForUpdates()
      if (this.progress.phase === 'available') {
        this.set({ phase: 'downloading', percent: 0 })
        await this.options.updater.downloadUpdate()
      }
    } catch (error) {
      this.set({ phase: 'error', error: shortError(error) })
    }
    return this.progress
  }

  /** Quit and run the downloaded installer silently, then relaunch. */
  install(): boolean {
    if (this.progress.phase !== 'downloaded') return false
    this.options.updater.quitAndInstall(true, true)
    return true
  }
}

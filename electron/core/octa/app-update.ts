import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import type { AppUpdate, UpdateProgress } from '../../types'
import { compareVersions } from './update'
import { idleProgress, shortError } from './auto-update'

/**
 * App-only updates.
 *
 * A release can carry `app-update.json` plus a small `octa-app-<version>.asar`: the compiled app
 * (`out/` + package.json, a few MB) without Electron or node_modules. The client downloads the asar,
 * verifies its SHA-512, and on "Restart and update" a detached cmd script waits for the app to exit,
 * swaps `resources/app.asar`, and relaunches. Only installs whose runtime id (Electron version +
 * unpacked node_modules) matches the manifest may apply it; everyone else falls back to the full
 * installer. Keeps a `.bak` of the previous asar and restores it if the swap fails.
 */

export interface AppUpdateManifest {
  version: string
  file: string
  size: number
  sha512: string
  runtimeId: string
  electronVersion: string
}

export interface AppUpdateResponse {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  json(): Promise<unknown>
  body: ReadableStream<Uint8Array> | null
}

export type AppUpdateFetcher = (url: string, init?: { headers?: Record<string, string> }) => Promise<AppUpdateResponse>

export interface AppUpdateOptions {
  packaged: boolean
  currentVersion: string
  runtimeId: string
  /** Where downloads and the pending marker live (an Octa home subfolder). */
  updatesDir: string
  /** The running executable and its resources folder (app.getPath('exe'), process.resourcesPath). */
  exePath: string
  resourcesPath: string
  pid: number
  onProgress: (progress: UpdateProgress) => void
  fetcher?: AppUpdateFetcher
  spawnScript?: (scriptPath: string) => void
  quit?: () => void
  now?: () => number
}

export function parseAppUpdateManifest(value: unknown): AppUpdateManifest | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const text = (key: string): string => (typeof record[key] === 'string' ? (record[key] as string).trim() : '')
  const manifest: AppUpdateManifest = {
    version: text('version').replace(/^v/i, ''),
    file: text('file'),
    size: typeof record.size === 'number' ? record.size : Number(record.size ?? 0),
    sha512: text('sha512').toLowerCase(),
    runtimeId: text('runtimeId'),
    electronVersion: text('electronVersion')
  }
  if (!manifest.version || !manifest.file || !/^[0-9a-f]{128}$/.test(manifest.sha512) || !manifest.runtimeId) return null
  if (!/^[A-Za-z0-9._-]+\.asar$/.test(manifest.file)) return null
  return manifest
}

/** Whether this install can take the app-only update instead of the full installer. */
export function appUpdateApplies(manifest: AppUpdateManifest, currentVersion: string, runtimeId: string): boolean {
  return manifest.runtimeId === runtimeId && compareVersions(currentVersion, manifest.version) < 0
}

/** The cmd script that swaps app.asar once the app has exited. Kept as a function so tests can inspect it. */
export function applyScript(options: { pid: number; exePath: string; resourcesPath: string; downloadedAsar: string; pendingFile: string }): string {
  const q = (value: string): string => `"${value.replace(/"/g, '')}"`
  return [
    '@echo off',
    `set "LOG=${options.pendingFile.replace(/pending\.json$/, 'apply-update.log').replace(/"/g, '')}"`,
    `echo %DATE% %TIME% waiting for pid ${options.pid} >> "%LOG%"`,
    `set "RES=${options.resourcesPath.replace(/"/g, '')}"`,
    ':wait',
    `tasklist /FI "PID eq ${options.pid}" 2>NUL | find "${options.pid}" >NUL`,
    'if not errorlevel 1 (timeout /t 1 /nobreak >NUL & goto wait)',
    'if exist "%RES%\\app.asar.bak" del /f /q "%RES%\\app.asar.bak" >NUL 2>&1',
    'copy /y "%RES%\\app.asar" "%RES%\\app.asar.bak" >NUL',
    `move /y ${q(options.downloadedAsar)} "%RES%\\app.asar" >NUL`,
    'echo %DATE% %TIME% move exit %ERRORLEVEL% >> "%LOG%"',
    'if errorlevel 1 (',
    '  copy /y "%RES%\\app.asar.bak" "%RES%\\app.asar" >NUL',
    `  del /f /q ${q(options.pendingFile)} >NUL 2>&1`,
    ')',
    `start "" ${q(options.exePath)}`,
    'exit /b 0',
    ''
  ].join('\r\n')
}

export class AppUpdateController {
  private progress: UpdateProgress
  private manifest: AppUpdateManifest | null = null
  private downloadedPath: string | null = null

  constructor(private readonly options: AppUpdateOptions) {
    this.progress = { ...idleProgress(options.currentVersion), mode: 'app' }
  }

  state(): UpdateProgress {
    return this.progress
  }

  get ready(): boolean {
    return this.progress.phase === 'downloaded' && this.downloadedPath !== null
  }

  private set(patch: Partial<UpdateProgress>): void {
    this.progress = { ...this.progress, ...patch, mode: 'app', currentVersion: this.options.currentVersion, updatedAt: (this.options.now ?? Date.now)() }
    this.options.onProgress(this.progress)
  }

  /** Fetch and validate the manifest; null when the release has none or it does not apply to this install. */
  async check(update: AppUpdate): Promise<AppUpdateManifest | null> {
    if (!this.options.packaged || !update.appUpdateUrl) return null
    const fetcher = this.options.fetcher ?? defaultFetcher
    try {
      const response = await fetcher(update.appUpdateUrl, { headers: { Accept: 'application/json', 'User-Agent': `Octa-Assistant/${this.options.currentVersion}` } })
      if (!response.ok) return null
      const manifest = parseAppUpdateManifest(await response.json())
      if (!manifest || !appUpdateApplies(manifest, this.options.currentVersion, this.options.runtimeId)) return null
      this.manifest = manifest
      return manifest
    } catch {
      return null
    }
  }

  /** Download the asar next to the pending marker and verify it. */
  async download(update: AppUpdate): Promise<UpdateProgress> {
    if (this.progress.phase === 'downloading' || this.progress.phase === 'downloaded') return this.progress
    const manifest = this.manifest ?? (await this.check(update))
    if (!manifest) {
      this.set({ phase: 'error', error: 'This release has no app-only update for this install.' })
      return this.progress
    }
    const base = update.appUpdateUrl!.replace(/[^/]+$/, '')
    const url = base + manifest.file
    // Electron's fs shim treats any path ending in ".asar" as an archive and refuses to write it, so download as .pkg.
    const target = join(this.options.updatesDir, `octa-app-${manifest.version}.pkg`)
    mkdirSync(this.options.updatesDir, { recursive: true })
    this.set({ phase: 'downloading', version: manifest.version, percent: 0, transferred: 0, total: manifest.size, bytesPerSecond: 0, differential: true, error: undefined })
    try {
      const fetcher = this.options.fetcher ?? defaultFetcher
      const response = await fetcher(url, { headers: { 'User-Agent': `Octa-Assistant/${this.options.currentVersion}` } })
      if (!response.ok || !response.body) throw new Error(`Download failed with HTTP ${response.status}.`)
      const total = Number(response.headers.get('content-length') ?? manifest.size) || manifest.size
      const hash = createHash('sha512')
      const file = createWriteStream(target)
      file.on('error', () => { /* surfaced through the write callback below */ })
      const reader = response.body.getReader()
      const started = (this.options.now ?? Date.now)()
      let transferred = 0
      let lastReport = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        hash.update(value)
        await new Promise<void>((resolve, reject) => file.write(value, (error) => (error ? reject(error) : resolve())))
        transferred += value.byteLength
        const elapsed = Math.max(1, (this.options.now ?? Date.now)() - started)
        if (transferred - lastReport >= 256 * 1024 || transferred === total) {
          lastReport = transferred
          this.set({ phase: 'downloading', percent: Math.min(100, Math.round((transferred / total) * 100)), transferred, total, bytesPerSecond: Math.round((transferred / elapsed) * 1000) })
        }
      }
      await new Promise<void>((resolve, reject) => file.end((error?: Error | null) => (error ? reject(error) : resolve())))
      const digest = hash.digest('hex')
      if (digest !== manifest.sha512) {
        rmSync(target, { force: true })
        throw new Error('The downloaded update did not match its checksum.')
      }
      this.downloadedPath = target
      this.set({ phase: 'downloaded', percent: 100, transferred, total, version: manifest.version })
    } catch (error) {
      rmSync(target, { force: true })
      this.set({ phase: 'error', error: shortError(error) })
    }
    return this.progress
  }

  /** Write the swap script, mark the update pending, launch the script detached and quit. */
  install(): boolean {
    if (!this.ready || !this.manifest || !this.downloadedPath) return false
    const pendingFile = join(this.options.updatesDir, 'pending.json')
    const scriptPath = join(this.options.updatesDir, 'apply-update.cmd')
    writeFileSync(pendingFile, JSON.stringify({ version: this.manifest.version, from: this.options.currentVersion, at: new Date().toISOString() }, null, 2))
    writeFileSync(scriptPath, applyScript({
      pid: this.options.pid,
      exePath: this.options.exePath,
      resourcesPath: this.options.resourcesPath,
      downloadedAsar: this.downloadedPath,
      pendingFile
    }))
    const launch = this.options.spawnScript ?? launchOutsideJob
    launch(scriptPath)
    this.options.quit?.()
    return true
  }
}

/** On startup: report whether a pending app update landed, and clean up. Returns a log line or null. */
export function settlePendingAppUpdate(updatesDir: string, currentVersion: string, resourcesPath: string): string | null {
  const pendingFile = join(updatesDir, 'pending.json')
  if (!existsSync(pendingFile)) return null
  let pending: { version?: string; from?: string } = {}
  try {
    pending = JSON.parse(readFileSync(pendingFile, 'utf8')) as { version?: string; from?: string }
  } catch {
    // A corrupt marker is simply discarded below.
  }
  try {
    unlinkSync(pendingFile)
  } catch {
    // Best effort.
  }
  const applied = pending.version !== undefined && compareVersions(currentVersion, pending.version) === 0
  if (applied) {
    rmSync(join(resourcesPath, 'app.asar.bak'), { force: true })
    rmSync(join(updatesDir, 'apply-update.cmd'), { force: true })
    return `app update to ${pending.version} applied`
  }
  return `app update to ${pending.version ?? '?'} did not apply; still running ${currentVersion}`
}

/**
 * Electron's main process lives in a Windows job object, so a plain detached child dies with it.
 * WMI's Win32_Process.Create starts the script from the WMI host, outside our job; a detached spawn
 * is the fallback when PowerShell is unavailable.
 */
function launchOutsideJob(scriptPath: string): void {
  const commandLine = `cmd.exe /c "${scriptPath}"`.replace(/'/g, "''")
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${commandLine}' }; exit [int]$r.ReturnValue`
  ], { windowsHide: true, timeout: 15_000 })
  if (result.status === 0) return
  const child = spawn('cmd.exe', ['/c', scriptPath], { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
}

const defaultFetcher: AppUpdateFetcher = async (url, init) => {
  const response = await fetch(url, { headers: init?.headers, redirect: 'follow' })
  return response as unknown as AppUpdateResponse
}

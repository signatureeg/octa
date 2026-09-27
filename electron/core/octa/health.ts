import { randomUUID } from 'node:crypto'
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import { detectObsidianVault, envPath, resolvePhotoshopPath, unpackedAsarPath } from './paths'
import type { AppSettings } from '../../types'
import type { ResearchBrowserStatus } from './browser'
import { GeminiClient } from '../../cloud/gemini'
import { resolveCliBinary } from '../jobs/runner'
import { phaseModel } from './models'

export const DEFAULT_HEALTH_OCTA_HOME = 'C:\\Octa'
export const HEALTH_COMMAND_TIMEOUT_MS = 5_000
// The authenticated ping is a real model round-trip, which routinely takes longer than a --version call.
export const HEALTH_PING_TIMEOUT_MS = 45_000

export const HEALTH_CHECK_IDS = [
  'node',
  'claude',
  'codex',
  'python',
  'playwright',
  'ffmpeg',
  'photoshop',
  'brave',
  'gemini',
  'vault',
  'octa-home',
  'research-browser',
  'wake-word'
] as const

export type HealthCheckId = (typeof HEALTH_CHECK_IDS)[number]

export interface HealthCheckResult {
  ok: boolean
  detail: string
  fix: string
}

export interface HealthCheckEntry extends HealthCheckResult {
  id: HealthCheckId
}

export interface HealthReport {
  ok: boolean
  checkedAt: string
  checks: HealthCheckEntry[]
}

export type HealthOutputStream = 'stdout' | 'stderr'

export interface HealthCommandOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  input?: string
  timeoutMs?: number
  onOutput?: (text: string, stream: HealthOutputStream) => void
}

export interface HealthCommandResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export type HealthCommandRunner = (
  executable: string,
  args: readonly string[],
  options?: HealthCommandOptions
) => Promise<HealthCommandResult>

export interface HealthFileSystem {
  exists(path: string): boolean
  isFile(path: string): boolean
  isDirectory(path: string): boolean
  isReadable(path: string): boolean
  list(path: string): string[]
  makeDirectory(path: string): void
  createExclusive(path: string): void
  remove(path: string): void
}

export interface HealthOptions {
  command?: HealthCommandRunner
  fileSystem?: HealthFileSystem
  environment?: NodeJS.ProcessEnv
  cwd?: string
  ffmpegPath?: string | null
  browserStatus?: () => ResearchBrowserStatus | Promise<ResearchBrowserStatus>
  geminiTest?: (apiKey: string, signal: AbortSignal) => Promise<string>
  resolveExecutable?: (name: string) => string
  /** false disables reading Obsidian's registry (tests). */
  detectVault?: boolean
  now?: () => Date
}

export type GuidedInstallKind = 'python' | 'playwright'

export interface GuidedInstallSpec {
  kind: GuidedInstallKind
  executable: string
  args: string[]
  env: NodeJS.ProcessEnv
  command: string
}

export interface GuidedInstallResult {
  kind: GuidedInstallKind
  ok: boolean
  command: string
  exitCode: number | null
  output: string
  error: string
}

export interface GuidedInstallOptions extends HealthOptions {
  onOutput?: (text: string, stream: HealthOutputStream) => void
}

const DEFAULT_FIXES: Record<HealthCheckId, string> = {
  node: 'Install Node.js 22.x and restart Octa. / ثبّت Node.js 22.x ثم أعد تشغيل أوكتا.',
  claude: 'Install Claude Code, sign in, then retry the check. / ثبّت Claude Code وسجّل الدخول ثم أعد الفحص.',
  codex: 'Install Codex CLI, sign in, then retry the check. / ثبّت Codex وسجّل الدخول ثم أعد الفحص.',
  python: 'Run the guided Python 3.12 install below. / شغّل تثبيت Python 3.12 الموجّه بالأسفل.',
  playwright: 'Run the guided Chromium install below. / شغّل تثبيت Chromium الموجّه بالأسفل.',
  ffmpeg: 'Reinstall the Octa package so ffmpeg-static is bundled. / أعد تثبيت حزمة أوكتا لتضمين ffmpeg-static.',
  photoshop: 'Set a valid Photoshop.exe path, or leave it empty to use the PSD fallback. / اكتب مسار Photoshop.exe صحيحًا أو اتركه فارغًا لاستخدام البديل.',
  brave: 'Optional: add a Brave Search key in Setup. / اختياري: أضف مفتاح Brave Search في الإعداد.',
  gemini: 'Add a Gemini API key in Setup and retry the connection. / أضف مفتاح Gemini API في الإعداد ثم أعد اختبار الاتصال.',
  vault: 'Choose a readable Obsidian vault folder in Setup. / اختر مجلد Obsidian قابلًا للقراءة في الإعداد.',
  'octa-home': 'Choose a writable folder outside AppData in Setup. / اختر مجلدًا قابلًا للكتابة خارج AppData في الإعداد.',
  'research-browser': 'Open Setup and sign in to the research sites you need. / افتح الإعداد وسجّل الدخول إلى مواقع البحث التي تحتاجها.',
  'wake-word': 'Restart Octa to restore the bundled wake-word models, or turn the wake word off in Settings and use push-to-talk. / أعد تشغيل أوكتا عشان يرجّع نماذج كلمة التنبيه، أو اقفل كلمة التنبيه من الإعدادات واستخدم زرار الكلام.'
}

function defaultFileSystem(): HealthFileSystem {
  return {
    exists: existsSync,
    isFile: (path) => {
      try {
        return statSync(path).isFile()
      } catch {
        return false
      }
    },
    isDirectory: (path) => {
      try {
        return statSync(path).isDirectory()
      } catch {
        return false
      }
    },
    isReadable: (path) => {
      try {
        accessSync(path, constants.R_OK)
        return true
      } catch {
        return false
      }
    },
    list: (path) => {
      try {
        return readdirSync(path)
      } catch {
        return []
      }
    },
    makeDirectory: (path) => mkdirSync(path, { recursive: true }),
    createExclusive: (path) => writeFileSync(path, '', { encoding: 'utf8', flag: 'wx' }),
    remove: unlinkSync
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function outputLine(result: HealthCommandResult): string {
  const text = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
  return text?.slice(0, 400) ?? ''
}

function success(detail: string, fix = ''): HealthCheckResult {
  return { ok: true, detail, fix }
}

function failure(detail: string, fix: string): HealthCheckResult {
  return { ok: false, detail, fix }
}

function optional(detail: string, fix: string): HealthCheckResult {
  return { ok: true, detail, fix }
}

function commandFailed(result: HealthCommandResult): boolean {
  return result.timedOut || result.code !== 0
}

/** Innermost human message of an error that may be JSON (Codex nests API errors as JSON strings). */
function unwrapMessage(value: unknown): string {
  if (typeof value === 'string') {
    try {
      return unwrapMessage(JSON.parse(value)) || value
    } catch {
      return value
    }
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return unwrapMessage(record.error) || unwrapMessage(record.message)
  }
  return ''
}

/**
 * The line that explains a failure. Codex `exec --json` prints JSON events and the first one is only
 * "thread.started", so prefer the last turn.failed / error event; otherwise the last line that reads like an error.
 */
function failureLine(result: HealthCommandResult): string {
  const lines = `${result.stdout}\n${result.stderr}`.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  for (const line of [...lines].reverse()) {
    if (!line.startsWith('{')) continue
    try {
      const event = JSON.parse(line) as { type?: string; message?: unknown; error?: unknown }
      if (event.type === 'turn.failed' || event.type === 'error') {
        const message = unwrapMessage(event.error ?? event.message)
        if (message) return message.slice(0, 400)
      }
    } catch {
      // not JSON
    }
  }
  const errorText = [...lines].reverse().find((line) => !line.startsWith('{') && /error|fail|denied|expired|not supported|unauthori[sz]ed|invalid/i.test(line))
  return errorText?.slice(0, 400) ?? outputLine(result)
}

function commandFailureDetail(label: string, result: HealthCommandResult, timeoutMs = HEALTH_COMMAND_TIMEOUT_MS): string {
  if (result.timedOut) return `${label} timed out after ${timeoutMs / 1_000} seconds.`
  const output = failureLine(result)
  return output ? `${label} failed: ${output}` : `${label} failed with exit code ${result.code ?? 'unknown'}.`
}

function isInside(root: string, target: string): boolean {
  const distance = relative(resolve(root), resolve(target))
  return distance === '' || (!distance.startsWith('..') && !isAbsolute(distance))
}

function isAppDataPath(path: string): boolean {
  return /[\\/]appdata(?:[\\/]|$)/i.test(resolve(path))
}

function resolveDefaultExecutable(name: string, environment: NodeJS.ProcessEnv): string {
  if (name === 'claude' || name === 'codex') {
    return resolveCliBinary(name, {
      ...environment,
      OS: environment.OS ?? (process.platform === 'win32' ? 'Windows_NT' : undefined)
    }) ?? name
  }
  if (name === 'npx' && process.platform === 'win32') return 'npx.cmd'
  return name
}

function commandRunner(options: HealthOptions): HealthCommandRunner {
  return options.command ?? runCommand
}

function commandExecutable(options: HealthOptions, name: string): string {
  return options.resolveExecutable?.(name) ?? resolveDefaultExecutable(name, options.environment ?? process.env)
}

function commandEnvironment(options: HealthOptions, additions: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, ...options.environment, ...additions }
}

function nativeExecutableOnPath(name: string, environment: NodeJS.ProcessEnv): string | undefined {
  const entries = envPath(environment).split(delimiter).filter(Boolean)
  for (const entry of entries) {
    const candidates = process.platform === 'win32'
      ? [join(entry, `${name}.exe`), join(entry, name)]
      : [join(entry, name)]
    const candidate = candidates.find((path) => existsSync(path))
    if (candidate) return candidate
  }
  return undefined
}

function nativeNpxInvocation(options: HealthOptions, args: readonly string[]): { executable: string; args: string[] } | undefined {
  if (options.resolveExecutable || process.platform !== 'win32') return undefined
  const environment = options.environment ?? process.env
  const nodeExecutable = environment.OCTA_NODE_BINARY?.trim() || nativeExecutableOnPath('node', environment)
  if (!nodeExecutable) return undefined
  const nodeDirectory = dirname(nodeExecutable)
  const npxCli = join(nodeDirectory, 'node_modules', 'npm', 'bin', 'npx-cli.js')
  if (!existsSync(npxCli)) return undefined
  return { executable: nodeExecutable, args: [npxCli, ...args] }
}

function normalizeInvocation(options: HealthOptions, executable: string, args: readonly string[]): { executable: string; args: string[] } {
  const nativeNpx = executable.toLowerCase().endsWith('npx.cmd')
    ? nativeNpxInvocation(options, args)
    : undefined
  return nativeNpx ?? { executable, args: [...args] }
}

async function execute(
  options: HealthOptions,
  executable: string,
  args: readonly string[],
  commandOptions: HealthCommandOptions = {}
): Promise<HealthCommandResult> {
  const invocation = normalizeInvocation(options, executable, args)
  return commandRunner(options)(invocation.executable, invocation.args, {
    cwd: options.cwd,
    env: commandEnvironment(options, commandOptions.env),
    ...commandOptions
  })
}

export function runCommand(
  executable: string,
  args: readonly string[] = [],
  options: HealthCommandOptions = {}
): Promise<HealthCommandResult> {
  let child: ChildProcess
  try {
    child = nodeSpawn(executable, [...args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
  } catch (error) {
    const message = errorMessage(error)
    options.onOutput?.(message, 'stderr')
    return Promise.resolve({ code: 1, signal: null, stdout: '', stderr: message, timedOut: false })
  }

  return new Promise<HealthCommandResult>((resolveResult) => {
    let settled = false
    let timedOut = false
    let stdout = ''
    let stderr = ''
    let timeout: ReturnType<typeof setTimeout> | undefined
    let killFallback: ReturnType<typeof setTimeout> | undefined

    const settle = (result: HealthCommandResult): void => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      if (killFallback) clearTimeout(killFallback)
      resolveResult(result)
    }

    const emit = (chunk: unknown, stream: HealthOutputStream): void => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8')
      if (stream === 'stdout') stdout += text
      else stderr += text
      options.onOutput?.(text, stream)
    }

    child.stdout?.on('data', (chunk: unknown) => emit(chunk, 'stdout'))
    child.stderr?.on('data', (chunk: unknown) => emit(chunk, 'stderr'))
    child.once('error', (error) => {
      const message = errorMessage(error)
      if (!stderr) {
        stderr = message
        options.onOutput?.(message, 'stderr')
      }
      settle({ code: 1, signal: null, stdout, stderr, timedOut })
    })
    child.once('close', (code, signal) => {
      settle({ code, signal, stdout, stderr, timedOut })
    })

    const timeoutMs = Math.max(1, Math.trunc(options.timeoutMs ?? 30_000))
    timeout = setTimeout(() => {
      timedOut = true
      try {
        child.kill()
      } catch {
        // The close/error event below still resolves the command if the process
        // has already exited between the timer and kill().
      }
      killFallback = setTimeout(() => {
        settle({ code: null, signal: null, stdout, stderr, timedOut: true })
      }, 1_000)
    }, timeoutMs)

    try {
      if (options.input !== undefined) child.stdin?.end(options.input, 'utf8')
      else child.stdin?.end()
    } catch (error) {
      const message = errorMessage(error)
      stderr += message
      options.onOutput?.(message, 'stderr')
      settle({ code: 1, signal: null, stdout, stderr, timedOut })
    }
  })
}

export async function checkNode(options: HealthOptions = {}): Promise<HealthCheckResult> {
  try {
    const result = await execute(options, commandExecutable(options, 'node'), ['--version'], { timeoutMs: HEALTH_COMMAND_TIMEOUT_MS })
    if (commandFailed(result)) return failure(commandFailureDetail('Node.js', result), DEFAULT_FIXES.node)
    const version = outputLine(result)
    const major = Number(version.match(/v?(\d+)/)?.[1] ?? 0)
    if (major < 22) return failure(`Node.js ${version || 'version unknown'} is older than 22.`, DEFAULT_FIXES.node)
    return success(`Node.js ${version}.`)
  } catch (error) {
    return failure(`Node.js check failed: ${errorMessage(error)}`, DEFAULT_FIXES.node)
  }
}

async function checkCli(
  id: 'claude' | 'codex',
  label: string,
  versionArgs: readonly string[],
  pingArgs: readonly string[],
  options: HealthOptions
): Promise<HealthCheckResult> {
  const fix = DEFAULT_FIXES[id]
  try {
    const executable = commandExecutable(options, id)
    const version = await execute(options, executable, versionArgs, { timeoutMs: HEALTH_COMMAND_TIMEOUT_MS })
    if (commandFailed(version)) return failure(commandFailureDetail(`${label} version`, version), fix)
    const ping = await execute(options, executable, pingArgs, {
      input: 'Reply with exactly: ok\n',
      timeoutMs: HEALTH_PING_TIMEOUT_MS
    })
    if (commandFailed(ping)) return failure(commandFailureDetail(`${label} ping`, ping, HEALTH_PING_TIMEOUT_MS), fix)
    return success(`${label} ${outputLine(version) || 'installed'}; authenticated ping passed.`)
  } catch (error) {
    return failure(`${label} check failed: ${errorMessage(error)}`, fix)
  }
}

export function checkClaude(options: HealthOptions = {}): Promise<HealthCheckResult> {
  return checkCli('claude', 'Claude Code', ['--version'], ['-p', '--no-session-persistence', '--output-format', 'text'], options)
}

export function checkCodex(options: HealthOptions = {}): Promise<HealthCheckResult> {
  return checkCli('codex', 'Codex', ['--version'], ['exec', '--json', '--skip-git-repo-check', '-s', 'read-only', '-m', phaseModel('code').model], options)
}

export async function checkPython(
  settings: AppSettings,
  options: HealthOptions = {}
): Promise<HealthCheckResult> {
  const home = octaHome(settings)
  const pythonInstallDir = join(home, 'python')
  const uvEnvironment = commandEnvironment(options, {
    UV_PYTHON_INSTALL_DIR: pythonInstallDir,
    UV_CACHE_DIR: join(home, 'cache', 'uv')
  })
  try {
    const uv = await execute(options, commandExecutable(options, 'uv'), ['--version'], {
      env: uvEnvironment,
      timeoutMs: HEALTH_COMMAND_TIMEOUT_MS
    })
    if (commandFailed(uv)) return failure(commandFailureDetail('uv', uv), DEFAULT_FIXES.python)

    const found = await execute(options, commandExecutable(options, 'uv'), ['python', 'find', '3.12', '--no-project'], {
      env: uvEnvironment,
      timeoutMs: HEALTH_COMMAND_TIMEOUT_MS
    })
    if (commandFailed(found)) return failure(commandFailureDetail('uv Python 3.12 lookup', found), DEFAULT_FIXES.python)
    const pythonPath = outputLine(found).replace(/^['"]|['"]$/g, '')
    if (!pythonPath || !isInside(pythonInstallDir, pythonPath) || isAppDataPath(pythonPath)) {
      const detail = pythonPath ? `uv found Python 3.12 at ${pythonPath}, outside ${pythonInstallDir}.` : 'uv did not report a Python 3.12 path.'
      return failure(detail, DEFAULT_FIXES.python)
    }
    const version = await execute(options, pythonPath, ['--version'], {
      env: uvEnvironment,
      timeoutMs: HEALTH_COMMAND_TIMEOUT_MS
    })
    if (commandFailed(version)) return failure(commandFailureDetail('Python 3.12', version), DEFAULT_FIXES.python)
    if (!/Python\s+3\.12(?:\.|\s|$)/i.test(`${version.stdout}\n${version.stderr}`)) {
      return failure(`The managed interpreter at ${pythonPath} did not report Python 3.12.`, DEFAULT_FIXES.python)
    }
    return success(`uv ${outputLine(uv) || 'installed'}; Python 3.12 at ${pythonPath}; data stays under ${home}.`)
  } catch (error) {
    return failure(`uv/Python check failed: ${errorMessage(error)}`, DEFAULT_FIXES.python)
  }
}

export async function checkPlaywright(
  settings: AppSettings,
  options: HealthOptions = {}
): Promise<HealthCheckResult> {
  const home = octaHome(settings)
  const browsersPath = join(home, 'browser', 'playwright')
  const environment = commandEnvironment(options, { PLAYWRIGHT_BROWSERS_PATH: browsersPath })
  try {
    const result = await execute(options, commandExecutable(options, 'npx'), ['playwright', 'install', '--list'], {
      env: environment,
      timeoutMs: 15_000
    })
    if (commandFailed(result)) return failure(commandFailureDetail('Playwright browser list', result), DEFAULT_FIXES.playwright)
    const entries = options.fileSystem?.list(browsersPath) ?? defaultFileSystem().list(browsersPath)
    const hasChromium = entries.some((entry) => /^chromium(?:-|$)/i.test(entry))
    const listedUnderHome = `${result.stdout}\n${result.stderr}`.toLowerCase().includes(browsersPath.toLowerCase())
    if (!hasChromium || !listedUnderHome) {
      return failure(`Chromium is not available under ${browsersPath}.`, DEFAULT_FIXES.playwright)
    }
    return success(`Playwright browsers are installed under ${browsersPath}.`)
  } catch (error) {
    return failure(`Playwright check failed: ${errorMessage(error)}`, DEFAULT_FIXES.playwright)
  }
}

export async function checkFfmpeg(options: HealthOptions = {}): Promise<HealthCheckResult> {
  const fs = options.fileSystem ?? defaultFileSystem()
  // ffmpeg-static reports a path inside app.asar; the executable really lives in app.asar.unpacked.
  const binary = options.ffmpegPath === undefined ? (ffmpegStatic ? unpackedAsarPath(ffmpegStatic) : ffmpegStatic) : options.ffmpegPath
  if (!binary || !fs.isFile(binary)) return failure('The bundled ffmpeg-static binary was not found.', DEFAULT_FIXES.ffmpeg)
  try {
    const result = await execute(options, binary, ['-version'], { timeoutMs: HEALTH_COMMAND_TIMEOUT_MS })
    if (commandFailed(result)) return failure(commandFailureDetail('ffmpeg', result), DEFAULT_FIXES.ffmpeg)
    return success(`Bundled ffmpeg is ready at ${binary}.`)
  } catch (error) {
    return failure(`ffmpeg check failed: ${errorMessage(error)}`, DEFAULT_FIXES.ffmpeg)
  }
}

export async function checkPhotoshop(settings: AppSettings, options: HealthOptions = {}): Promise<HealthCheckResult> {
  const path = settings.photoshopPath.trim() ? resolvePhotoshopPath(settings.photoshopPath) : ''
  if (!path) return optional('Optional: Photoshop is not configured; the PSD fallback remains available.', DEFAULT_FIXES.photoshop)
  const fs = options.fileSystem ?? defaultFileSystem()
  if (!fs.isFile(path)) return failure(`Photoshop was not found at ${path}.`, DEFAULT_FIXES.photoshop)
  return success(`Photoshop is available at ${path}.`)
}

export function checkBrave(settings: AppSettings): Promise<HealthCheckResult> {
  return Promise.resolve(settings.braveSearchApiKey.trim()
    ? success('Brave Search key is configured.')
    : optional('Brave Search key is not configured; it is optional and fetch/search fallbacks remain available.', DEFAULT_FIXES.brave))
}

export async function checkGemini(settings: AppSettings, options: HealthOptions = {}): Promise<HealthCheckResult> {
  const apiKey = settings.geminiApiKey.trim()
  if (!apiKey) return failure('Gemini API key is not configured.', DEFAULT_FIXES.gemini)
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)
    try {
      const test = options.geminiTest ?? ((key: string, signal: AbortSignal) => new GeminiClient(key).testConnection(signal))
      const response = await test(apiKey, controller.signal)
      return success(`Gemini connection passed${response.trim() ? ` (${response.trim().slice(0, 80)}).` : '.'}`)
    } finally {
      clearTimeout(timeout)
    }
  } catch (error) {
    return failure(`Gemini connection failed: ${errorMessage(error)}`, DEFAULT_FIXES.gemini)
  }
}

export async function checkVault(settings: AppSettings, options: HealthOptions = {}): Promise<HealthCheckResult> {
  const path = settings.vaultPath.trim()
  if (!path) {
    const detected = options.detectVault === false ? null : detectObsidianVault()
    return failure(detected ? `Vault path is not configured. Obsidian's last vault is ${detected}.` : 'Vault path is not configured.', DEFAULT_FIXES.vault)
  }
  const fs = options.fileSystem ?? defaultFileSystem()
  if (!fs.isDirectory(path) || !fs.isReadable(path)) return failure(`Vault is not a readable folder: ${path}.`, DEFAULT_FIXES.vault)
  return success(`Vault is readable at ${path}.`)
}

export function checkOctaHome(settings: AppSettings, options: HealthOptions = {}): Promise<HealthCheckResult> {
  const home = octaHome(settings)
  const fs = options.fileSystem ?? defaultFileSystem()
  let marker = ''
  try {
    fs.makeDirectory(home)
    marker = join(home, `.health-${randomUUID()}.tmp`)
    fs.createExclusive(marker)
    fs.remove(marker)
    return Promise.resolve(success(`Octa home is writable at ${home}.`))
  } catch (error) {
    if (marker) {
      try { fs.remove(marker) } catch { /* best effort cleanup */ }
    }
    return Promise.resolve(failure(`Octa home is not writable at ${home}: ${errorMessage(error)}`, DEFAULT_FIXES['octa-home']))
  }
}

export async function checkResearchBrowser(settings: AppSettings, options: HealthOptions = {}): Promise<HealthCheckResult> {
  try {
    const status = await options.browserStatus?.() ?? {
      profilePath: join(octaHome(settings), 'browser', 'research'),
      playwrightBrowsersPath: join(octaHome(settings), 'browser', 'playwright'),
      sites: {}
    }
    const sites = Object.entries(status.sites)
      .map(([site, value]) => `${site}: ${value.loggedIn ? 'signed in' : 'not signed in'}`)
      .join('; ')
    const missing = Object.values(status.sites).filter((value) => !value.loggedIn).length
    const detail = sites ? `Research browser profile is ready. ${sites}.` : 'Research browser profile is ready; no site sessions are saved yet.'
    return optional(detail, missing > 0 ? DEFAULT_FIXES['research-browser'] : '')
  } catch (error) {
    return failure(`Research browser status failed: ${errorMessage(error)}`, DEFAULT_FIXES['research-browser'])
  }
}

export async function checkWakeWord(settings: AppSettings, options: HealthOptions = {}): Promise<HealthCheckResult> {
  if (!settings.wakeWordEnabled) return success('Wake-word detection is disabled; push-to-talk remains available.')
  const fs = options.fileSystem ?? defaultFileSystem()
  const modelPath = settings.wakeWordModelPath.trim() || join(octaHome(settings), 'models', 'octa.onnx')
  const root = resolve(modelPath, '..')
  const required = [modelPath, join(root, 'melspectrogram.onnx'), join(root, 'embedding_model.onnx')]
  const missing = required.filter((path) => !fs.isFile(path))
  if (missing.length > 0) return failure(`Wake-word files are missing: ${missing.join(', ')}.`, DEFAULT_FIXES['wake-word'])
  return success(`Wake-word model and feature models are present under ${root}.`)
}

function octaHome(settings: AppSettings): string {
  return resolve(settings.octaHomePath.trim() || DEFAULT_HEALTH_OCTA_HOME)
}

export async function runHealthCheck(
  id: HealthCheckId,
  settings: AppSettings,
  options: HealthOptions = {}
): Promise<HealthCheckResult> {
  switch (id) {
    case 'node': return checkNode(options)
    case 'claude': return checkClaude(options)
    case 'codex': return checkCodex(options)
    case 'python': return checkPython(settings, options)
    case 'playwright': return checkPlaywright(settings, options)
    case 'ffmpeg': return checkFfmpeg(options)
    case 'photoshop': return checkPhotoshop(settings, options)
    case 'brave': return checkBrave(settings)
    case 'gemini': return checkGemini(settings, options)
    case 'vault': return checkVault(settings, options)
    case 'octa-home': return checkOctaHome(settings, options)
    case 'research-browser': return checkResearchBrowser(settings, options)
    case 'wake-word': return checkWakeWord(settings, options)
  }
}

export async function runHealthChecks(settings: AppSettings, options: HealthOptions = {}): Promise<HealthReport> {
  const checks: HealthCheckEntry[] = []
  for (const id of HEALTH_CHECK_IDS) checks.push({ id, ...(await runHealthCheck(id, settings, options)) })
  return {
    ok: checks.every((check) => check.ok),
    checkedAt: (options.now ?? (() => new Date()))().toISOString(),
    checks
  }
}

export function guidedInstallSpec(
  kind: GuidedInstallKind,
  octaHomePath: string,
  options: Pick<HealthOptions, 'environment' | 'resolveExecutable'> = {}
): GuidedInstallSpec {
  const home = resolve(octaHomePath.trim() || DEFAULT_HEALTH_OCTA_HOME)
  const baseEnvironment = { ...process.env, ...options.environment }
  if (kind === 'python') {
    const pythonDir = join(home, 'python')
    const cacheDir = join(home, 'cache', 'uv')
    const env = { ...baseEnvironment, UV_PYTHON_INSTALL_DIR: pythonDir, UV_CACHE_DIR: cacheDir }
    const executable = options.resolveExecutable?.('uv') ?? resolveDefaultExecutable('uv', env)
    return {
      kind,
      executable,
      args: ['python', 'install', '--install-dir', pythonDir, '3.12'],
      env,
      command: `uv python install --install-dir "${pythonDir}" 3.12`
    }
  }
  const browsersPath = join(home, 'browser', 'playwright')
  const env = { ...baseEnvironment, PLAYWRIGHT_BROWSERS_PATH: browsersPath }
  const executable = options.resolveExecutable?.('npx') ?? resolveDefaultExecutable('npx', env)
  return {
    kind,
    executable,
    args: ['playwright', 'install', 'chromium'],
    env,
    command: 'npx playwright install chromium'
  }
}

export async function runGuidedInstall(
  kind: GuidedInstallKind,
  octaHomePath: string,
  options: GuidedInstallOptions = {}
): Promise<GuidedInstallResult> {
  const spec = guidedInstallSpec(kind, octaHomePath, options)
  try {
    const invocation = normalizeInvocation(options, spec.executable, spec.args)
    const result = await (options.command ?? runCommand)(invocation.executable, invocation.args, {
      cwd: options.cwd,
      env: spec.env,
      timeoutMs: 30 * 60_000,
      onOutput: options.onOutput
    })
    return {
      kind,
      ok: !result.timedOut && result.code === 0,
      command: spec.command,
      exitCode: result.code,
      output: result.stdout,
      error: result.stderr
    }
  } catch (error) {
    return {
      kind,
      ok: false,
      command: spec.command,
      exitCode: 1,
      output: '',
      error: errorMessage(error)
    }
  }
}

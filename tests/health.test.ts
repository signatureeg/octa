import { describe, expect, it, vi } from 'vitest'
import {
  HEALTH_CHECK_IDS,
  checkClaude,
  checkCodex,
  checkGemini,
  checkPhotoshop,
  checkPython,
  checkWakeWord,
  guidedInstallSpec,
  runGuidedInstall,
  runHealthChecks,
  type HealthCommandRunner,
  type HealthCommandResult,
  type HealthFileSystem
} from '../electron/core/octa/health'
import { DEFAULT_SETTINGS, type AppSettings } from '../electron/types'
import { CODEX_EXECUTOR_MODEL } from '../electron/core/jobs/runner'

function result(stdout = '', code = 0, stderr = ''): HealthCommandResult {
  return { code, signal: null, stdout, stderr, timedOut: false }
}

function fakeFileSystem(options: {
  files?: string[]
  directories?: string[]
  entries?: Record<string, string[]>
} = {}): HealthFileSystem {
  const files = new Set(options.files ?? [])
  const directories = new Set(options.directories ?? [])
  return {
    exists: (path) => files.has(path) || directories.has(path),
    isFile: (path) => files.has(path),
    isDirectory: (path) => directories.has(path),
    isReadable: (path) => directories.has(path) || files.has(path),
    list: (path) => options.entries?.[path] ?? [],
    makeDirectory: (path) => { directories.add(path) },
    createExclusive: (path) => { files.add(path) },
    remove: (path) => { files.delete(path) }
  }
}

function healthSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    octaHomePath: 'C:\\Octa',
    vaultPath: 'C:\\Vault',
    geminiApiKey: 'test-gemini-key',
    wakeWordModelPath: 'C:\\Octa\\models\\octa.onnx',
    ...overrides
  }
}

function healthyFileSystem(): HealthFileSystem {
  return fakeFileSystem({
    files: [
      'C:\\Octa\\models\\octa.onnx',
      'C:\\Octa\\models\\melspectrogram.onnx',
      'C:\\Octa\\models\\embedding_model.onnx',
      'C:\\Octa\\ffmpeg.exe'
    ],
    directories: ['C:\\Octa', 'C:\\Octa\\browser\\playwright', 'C:\\Vault'],
    entries: { 'C:\\Octa\\browser\\playwright': ['chromium-1243', 'chromium_headless_shell-1243'] }
  })
}

function healthyCommand(): HealthCommandRunner {
  return vi.fn(async (executable: string, args: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => {
    if (executable === 'node') return result('v22.21.0')
    if (executable === 'claude' && args[0] === '--version') return result('2.1.257 (Claude Code)')
    if (executable === 'claude') return result('ok')
    if (executable === 'codex' && args[0] === '--version') return result('codex-cli 0.153.4')
    if (executable === 'codex') return result('{"type":"turn.completed"}')
    if (executable === 'uv' && args[0] === '--version') return result('uv 0.12.0')
    if (executable === 'uv') return result('C:\\Octa\\python\\cpython-3.12.13-windows-x86_64-none\\python.exe')
    if (executable.includes('python.exe')) return result('Python 3.12.13')
    if (executable === 'npx') return result('Playwright version: 1.63.0\n  C:\\Octa\\browser\\playwright\\chromium-1243')
    if (executable === 'C:\\Octa\\ffmpeg.exe') return result('ffmpeg version 7.0')
    void options
    return result()
  }) as unknown as HealthCommandRunner
}

describe('Octa environment health checks', () => {
  it('runs every required check and returns a green, inspectable table', async () => {
    const command = healthyCommand()
    const report = await runHealthChecks(healthSettings(), {
      command,
      fileSystem: healthyFileSystem(),
      ffmpegPath: 'C:\\Octa\\ffmpeg.exe',
      resolveExecutable: (name) => name,
      browserStatus: () => ({
        profilePath: 'C:\\Octa\\browser\\research',
        playwrightBrowsersPath: 'C:\\Octa\\browser\\playwright',
        sites: {
          facebook: { loggedIn: true, challengeBackoffUntil: null, lastLoginAt: null },
          x: { loggedIn: true, challengeBackoffUntil: null, lastLoginAt: null },
          reddit: { loggedIn: true, challengeBackoffUntil: null, lastLoginAt: null }
        }
      }),
      geminiTest: vi.fn(async () => 'ok')
    })

    expect(report.ok).toBe(true)
    expect(report.checks.map((check) => check.id)).toEqual([...HEALTH_CHECK_IDS])
    expect(report.checks.every((check) => check.ok && check.detail)).toBe(true)
    expect(command).toHaveBeenCalledWith('claude', ['-p', '--no-session-persistence', '--output-format', 'text'], expect.objectContaining({ timeoutMs: 45_000 }))
    expect(command).toHaveBeenCalledWith('codex', ['exec', '--json', '--skip-git-repo-check', '-s', 'read-only', '-m', CODEX_EXECUTOR_MODEL], expect.objectContaining({ timeoutMs: 45_000 }))
  })

  it('keeps optional Photoshop and Brave checks green when they are not configured', async () => {
    const settings = healthSettings({ photoshopPath: '', braveSearchApiKey: '' })
    const photoshop = await checkPhotoshop(settings, { fileSystem: healthyFileSystem() })
    const report = await runHealthChecks(settings, {
      command: healthyCommand(),
      fileSystem: healthyFileSystem(),
      ffmpegPath: 'C:\\Octa\\ffmpeg.exe',
      resolveExecutable: (name) => name,
      geminiTest: vi.fn(async () => 'ok')
    })
    expect(photoshop.ok).toBe(true)
    expect(photoshop.detail).toContain('Optional')
    expect(report.checks.find((check) => check.id === 'brave')).toMatchObject({ ok: true })
    expect(report.checks.find((check) => check.id === 'photoshop')).toMatchObject({ ok: true })
  })

  it('pings Codex with the model Octa runs and reports the API error, not the first JSON event', async () => {
    const apiError = JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: "The 'x' model is not supported when using Codex with a ChatGPT account." } })
    const events = [
      JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'error', message: apiError }),
      JSON.stringify({ type: 'turn.failed', error: { message: apiError } })
    ].join('\n')
    const command = vi.fn(async (_executable: string, args: readonly string[]) => {
      if (args[0] === '--version') return result('codex-cli 0.200.0')
      return result(events, 1)
    })
    const check = await checkCodex({ command, resolveExecutable: (name) => name })
    expect(check.ok).toBe(false)
    expect(check.detail).toBe("Codex ping failed: The 'x' model is not supported when using Codex with a ChatGPT account.")
    const pingArgs = command.mock.calls[1]?.[1] ?? []
    expect(pingArgs.slice(-2)).toEqual(['-m', CODEX_EXECUTOR_MODEL])
  })

  it('fails with a fix hint when Claude is installed but its ping times out', async () => {
    const command = vi.fn(async (_executable: string, args: readonly string[]) => {
      if (args[0] === '--version') return result('2.1.257 (Claude Code)')
      return { ...result(), code: null, timedOut: true }
    })
    const check = await checkClaude({ command, resolveExecutable: (name) => name })
    expect(check.ok).toBe(false)
    expect(check.detail).toContain('ping timed out after 45 seconds')
    expect(check.fix).toContain('Claude Code')
  })

  it('rejects Python found in AppData and passes the required uv environment to lookup', async () => {
    const command = vi.fn(async (_executable: string, args: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => {
      if (args[0] === '--version') return result('uv 0.12.0')
      return result('C:\\Users\\Admin\\AppData\\Roaming\\uv\\python\\cpython-3.12\\python.exe')
    })
    const check = await checkPython(healthSettings(), {
      command,
      resolveExecutable: (name) => name
    })
    expect(check.ok).toBe(false)
    expect(check.detail).toContain('outside')
    const lookup = command.mock.calls[1]?.[2]
    expect(lookup?.env?.UV_PYTHON_INSTALL_DIR).toBe('C:\\Octa\\python')
    expect(lookup?.env?.UV_CACHE_DIR).toBe('C:\\Octa\\cache\\uv')
  })

  it('requires all wake-word feature models and allows the disabled fallback', async () => {
    const missing = await checkWakeWord(healthSettings(), {
      fileSystem: fakeFileSystem({ files: ['C:\\Octa\\models\\octa.onnx'] })
    })
    const disabled = await checkWakeWord(healthSettings({ wakeWordEnabled: false }), { fileSystem: fakeFileSystem() })
    expect(missing.ok).toBe(false)
    expect(missing.detail).toContain('melspectrogram')
    expect(disabled.ok).toBe(true)
  })

  it('exposes exact guided install commands and streams their output', async () => {
    const python = guidedInstallSpec('python', 'C:\\Octa', { resolveExecutable: () => 'uv' })
    const playwright = guidedInstallSpec('playwright', 'C:\\Octa', { resolveExecutable: () => 'npx' })
    expect(python.args).toEqual(['python', 'install', '--install-dir', 'C:\\Octa\\python', '3.12'])
    expect(python.env).toMatchObject({ UV_PYTHON_INSTALL_DIR: 'C:\\Octa\\python', UV_CACHE_DIR: 'C:\\Octa\\cache\\uv' })
    expect(playwright.args).toEqual(['playwright', 'install', 'chromium'])
    expect(playwright.env).toMatchObject({ PLAYWRIGHT_BROWSERS_PATH: 'C:\\Octa\\browser\\playwright' })

    const chunks: string[] = []
    const command = vi.fn(async (_executable: string, _args: readonly string[], options?: { onOutput?: (text: string, stream: 'stdout' | 'stderr') => void }) => {
      options?.onOutput?.('downloaded\n', 'stdout')
      return result('downloaded\n')
    })
    const install = await runGuidedInstall('playwright', 'C:\\Octa', {
      command,
      resolveExecutable: () => 'npx',
      onOutput: (text, stream) => chunks.push(`${stream}:${text}`)
    })
    expect(install).toMatchObject({ kind: 'playwright', ok: true, command: 'npx playwright install chromium' })
    expect(chunks).toEqual(['stdout:downloaded\n'])
  })

  it('launches the Windows npx shim through node without enabling a shell', async () => {
    const command = vi.fn(async () => result('installed\n'))
    const install = await runGuidedInstall('playwright', 'C:\\Octa', {
      command,
      environment: { PATH: 'C:\\Program Files\\nodejs' }
    })
    expect(install.ok).toBe(true)
    expect(command).toHaveBeenCalledWith(
      'C:\\Program Files\\nodejs\\node.exe',
      ['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js', 'playwright', 'install', 'chromium'],
      expect.objectContaining({ env: expect.objectContaining({ PLAYWRIGHT_BROWSERS_PATH: 'C:\\Octa\\browser\\playwright' }) })
    )
  })

  it('reports Gemini key failures without invoking the network adapter', async () => {
    const geminiTest = vi.fn(async () => 'ok')
    const check = await checkGemini(healthSettings({ geminiApiKey: '' }), { geminiTest })
    expect(check.ok).toBe(false)
    expect(check.fix).toContain('Gemini')
    expect(geminiTest).not.toHaveBeenCalled()
  })
})

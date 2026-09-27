import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import type { AppSettings } from '../../types'

/**
 * Read PATH from an environment object regardless of casing. On Windows the variable is named "Path";
 * `process.env` hides that, but any spread copy (`{ ...process.env }`) is a plain object where
 * `env.PATH` is undefined. Apps started from the Start menu hit exactly that and found no CLI at all.
 */
export function envPath(environment: NodeJS.ProcessEnv): string {
  if (typeof environment.PATH === 'string') return environment.PATH
  const key = Object.keys(environment).find((name) => name.toUpperCase() === 'PATH')
  return key ? environment[key] ?? '' : ''
}

/**
 * Clean a path typed into a text box. Strips surrounding quotes and whitespace, and repairs the
 * right-to-left scramble where "C:\\...\\Folder" + "\\Photoshop.exe" is stored as
 * "Photoshop.exe\\C:\\...\\Folder" because the caret sat at the visual start of an RTL input.
 */
export function normalizeUserPath(value: string): string {
  let path = value.trim().replace(/^["'\u200e\u200f\u202a-\u202e]+|["'\u200e\u200f\u202a-\u202e]+$/g, '').trim()
  const scrambled = /^([^\\/:]+\.[A-Za-z0-9]{2,4})[\\/]+([A-Za-z]:[\\/].*)$/.exec(path)
  if (scrambled) path = `${scrambled[2].replace(/[\\/]+$/, '')}\\${scrambled[1]}`
  if (/^[A-Za-z]:[\\/]/.test(path)) path = path.replace(/\//g, '\\').replace(/\\{2,}/g, '\\')
  return path.length > 3 ? path.replace(/\\+$/, '') : path
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Accept either Photoshop.exe or its folder. */
export function resolvePhotoshopPath(value: string): string {
  const path = normalizeUserPath(value)
  if (path && isDirectory(path) && existsSync(join(path, 'Photoshop.exe'))) return join(path, 'Photoshop.exe')
  return path
}

const PATH_SETTINGS = ['photoshopPath', 'vaultPath', 'octaHomePath', 'skillsLibraryPath', 'wakeWordModelPath', 'vertexKeyPath'] as const

/** Normalise every path-like setting in a settings update. */
export function normalizePathSettings(update: Partial<AppSettings>): Partial<AppSettings> {
  const next = { ...update }
  for (const key of PATH_SETTINGS) {
    const value = next[key]
    if (typeof value === 'string') next[key] = normalizeUserPath(value)
  }
  if (typeof next.photoshopPath === 'string' && next.photoshopPath) next.photoshopPath = resolvePhotoshopPath(next.photoshopPath)
  return next
}

/**
 * Packages such as ffmpeg-static report a path inside app.asar. The file really lives in
 * app.asar.unpacked, and Windows cannot execute anything through the asar shim.
 */
export function unpackedAsarPath(path: string): string {
  return path.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`).replace('app.asar/', 'app.asar.unpacked/')
}

/** The Obsidian vault the user opened most recently, from Obsidian's own registry. */
export function detectObsidianVault(appData = process.env.APPDATA ?? ''): string | null {
  if (!appData) return null
  try {
    const registry = JSON.parse(readFileSync(join(appData, 'obsidian', 'obsidian.json'), 'utf8')) as { vaults?: Record<string, { path?: string; ts?: number; open?: boolean }> }
    const vaults = Object.values(registry.vaults ?? {}).filter((vault) => typeof vault.path === 'string' && isDirectory(vault.path))
    vaults.sort((a, b) => Number(Boolean(b.open)) - Number(Boolean(a.open)) || (b.ts ?? 0) - (a.ts ?? 0))
    return vaults[0]?.path ?? null
  } catch {
    return null
  }
}

export const WAKE_WORD_FILES = ['octa.onnx', 'melspectrogram.onnx', 'embedding_model.onnx'] as const

/**
 * Put the wake-word models shipped with the app into the models folder when they are missing.
 * Files the user placed there (for example a retrained octa.onnx) are never overwritten.
 */
export function ensureWakeWordModels(modelPath: string, bundledDir: string): string[] {
  const targetDir = join(modelPath, '..')
  const copied: string[] = []
  const targets: Record<string, string> = {
    'octa.onnx': modelPath,
    'melspectrogram.onnx': join(targetDir, 'melspectrogram.onnx'),
    'embedding_model.onnx': join(targetDir, 'embedding_model.onnx')
  }
  for (const name of WAKE_WORD_FILES) {
    const source = join(bundledDir, name)
    const target = targets[name]
    if (existsSync(target) || !existsSync(source)) continue
    mkdirSync(targetDir, { recursive: true })
    copyFileSync(source, target)
    copied.push(target)
  }
  return copied
}

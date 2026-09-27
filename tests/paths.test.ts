import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { detectObsidianVault, ensureWakeWordModels, envPath, normalizePathSettings, normalizeUserPath, resolvePhotoshopPath, unpackedAsarPath } from '../electron/core/octa/paths'
import { resolveCliBinary } from '../electron/core/jobs/runner'

const dirs: string[] = []
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'octa-paths-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('path helpers for installed builds', () => {
  it('reads PATH whatever its casing (Windows names it "Path")', () => {
    expect(envPath({ PATH: 'a' })).toBe('a')
    expect(envPath({ Path: 'b' })).toBe('b')
    expect(envPath({})).toBe('')
  })

  it('finds the CLIs from a spread environment whose PATH key is "Path"', () => {
    const bin = temp()
    writeFileSync(join(bin, 'claude.exe'), 'MZ')
    expect(resolveCliBinary('claude', { Path: bin, OS: 'Windows_NT' })).toBe(join(bin, 'claude.exe'))
  })

  it('falls back to the official install folders when PATH is empty', () => {
    const profile = temp()
    mkdirSync(join(profile, '.local', 'bin'), { recursive: true })
    writeFileSync(join(profile, '.local', 'bin', 'claude.exe'), 'MZ')
    expect(resolveCliBinary('claude', { USERPROFILE: profile, OS: 'Windows_NT' })).toBe(join(profile, '.local', 'bin', 'claude.exe'))
  })

  it('repairs paths scrambled by an RTL text box and strips quotes', () => {
    expect(normalizeUserPath('Photoshop.exe\\C:\\Apps\\Adobe Photoshop 2024')).toBe('C:\\Apps\\Adobe Photoshop 2024\\Photoshop.exe')
    expect(normalizeUserPath('  "C:\\Users\\me\\Vault\\"  ')).toBe('C:\\Users\\me\\Vault')
    expect(normalizeUserPath('C:/Octa//models/octa.onnx')).toBe('C:\\Octa\\models\\octa.onnx')
    expect(normalizeUserPath('C:\\')).toBe('C:\\')
    expect(normalizeUserPath('')).toBe('')
  })

  it('accepts the Photoshop folder and points at Photoshop.exe inside it', () => {
    const folder = temp()
    writeFileSync(join(folder, 'Photoshop.exe'), 'MZ')
    expect(resolvePhotoshopPath(folder)).toBe(join(folder, 'Photoshop.exe'))
    expect(normalizePathSettings({ photoshopPath: `"${folder}"`, locale: 'ar' })).toEqual({ photoshopPath: join(folder, 'Photoshop.exe'), locale: 'ar' })
  })

  it('maps asar paths to the unpacked folder so native binaries can run', () => {
    expect(unpackedAsarPath(`C:${sep}Octa${sep}resources${sep}app.asar${sep}node_modules${sep}ffmpeg-static${sep}ffmpeg.exe`))
      .toBe(`C:${sep}Octa${sep}resources${sep}app.asar.unpacked${sep}node_modules${sep}ffmpeg-static${sep}ffmpeg.exe`)
    expect(unpackedAsarPath('/opt/octa/node_modules/ffmpeg-static/ffmpeg')).toBe('/opt/octa/node_modules/ffmpeg-static/ffmpeg')
  })

  it('detects the most recent Obsidian vault from its registry', () => {
    const appData = temp()
    const older = temp()
    const current = temp()
    mkdirSync(join(appData, 'obsidian'))
    writeFileSync(join(appData, 'obsidian', 'obsidian.json'), JSON.stringify({ vaults: { a: { path: older, ts: 1 }, b: { path: current, ts: 5, open: true }, c: { path: join(current, 'missing'), ts: 9 } } }))
    expect(detectObsidianVault(appData)).toBe(current)
    expect(detectObsidianVault(temp())).toBeNull()
  })

  it('restores bundled wake-word models without overwriting user files', () => {
    const bundled = temp()
    const models = join(temp(), 'models')
    for (const name of ['octa.onnx', 'melspectrogram.onnx', 'embedding_model.onnx']) writeFileSync(join(bundled, name), `bundled ${name}`)
    mkdirSync(models)
    writeFileSync(join(models, 'octa.onnx'), 'user retrained model')
    const copied = ensureWakeWordModels(join(models, 'octa.onnx'), bundled)
    expect(copied.sort()).toEqual([join(models, 'embedding_model.onnx'), join(models, 'melspectrogram.onnx')].sort())
    expect(readFileSync(join(models, 'octa.onnx'), 'utf8')).toBe('user retrained model')
    expect(ensureWakeWordModels(join(models, 'octa.onnx'), bundled)).toEqual([])
  })
})

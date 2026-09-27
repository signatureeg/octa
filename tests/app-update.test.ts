import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppUpdateController, applyScript, appUpdateApplies, parseAppUpdateManifest, settlePendingAppUpdate, type AppUpdateFetcher } from '../electron/core/octa/app-update'
import { computeRuntimeId } from '../electron/core/octa/runtime-id'
import { findFullInstallerFeed, type UpdateFetcher } from '../electron/core/octa/update'
import type { AppUpdate, UpdateProgress } from '../electron/types'

const dirs: string[] = []
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'octa-app-update-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const asarBytes = Buffer.from('fake asar payload '.repeat(50_000))
const sha512 = createHash('sha512').update(asarBytes).digest('hex')
const baseManifest = { version: '0.3.0', file: 'octa-app-0.3.0.asar', size: asarBytes.length, sha512, runtimeId: 'rt-1', electronVersion: '42.6.0' }
const update: AppUpdate = { status: 'available', currentVersion: '0.2.4', repository: 'abdutamim/octa', checkedAt: '', latestVersion: 'v0.3.0', appUpdateUrl: 'https://github.com/abdutamim/octa/releases/download/v0.3.0/app-update.json' }

function fetcherFor(manifest: unknown): AppUpdateFetcher {
  return async (url) => {
    if (url.endsWith('app-update.json')) return { ok: true, status: 200, headers: { get: () => null }, json: async () => manifest, body: null }
    const chunks = [asarBytes.subarray(0, 300_000), asarBytes.subarray(300_000)]
    const body = new ReadableStream<Uint8Array>({ pull(controller) { const next = chunks.shift(); if (next) controller.enqueue(new Uint8Array(next)); else controller.close() } })
    return { ok: true, status: 200, headers: { get: (name) => (name === 'content-length' ? String(asarBytes.length) : null) }, json: async () => ({}), body }
  }
}

describe('runtime id', () => {
  it('matches the build-side implementation and changes with the unpacked tree', async () => {
    const root = temp()
    mkdirSync(join(root, 'node_modules', 'better-sqlite3'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'better-sqlite3', 'x.node'), 'abc')
    // @ts-expect-error plain JS twin of the TS module
    const { computeRuntimeId: buildSide } = await import('../scripts/runtime-id.mjs') as { computeRuntimeId: typeof computeRuntimeId }
    const a = computeRuntimeId({ electronVersion: '42.6.0', unpackedRoot: root })
    expect(buildSide({ electronVersion: '42.6.0', unpackedRoot: root })).toBe(a)
    expect(computeRuntimeId({ electronVersion: '43.0.0', unpackedRoot: root })).not.toBe(a)
    writeFileSync(join(root, 'node_modules', 'better-sqlite3', 'x.node'), 'abcd')
    expect(computeRuntimeId({ electronVersion: '42.6.0', unpackedRoot: root })).not.toBe(a)
  })
})

describe('app-only update', () => {
  it('validates manifests and gates on version + runtime id', () => {
    expect(parseAppUpdateManifest(baseManifest)).toMatchObject({ version: '0.3.0', runtimeId: 'rt-1' })
    expect(parseAppUpdateManifest({ ...baseManifest, sha512: 'short' })).toBeNull()
    expect(parseAppUpdateManifest({ ...baseManifest, file: '../evil.exe' })).toBeNull()
    const manifest = parseAppUpdateManifest(baseManifest)!
    expect(appUpdateApplies(manifest, '0.2.4', 'rt-1')).toBe(true)
    expect(appUpdateApplies(manifest, '0.3.0', 'rt-1')).toBe(false)
    expect(appUpdateApplies(manifest, '0.2.4', 'rt-2')).toBe(false)
  })

  it('downloads, verifies the checksum, then installs through a detached swap script', async () => {
    const updatesDir = join(temp(), 'updates')
    const seen: UpdateProgress[] = []
    const launched: string[] = []
    let quit = 0
    const controller = new AppUpdateController({
      packaged: true, currentVersion: '0.2.4', runtimeId: 'rt-1', updatesDir,
      exePath: 'C:\\Users\\me\\AppData\\Local\\Programs\\Octa\\Octa.exe', resourcesPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\Octa\\resources', pid: 4242,
      onProgress: (p) => seen.push(p), fetcher: fetcherFor(baseManifest), spawnScript: (path) => launched.push(path), quit: () => { quit += 1 }
    })
    expect(await controller.check(update)).toMatchObject({ version: '0.3.0' })
    const result = await controller.download(update)
    expect(result.phase).toBe('downloaded')
    expect(result.mode).toBe('app')
    expect(result.total).toBe(asarBytes.length)
    expect(seen.some((p) => p.phase === 'downloading' && p.percent > 0 && p.percent < 100)).toBe(true)
    expect(readFileSync(join(updatesDir, 'octa-app-0.3.0.asar')).equals(asarBytes)).toBe(true)

    expect(controller.install()).toBe(true)
    expect(quit).toBe(1)
    expect(launched).toEqual([join(updatesDir, 'apply-update.cmd')])
    const script = readFileSync(launched[0], 'utf8')
    expect(script).toContain('PID eq 4242')
    expect(script).toContain('copy /y "%RES%\\app.asar" "%RES%\\app.asar.bak"')
    expect(script).toContain(`move /y "${join(updatesDir, 'octa-app-0.3.0.asar')}" "%RES%\\app.asar"`)
    expect(script).toContain('start "" "C:\\Users\\me\\AppData\\Local\\Programs\\Octa\\Octa.exe"')
    expect(JSON.parse(readFileSync(join(updatesDir, 'pending.json'), 'utf8'))).toMatchObject({ version: '0.3.0', from: '0.2.4' })
  })

  it('rejects a download whose checksum does not match and refuses incompatible installs', async () => {
    const updatesDir = join(temp(), 'updates')
    const bad = new AppUpdateController({ packaged: true, currentVersion: '0.2.4', runtimeId: 'rt-1', updatesDir, exePath: 'x', resourcesPath: 'y', pid: 1, onProgress: () => {}, fetcher: fetcherFor({ ...baseManifest, sha512: 'f'.repeat(128) }) })
    const result = await bad.download(update)
    expect(result.phase).toBe('error')
    expect(result.error).toMatch(/checksum/)
    expect(existsSync(join(updatesDir, 'octa-app-0.3.0.asar'))).toBe(false)

    const other = new AppUpdateController({ packaged: true, currentVersion: '0.2.4', runtimeId: 'rt-9', updatesDir, exePath: 'x', resourcesPath: 'y', pid: 1, onProgress: () => {}, fetcher: fetcherFor(baseManifest) })
    expect(await other.check(update)).toBeNull()
    const dev = new AppUpdateController({ packaged: false, currentVersion: '0.2.4', runtimeId: 'rt-1', updatesDir, exePath: 'x', resourcesPath: 'y', pid: 1, onProgress: () => {}, fetcher: fetcherFor(baseManifest) })
    expect(await dev.check(update)).toBeNull()
  })

  it('settles the pending marker on the next start', () => {
    const root = temp()
    const updatesDir = join(root, 'updates')
    const resources = join(root, 'resources')
    mkdirSync(updatesDir, { recursive: true })
    mkdirSync(resources, { recursive: true })
    writeFileSync(join(resources, 'app.asar.bak'), 'old')
    writeFileSync(join(updatesDir, 'apply-update.cmd'), applyScript({ pid: 1, exePath: 'x', resourcesPath: resources, downloadedAsar: 'z', pendingFile: join(updatesDir, 'pending.json') }))
    writeFileSync(join(updatesDir, 'pending.json'), JSON.stringify({ version: '0.3.0', from: '0.2.4' }))
    expect(settlePendingAppUpdate(updatesDir, '0.3.0', resources)).toMatch(/applied/)
    expect(existsSync(join(resources, 'app.asar.bak'))).toBe(false)
    expect(existsSync(join(updatesDir, 'pending.json'))).toBe(false)
    writeFileSync(join(updatesDir, 'pending.json'), JSON.stringify({ version: '0.3.0', from: '0.2.4' }))
    expect(settlePendingAppUpdate(updatesDir, '0.2.4', resources)).toMatch(/did not apply/)
    expect(settlePendingAppUpdate(updatesDir, '0.2.4', resources)).toBeNull()
  })

  it('finds the newest release that still carries a full installer', async () => {
    const fetcher: UpdateFetcher = async () => ({
      ok: true, status: 200, json: async () => [
        { tag_name: 'v0.3.1', assets: [{ name: 'app-update.json' }, { name: 'octa-app-0.3.1.asar' }] },
        { tag_name: 'v0.3.0', draft: true, assets: [{ name: 'latest.yml' }, { name: 'Octa-Setup-0.3.0.exe' }] },
        { tag_name: 'v0.2.4', assets: [{ name: 'latest.yml' }, { name: 'Octa-Setup-0.2.4.exe' }, { name: 'Octa-Setup-0.2.4.exe.blockmap' }] }
      ]
    })
    expect(await findFullInstallerFeed('abdutamim/octa', '0.2.0', fetcher)).toEqual({ tag: 'v0.2.4', url: 'https://github.com/abdutamim/octa/releases/download/v0.2.4' })
  })
})

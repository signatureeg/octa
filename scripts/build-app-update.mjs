// Produce the app-only update artefacts from a packaged dir build (release/win-unpacked):
//   release/octa-app-<version>.asar  — the compiled app without Electron or node_modules (a few MB)
//   release/app-update.json          — version, size, sha512 and the runtime id it applies to
// Publish both with `npm run release:app`. When the runtime id differs from the previous release
// (Electron upgraded or node_modules changed) publish the full installer instead (`npm run release:full`).
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { computeRuntimeId } from './runtime-id.mjs'

const root = resolve(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const electronVersion = String(pkg.devDependencies?.electron ?? '').replace(/^[\^~]/, '')
if (!electronVersion) throw new Error('package.json has no devDependencies.electron version.')

const resources = join(root, 'release', 'win-unpacked', 'resources')
const asar = join(resources, 'app.asar')
if (!existsSync(asar)) throw new Error(`No packaged build at ${asar}; run "npm run package:dir" first.`)

const runtimeId = computeRuntimeId({ electronVersion, unpackedRoot: join(resources, 'app.asar.unpacked') })
const file = `octa-app-${pkg.version}.asar`
const target = join(root, 'release', file)
copyFileSync(asar, target)
const bytes = readFileSync(target)
const manifest = {
  version: pkg.version,
  file,
  size: statSync(target).size,
  sha512: createHash('sha512').update(bytes).digest('hex'),
  runtimeId,
  electronVersion,
  builtAt: new Date().toISOString()
}
writeFileSync(join(root, 'release', 'app-update.json'), JSON.stringify(manifest, null, 2) + '\n')

const previous = join(root, 'release', 'previous-runtime-id.txt')
console.log(`app update: ${file} (${(manifest.size / 1024 / 1024).toFixed(1)} MB), runtime ${runtimeId}, electron ${electronVersion}`)
if (existsSync(previous) && readFileSync(previous, 'utf8').trim() !== runtimeId) {
  console.warn('WARNING: the runtime id changed since the last release; existing installs need the FULL installer (npm run release:full).')
}

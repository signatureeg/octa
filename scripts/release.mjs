// Publish a GitHub release for the current package.json version.
//   node scripts/release.mjs app   → builds the dir package, then uploads octa-app-<v>.asar + app-update.json
//   node scripts/release.mjs full  → builds the NSIS installer too and uploads exe + blockmap + latest.yml as well
// Requires the tag v<version> to exist on origin (run `npm version patch` and push with --follow-tags first)
// and an authenticated `gh`. Release notes come from RELEASE-NOTES.md if present, else a short default.
import { execSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const kind = process.argv[2]
if (kind !== 'app' && kind !== 'full') {
  console.error('usage: node scripts/release.mjs <app|full>')
  process.exit(2)
}
const root = resolve(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const tag = `v${pkg.version}`
const run = (command, options = {}) => execSync(command, { cwd: root, stdio: 'inherit', ...options })

const tags = execSync('git ls-remote --tags origin', { cwd: root }).toString()
if (!tags.includes(`refs/tags/${tag}`)) {
  console.error(`Tag ${tag} is not on origin. Run: npm version patch && git push origin main --follow-tags`)
  process.exit(1)
}

run('npm run typecheck')
run('npm rebuild better-sqlite3', { stdio: 'ignore' })
run('npm test')
run('npx electron-vite build')
run('node scripts/verify-build.mjs')
run('npm run rebuild:electron')
run(`npx electron-builder --win ${kind === 'full' ? 'nsis' : 'dir'} --x64 --publish never`)
run('node scripts/build-app-update.mjs')
run('npm rebuild better-sqlite3', { stdio: 'ignore' })

const release = join(root, 'release')
const files = [join(release, `octa-app-${pkg.version}.asar`), join(release, 'app-update.json')]
if (kind === 'full') files.push(join(release, `Octa-Setup-${pkg.version}.exe`), join(release, `Octa-Setup-${pkg.version}.exe.blockmap`), join(release, 'latest.yml'))
for (const file of files) if (!existsSync(file)) throw new Error(`Missing release file: ${file}`)

const notesFile = join(root, 'RELEASE-NOTES.md')
const notes = existsSync(notesFile)
  ? readFileSync(notesFile, 'utf8')
  : `## Octa ${pkg.version}\n\n${kind === 'app' ? 'App-only update: installed copies download a few MB and swap the app on restart.' : 'Full release: installer, blockmap and app-only update files.'}\n`
const tmpNotes = join(release, 'notes.md')
writeFileSync(tmpNotes, notes)

const gh = spawnSync(process.platform === 'win32' ? 'gh.exe' : 'gh', ['release', 'create', tag, ...files, '--title', `Octa ${pkg.version}`, '--notes-file', tmpNotes, '--latest'], { cwd: root, stdio: 'inherit' })
if (gh.status !== 0) process.exit(gh.status ?? 1)
const manifest = JSON.parse(readFileSync(join(release, 'app-update.json'), 'utf8'))
writeFileSync(join(release, 'previous-runtime-id.txt'), manifest.runtimeId)
console.log(`Released ${tag} (${kind}); runtime id ${manifest.runtimeId}`)

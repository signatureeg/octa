import { createHash } from 'node:crypto'
import { readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * Identifies the part of an installation that an app-only update cannot replace: the Electron
 * runtime plus everything shipped outside `app.asar` (native modules and the other unpacked
 * node_modules). Two installs with the same runtime id can swap `app.asar` files safely.
 *
 * `scripts/runtime-id.mjs` implements the same algorithm for the build side; tests keep them equal.
 */
export function computeRuntimeId(options: { electronVersion: string; unpackedRoot: string }): string {
  const entries: string[] = []
  const walk = (directory: string): void => {
    let names: string[]
    try {
      names = readdirSync(directory)
    } catch {
      return
    }
    for (const name of names.sort()) {
      const path = join(directory, name)
      let stats
      try {
        stats = statSync(path)
      } catch {
        continue
      }
      if (stats.isDirectory()) {
        walk(path)
      } else {
        entries.push(`${relative(options.unpackedRoot, path).split(sep).join('/')}:${stats.size}`)
      }
    }
  }
  walk(options.unpackedRoot)
  const hash = createHash('sha256')
  hash.update(`electron:${options.electronVersion}\n`)
  for (const entry of entries) hash.update(`${entry}\n`)
  return hash.digest('hex').slice(0, 16)
}

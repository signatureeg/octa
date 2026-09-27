// Build-side twin of electron/core/octa/runtime-id.ts. Keep the two algorithms identical.
import { createHash } from 'node:crypto'
import { readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

export function computeRuntimeId({ electronVersion, unpackedRoot }) {
  const entries = []
  const walk = (directory) => {
    let names
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
      if (stats.isDirectory()) walk(path)
      else entries.push(`${relative(unpackedRoot, path).split(sep).join('/')}:${stats.size}`)
    }
  }
  walk(unpackedRoot)
  const hash = createHash('sha256')
  hash.update(`electron:${electronVersion}\n`)
  for (const entry of entries) hash.update(`${entry}\n`)
  return hash.digest('hex').slice(0, 16)
}

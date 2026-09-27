// Decode the owner's dictation recordings (negatives) to 16 kHz mono s16 WAV, skipping ones that mention Octa.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const ROOT = process.env.WAKEWORD_DIR || new URL('../../.octa/wakeword/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const OWNER = join(ROOT, 'owner')
const OUT = join(OWNER, 'wav16k')
mkdirSync(OUT, { recursive: true })
const exclude = new Set(JSON.parse(readFileSync(join(OWNER, 'exclude.json'), 'utf8')))

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...walk(path))
    else if (/\.(webm|wav|ogg|m4a)$/i.test(name) && !path.includes('wav16k')) out.push(path)
  }
  return out
}
const files = walk(OWNER).filter((file) => !exclude.has(basename(file)))
console.log('files', files.length)
let done = 0, failed = 0
const queue = [...files]
async function worker() {
  for (;;) {
    const file = queue.shift()
    if (!file) return
    const target = join(OUT, basename(file).replace(/\.[^.]+$/, '.wav'))
    if (!existsSync(target)) {
      try {
        await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-ar', '16000', '-ac', '1', '-sample_fmt', 's16', target])
      } catch { failed++ }
    }
    if (++done % 200 === 0) console.log(`${done}/${files.length} failed ${failed}`)
  }
}
await Promise.all(Array.from({ length: 6 }, worker))
console.log('done', done, 'failed', failed)

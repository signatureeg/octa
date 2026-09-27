// Transcribe every whole TTS clip (context makes Gemini reliable) and pick training utterances:
// - positive clip: transcript must contain the wake word >= 7 times; its last 8 short segments are positives.
// - negative clip: transcript must not contain the wake word; all its segments are negatives.
// Writes clips.json { "<kind>/<file>": { text, count, use } } and dataset.json { pos: [...], neg: [...] } (segment paths).
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { readWav, segmentSpeech, SR, writeWav } from './lib.mjs'

const ROOT = process.env.WAKEWORD_DIR || new URL('../../.octa/wakeword/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const db = new Database('C:/Octa/octa.db', { readonly: true })
const KEY = JSON.parse(db.prepare('select value from app_settings where key=?').get('geminiApiKey').value)
const MODEL = process.env.STT_MODEL || 'gemini-3.5-flash'
const CLIPS = join(ROOT, 'clips.json')
const clips = existsSync(CLIPS) ? JSON.parse(readFileSync(CLIPS, 'utf8')) : {}

async function transcribe(path) {
  const body = {
    contents: [{ role: 'user', parts: [
      { inlineData: { mimeType: 'audio/wav', data: readFileSync(path).toString('base64') } },
      { text: 'Transcribe this Egyptian Arabic / English audio exactly as spoken, in the original script. Separate utterances with " | ". The speaker may be calling an assistant named أوكتا (Octa); write that name as أوكتا only when it is actually said. Output only the transcript.' }
    ] }],
    generationConfig: { temperature: 0, thinkingConfig: { thinkingBudget: 0 } }
  }
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST', headers: { 'x-goog-api-key': KEY, 'content-type': 'application/json' }, body: JSON.stringify(body)
    }).catch(() => null)
    if (!res || res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 3000 * (attempt + 1))); continue }
    const json = await res.json()
    if (!res.ok) throw new Error(JSON.stringify(json).slice(0, 200))
    return (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim()
  }
  throw new Error('rate limited')
}

const wakeCount = (text) => (text.match(/أوكتا|اوكتا|octa|okta/gi) ?? []).length

const jobs = []
for (const kind of ['pos', 'neg']) {
  const dir = join(ROOT, 'tts', kind)
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.wav') && Date.now() - statSync(join(dir, n)).mtimeMs > 30_000)) {
    const key = `${kind}/${name}`
    if (!clips[key]) jobs.push({ key, path: join(dir, name) })
  }
}
console.log('to transcribe', jobs.length)
async function worker() {
  for (;;) {
    const job = jobs.shift()
    if (!job) return
    try {
      const text = await transcribe(job.path)
      clips[job.key] = { text, count: wakeCount(text) }
    } catch (error) { console.log('FAIL', job.key, String(error.message).slice(0, 120)) }
  }
}
await Promise.all(Array.from({ length: 6 }, worker))
writeFileSync(CLIPS, JSON.stringify(clips, null, 1))

const dataset = { pos: [], neg: [] }
let usedPos = 0, usedNeg = 0, rejected = []
for (const [key, clip] of Object.entries(clips)) {
  const [kind, name] = key.split('/')
  const base = name.replace(/\.wav$/, '')
  const samples = readWav(join(ROOT, 'tts', kind, name))
  const segs = kind === 'pos' ? segmentSpeech(samples) : segmentSpeech(samples, { maxSpeechMs: 6000 })
  const voice = base.split('-')[0]
  mkdirSync(join(ROOT, 'segments', kind), { recursive: true })
  segs.forEach(([a, b], i) => { const p = join(ROOT, 'segments', kind, `${base}-${i}.wav`); if (!existsSync(p)) writeWav(p, samples.slice(a, b)) })
  if (kind === 'pos') {
    const want = Math.min(8, clip.count)
    const tail = segs.map((s, i) => ({ s, i })).slice(-want)
    const ok = want >= 6 && segs.length >= want && tail.every(({ s }) => (s[1] - s[0]) / SR <= 1.6)
    clip.use = ok
    if (!ok) { rejected.push(`${key} count=${clip.count} segs=${segs.length}`); continue }
    usedPos++
    for (const { i } of tail) dataset.pos.push({ path: join(ROOT, 'segments', 'pos', `${base}-${i}.wav`), voice })
    // Leading segments before the wake words (spoken instructions) are useful negatives.
    for (const { i } of segs.map((s, i) => ({ s, i })).slice(0, -want)) dataset.neg.push({ path: join(ROOT, 'segments', 'pos', `${base}-${i}.wav`), voice })
  } else {
    clip.use = clip.count === 0
    if (!clip.use) { rejected.push(`${key} count=${clip.count}`); continue }
    usedNeg++
    segs.forEach((_, i) => dataset.neg.push({ path: join(ROOT, 'segments', 'neg', `${base}-${i}.wav`), voice }))
  }
}
writeFileSync(CLIPS, JSON.stringify(clips, null, 1))
writeFileSync(join(ROOT, 'dataset.json'), JSON.stringify(dataset, null, 1))
console.log(`pos clips used ${usedPos}, neg clips used ${usedNeg}, pos utterances ${dataset.pos.length}, neg utterances ${dataset.neg.length}`)
console.log('rejected:\n' + rejected.join('\n'))

// Turn audio into the exact per-frame 96-d embeddings Octa's runtime computes (OpenWakeWordOnnxEngine.process),
// with per-frame labels. Output: feats/<name>.f32 (T x 96 float32, concatenated) + feats/<name>.json (clip index).
//   node extract.mjs tts     -> augmented positives + TTS negatives (voice-level train/test split)
//   node extract.mjs owner   -> the owner's recordings as negatives (file-level train/test split)
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import ort from 'onnxruntime-node'
import { readWav, rng, SR, speed } from './lib.mjs'

const ROOT = process.env.WAKEWORD_DIR || new URL('../../.octa/wakeword/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const FRAME = 1280
const MEL_FRAMES = 76
const MEL_BINS = 32
const EMB = 96
const mode = process.argv[2]
const variant = Number(process.argv[3] ?? 0)
const random = rng((mode === 'owner' ? 7 : 11) + variant * 1000)
const pick = (a, b) => a + (b - a) * random()

const opts = { executionProviders: ['cpu'], interOpNumThreads: 1, intraOpNumThreads: 2 }
const melSession = await ort.InferenceSession.create(join(ROOT, 'base', 'melspectrogram.onnx'), opts)
const embSession = await ort.InferenceSession.create(join(ROOT, 'base', 'embedding_model.onnx'), opts)

/** Byte-for-byte the runtime's streaming feature path, minus the classifier. */
class Featurizer {
  constructor() { this.raw = []; this.mel = new Array(MEL_FRAMES * MEL_BINS).fill(1) }
  async frame(frame) {
    for (const v of frame) this.raw.push(v)
    if (this.raw.length > SR * 10) this.raw = this.raw.slice(-SR * 10)
    const audio = this.raw.slice(-frame.length - 160 * 3)
    const melOut = Object.values(await melSession.run({ input: new ort.Tensor('float32', Float32Array.from(audio), [1, audio.length]) }))[0]
    for (const v of melOut.data) this.mel.push(v / 10 + 2)
    if (this.mel.length > MEL_FRAMES * MEL_BINS) this.mel = this.mel.slice(-MEL_FRAMES * MEL_BINS)
    const embOut = Object.values(await embSession.run({ input_1: new ort.Tensor('float32', Float32Array.from(this.mel), [1, MEL_FRAMES, MEL_BINS, 1]) }))[0]
    return Float32Array.from(embOut.data).slice(-EMB)
  }
}

async function embed(samples) {
  const f = new Featurizer()
  const out = new Float32Array(Math.floor(samples.length / FRAME) * EMB)
  for (let i = 0; (i + 1) * FRAME <= samples.length; i++) out.set(await f.frame(samples.subarray(i * FRAME, (i + 1) * FRAME)), i * EMB)
  return out
}

const rms = (x) => { let s = 0; for (const v of x) s += v * v; return Math.sqrt(s / Math.max(1, x.length)) }
const peak = (x) => { let p = 1; for (const v of x) p = Math.max(p, Math.abs(v)); return p }

// Background: random slices of the owner's TRAIN recordings, plus white noise.
const ownerDir = join(ROOT, 'owner', 'wav16k')
const ownerFiles = readdirSync(ownerDir).filter((n) => n.endsWith('.wav')).sort()
const ownerSplit = (name) => (parseInt(name.replace(/\D/g, '').slice(-3), 10) % 10 < 3 ? 'test' : 'train')
const bgFiles = ownerFiles.filter((n) => ownerSplit(n) === 'train')
const bgCache = new Map()
function background(length) {
  const out = new Float32Array(length)
  const kind = random()
  if (kind < 0.55) {
    const name = bgFiles[Math.floor(random() * bgFiles.length)]
    if (!bgCache.has(name)) { if (bgCache.size > 64) bgCache.clear(); bgCache.set(name, readWav(join(ownerDir, name))) }
    const src = bgCache.get(name)
    const start = Math.floor(random() * Math.max(1, src.length - length))
    for (let i = 0; i < length; i++) out[i] = src[start + i] ?? 0
  }
  if (kind >= 0.3) for (let i = 0; i < length; i++) out[i] += (random() * 2 - 1) * pick(5, 120)
  return out
}

/** Place an utterance in background noise; returns int16 audio and the utterance span. */
function compose(utterance, { lead, tail }) {
  const fast = speed(utterance, pick(0.88, 1.12))
  const level = 32767 * 10 ** (pick(-28, -3) / 20) / peak(fast)
  const start = Math.round(lead * SR)
  const total = start + fast.length + Math.round(tail * SR)
  const bg = background(total)
  const snrDb = pick(4, 30)
  const speechRms = rms(fast) * level
  const bgScale = random() < 0.15 ? 0 : speechRms / Math.max(1, rms(bg)) / 10 ** (snrDb / 20)
  const out = new Int16Array(total)
  for (let i = 0; i < total; i++) {
    const s = i >= start && i < start + fast.length ? fast[i - start] * level : 0
    out[i] = Math.max(-32768, Math.min(32767, Math.round(s + bg[i] * bgScale)))
  }
  return { audio: out, start, end: start + fast.length }
}

mkdirSync(join(ROOT, 'feats'), { recursive: true })
const index = []
const outName = mode === 'owneraug' ? `owneraug${variant}` : mode
const binPath = join(ROOT, 'feats', `${outName}.f32`)
const fd = openSync(binPath, 'w')
let offset = 0
function save(feats, labels, meta) {
  writeSync(fd, Buffer.from(feats.buffer, feats.byteOffset, feats.byteLength))
  index.push({ offset, frames: labels.length, labels, ...meta })
  offset += labels.length
}

const TEST_VOICES = new Set(['Kore', 'Puck', 'Leda', 'Orus', 'Sulafat', 'Achird'])
const started = Date.now()
if (mode === 'tts') {
  const dataset = JSON.parse(readFileSync(join(ROOT, 'dataset.json'), 'utf8'))
  const jobs = [
    ...dataset.pos.flatMap((u) => Array.from({ length: 5 }, (_, k) => ({ ...u, pos: true, k }))),
    ...dataset.neg.flatMap((u) => Array.from({ length: 2 }, (_, k) => ({ ...u, pos: false, k })))
  ]
  let n = 0
  for (const job of jobs) {
    const utt = readWav(job.path)
    const { audio, start, end } = compose(utt, { lead: pick(0.9, 2.2), tail: pick(0.5, 0.9) })
    const feats = await embed(audio)
    const labels = []
    for (let i = 0; i < feats.length / EMB; i++) {
      const frameEnd = (i + 1) * FRAME
      if (!job.pos) labels.push(0)
      else if (frameEnd >= end - FRAME && frameEnd <= end + 4 * FRAME) labels.push(1)
      else if (frameEnd < start + 0.2 * SR) labels.push(0)
      else labels.push(-1)
    }
    save(feats, labels, { kind: job.pos ? 'pos' : 'neg', voice: job.voice, split: TEST_VOICES.has(job.voice) ? 'test' : 'train', src: job.path.split(/[\\/]/).pop() })
    if (++n % 500 === 0) console.log(`${n}/${jobs.length} ${((Date.now() - started) / 1000).toFixed(0)}s`)
  }
} else if (mode === 'owner') {
  let n = 0
  for (const name of ownerFiles) {
    const audio = readWav(join(ownerDir, name))
    // A little gain variety so level is not a shortcut feature.
    const gain = pick(0.5, 1.6)
    for (let i = 0; i < audio.length; i++) audio[i] = Math.max(-32768, Math.min(32767, Math.round(audio[i] * gain)))
    const feats = await embed(audio)
    save(feats, new Array(feats.length / EMB).fill(0), { kind: 'owner', voice: 'owner', split: ownerSplit(name), src: name })
    if (++n % 100 === 0) console.log(`${n}/${ownerFiles.length} ${((Date.now() - started) / 1000).toFixed(0)}s`)
  }
}
if (mode === 'owneraug') {
  // Train-split recordings only, each speed-shifted, re-levelled and noised, so the model cannot memorise them.
  let n = 0
  const files = ownerFiles.filter((name) => ownerSplit(name) === 'train')
  for (const name of files) {
    const src = speed(readWav(join(ownerDir, name)), pick(0.9, 1.1))
    const gain = pick(0.4, 1.8)
    const noise = random() < 0.6 ? pick(20, 300) : 0
    const audio = new Int16Array(src.length)
    for (let i = 0; i < src.length; i++) audio[i] = Math.max(-32768, Math.min(32767, Math.round(src[i] * gain + (random() * 2 - 1) * noise)))
    const feats = await embed(audio)
    save(feats, new Array(feats.length / EMB).fill(0), { kind: 'owner', voice: 'owner', split: 'train', src: name })
    if (++n % 100 === 0) console.log(`${n}/${files.length} ${((Date.now() - started) / 1000).toFixed(0)}s`)
  }
}
closeSync(fd)
writeFileSync(join(ROOT, 'feats', `${outName}.json`), JSON.stringify(index))
console.log('done', mode, 'clips', index.length, 'frames', offset, `${((Date.now() - started) / 1000).toFixed(0)}s`)

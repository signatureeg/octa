// Stream an audio file through the runtime feature path + a classifier and print where it fires.
//   node score-file.mjs <audio> [model=octa.onnx] [threshold=0.45]
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import ort from 'onnxruntime-node'

const ROOT = process.env.WAKEWORD_DIR || new URL('../../.octa/wakeword/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const [file, modelName = 'octa.onnx', thr = '0.45'] = process.argv.slice(2)
const pcm = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', file, '-ar', '16000', '-ac', '1', '-f', 's16le', '-'], { maxBuffer: 1 << 30 })
const audio = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length >> 1)
const mel = await ort.InferenceSession.create(join(ROOT, 'base', 'melspectrogram.onnx'))
const emb = await ort.InferenceSession.create(join(ROOT, 'base', 'embedding_model.onnx'))
const cls = await ort.InferenceSession.create(join(ROOT, modelName))
let raw = [], melBuf = new Array(76 * 32).fill(1), feats = new Array(15 * 96).fill(0)
const hits = []
let best = { s: 0, t: 0 }
for (let i = 0; (i + 1) * 1280 <= audio.length; i++) {
  for (const v of audio.subarray(i * 1280, (i + 1) * 1280)) raw.push(v)
  if (raw.length > 160000) raw = raw.slice(-160000)
  const a = raw.slice(-1280 - 480)
  const m = Object.values(await mel.run({ input: new ort.Tensor('float32', Float32Array.from(a), [1, a.length]) }))[0]
  for (const v of m.data) melBuf.push(v / 10 + 2)
  melBuf = melBuf.slice(-76 * 32)
  const e = Object.values(await emb.run({ input_1: new ort.Tensor('float32', Float32Array.from(melBuf), [1, 76, 32, 1]) }))[0]
  feats.push(...Array.from(e.data).slice(-96))
  feats = feats.slice(-16 * 96)
  const s = Object.values(await cls.run({ input: new ort.Tensor('float32', Float32Array.from(feats), [1, 16, 96]) }))[0].data[0]
  const t = (i + 1) * 0.08
  if (s > best.s) best = { s, t }
  if (s >= Number(thr)) hits.push(`${t.toFixed(2)}s:${s.toFixed(2)}`)
}
console.log(`${file.split(/[\\/]/).pop()} ${(audio.length / 16000).toFixed(1)}s best ${best.s.toFixed(3)} @ ${best.t.toFixed(2)}s | hits ${hits.join(' ') || 'none'}`)

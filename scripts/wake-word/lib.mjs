import { readFileSync, writeFileSync } from 'node:fs'

export const SR = 16000

/** Read a 16-bit PCM mono WAV into an Int16Array (walks chunks, so LIST headers are fine). */
export function readWav(path) {
  const buf = readFileSync(path)
  let offset = 12
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    if (id === 'data') {
      const end = Math.min(buf.length, offset + 8 + size)
      const bytes = buf.subarray(offset + 8, end)
      return new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + (bytes.length & ~1)))
    }
    offset += 8 + size + (size & 1)
  }
  throw new Error(`no data chunk in ${path}`)
}

export function writeWav(path, samples) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0); header.writeUInt32LE(36 + samples.length * 2, 4); header.write('WAVE', 8)
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(SR, 24); header.writeUInt32LE(SR * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
  header.write('data', 36); header.writeUInt32LE(samples.length * 2, 40)
  writeFileSync(path, Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, samples.length * 2)]))
}

/** Split speech by silence: 20 ms RMS frames, threshold relative to the loudest frame. */
export function segmentSpeech(samples, { thresholdDb = -32, minGapMs = 280, minSpeechMs = 250, maxSpeechMs = 2000, padMs = 60 } = {}) {
  const hop = 320
  const energies = []
  for (let i = 0; i + hop <= samples.length; i += hop) {
    let sum = 0
    for (let j = i; j < i + hop; j++) sum += samples[j] * samples[j]
    energies.push(Math.sqrt(sum / hop))
  }
  const peak = Math.max(1, ...energies)
  const limit = peak * 10 ** (thresholdDb / 20)
  const raw = []
  let start = -1
  energies.forEach((energy, index) => {
    if (energy >= limit && start < 0) start = index
    if (energy < limit && start >= 0) { raw.push([start, index]); start = -1 }
  })
  if (start >= 0) raw.push([start, energies.length])
  const merged = []
  for (const seg of raw) {
    const last = merged[merged.length - 1]
    if (last && (seg[0] - last[1]) * 20 < minGapMs) last[1] = seg[1]
    else merged.push([...seg])
  }
  const pad = Math.round(padMs / 20)
  return merged
    .filter(([a, b]) => (b - a) * 20 >= minSpeechMs && (b - a) * 20 <= maxSpeechMs)
    .map(([a, b]) => [Math.max(0, (a - pad) * hop), Math.min(samples.length, (b + pad) * hop)])
}

/** Deterministic PRNG so augmentations and splits are reproducible. */
export function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Linear-interpolation resample by a speed factor (>1 = faster/shorter). */
export function speed(samples, factor) {
  const length = Math.floor(samples.length / factor)
  const out = new Int16Array(length)
  for (let i = 0; i < length; i++) {
    const x = i * factor
    const k = Math.floor(x)
    const f = x - k
    out[i] = Math.round((samples[k] ?? 0) * (1 - f) + (samples[k + 1] ?? samples[k] ?? 0) * f)
  }
  return out
}

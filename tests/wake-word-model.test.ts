import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createWakeWordDetector, OPEN_WAKE_WORD_FRAME_LENGTH } from '../electron/core/wake-word'

const ASSETS = join(__dirname, '..', 'assets', 'wake-word')
const FIXTURES = join(__dirname, 'fixtures', 'wake-word')

/** 16 kHz mono s16 WAV -> PCM samples (skips the 44-byte header written by ffmpeg). */
function pcm(name: string): Int16Array {
  const bytes = readFileSync(join(FIXTURES, name))
  const dataAt = bytes.indexOf('data') + 8
  return new Int16Array(bytes.buffer.slice(bytes.byteOffset + dataAt, bytes.byteOffset + bytes.length - ((bytes.length - dataAt) % 2)))
}

async function wakes(name: string): Promise<number> {
  const detector = await createWakeWordDetector({ wakeWordEnabled: true, wakeWordModelPath: join(ASSETS, 'octa.onnx'), wakeWordSensitivity: 0.55 })
  let hits = 0
  await detector.start(() => { hits += 1 })
  const audio = pcm(name)
  // Feed in microphone-sized chunks, like the renderer does.
  for (let at = 0; at < audio.length; at += 2_048) detector.feedPcm(audio.slice(at, at + 2_048))
  await (detector as unknown as { processing: Promise<void> }).processing
  detector.dispose?.()
  await new Promise((resolve) => setTimeout(resolve, 50))
  return hits
}

describe('bundled Octa wake-word model', () => {
  it('ships the three models the detector loads', () => {
    for (const file of ['octa.onnx', 'melspectrogram.onnx', 'embedding_model.onnx']) expect(readFileSync(join(ASSETS, file)).length).toBeGreaterThan(100_000)
    expect(OPEN_WAKE_WORD_FRAME_LENGTH).toBe(1_280)
  })

  it('wakes on "يا أوكتا" from a voice it was not trained on', async () => {
    // Two wake words 1.7 s apart; the 1.5 s cooldown allows both.
    expect(await wakes('ya-octa.wav')).toBeGreaterThanOrEqual(1)
  }, 60_000)

  it('stays asleep for near-miss words (okay, October, octopus, doctor, aktar...)', async () => {
    expect(await wakes('near-miss.wav')).toBe(0)
  }, 60_000)
})

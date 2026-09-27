import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../electron/types'
import { OpenWakeWordDetector, WakeWordSessionMachine, type OpenWakeWordRuntime } from '../electron/core/wake-word'

describe('wake word session state machine', () => {
  it('moves from idle to listening on a fake detector hit and barge-in back to listening', () => {
    const changes: string[] = []
    const machine = new WakeWordSessionMachine((state) => changes.push(state))
    expect(machine.state).toBe('idle')
    machine.transition({ type: 'wake-word' })
    expect(machine.state).toBe('listening')
    machine.transition({ type: 'thinking' })
    machine.transition({ type: 'speaking' })
    machine.transition({ type: 'user-audio' })
    expect(machine.state).toBe('listening')
    expect(changes).toEqual(['listening', 'thinking', 'speaking', 'listening'])
  })

  it('buffers arbitrary PCM into openWakeWord frames and fires only on a positive score', async () => {
    const process = vi.fn((frame: Int16Array) => (frame[0] === 7 ? 1 : -1))
    const detector = new OpenWakeWordDetector({
      modelPath: 'C:\\Octa\\models\\octa.onnx',
      threshold: 0.5,
      engine: { frameLength: 4, process },
      cooldownMs: 500,
      minConsecutiveFrames: 1
    })
    const hits: number[] = []
    detector.start((hit) => hits.push(hit.keywordIndex))
    detector.feedPcm(new Int16Array([0, 0]).buffer)
    detector.feedPcm(new Int16Array([0, 7, 0, 0, 0, 0]).buffer)
    await vi.waitFor(() => expect(process).toHaveBeenCalledTimes(2))
    expect(hits).toEqual([])
    detector.feedPcm(new Int16Array([7, 0, 0, 0]).buffer)
    await vi.waitFor(() => expect(hits).toEqual([0]))
    detector.dispose()
  })

  it('wakes only after the score stays above the threshold for three frames in a row by default', async () => {
    const scores = [0.9, 0.9, 0.1, 0.9, 0.9, 0.9, 0.9]
    const process = vi.fn(() => scores.shift() ?? 0)
    const detector = new OpenWakeWordDetector({ modelPath: 'C:\Octa\models\octa.onnx', threshold: 0.5, engine: { frameLength: 2, process } })
    const hits: number[] = []
    await detector.start((hit) => hits.push(hit.keywordIndex))
    detector.feedPcm(new Int16Array(2 * 5).buffer)
    await vi.waitFor(() => expect(process).toHaveBeenCalledTimes(5))
    expect(hits).toEqual([])
    detector.feedPcm(new Int16Array(2 * 2).buffer)
    await vi.waitFor(() => expect(hits).toEqual([0]))
    detector.dispose()
  })

  it('keeps the copied trigger settings compatible with the voice defaults', () => {
    expect(DEFAULT_SETTINGS.pushToTalkKey).toBe(DEFAULT_SETTINGS.hotkey)
  })

  it('runs the openWakeWord mel, embedding, and classifier stages locally', async () => {
    const tensors: Array<{ type: string; dims: readonly number[] }> = []
    class FakeTensor {
      constructor(type: string, _data: unknown, readonly dims: readonly number[]) {
        tensors.push({ type, dims })
      }
    }
    const melSession = {
      inputNames: ['input'],
      run: vi.fn(async () => ({ spec: { data: new Float32Array(8 * 32), dims: [1, 8, 32] } }))
    }
    const embeddingSession = {
      inputNames: ['input_1'],
      run: vi.fn(async () => ({ embedding: { data: new Float32Array(96).fill(0.1), dims: [1, 1, 1, 96] } }))
    }
    const classifierSession = {
      inputNames: ['input'],
      getInputs: () => [{ name: 'input', dims: [1, 1, 96] }],
      run: vi.fn(async () => ({ score: { data: new Float32Array([0.9]), dims: [1, 1] } }))
    }
    const runtime: OpenWakeWordRuntime = {
      Tensor: FakeTensor as unknown as OpenWakeWordRuntime['Tensor'],
      InferenceSession: {
        create: vi.fn(async (path: string) => path.includes('melspectrogram')
          ? melSession
          : path.includes('embedding_model')
            ? embeddingSession
            : classifierSession)
      }
    }
    const detector = new OpenWakeWordDetector({
      modelPath: 'C:\\Octa\\models\\octa.onnx',
      threshold: 0.5,
      runtime,
      minConsecutiveFrames: 1
    })
    const hits: number[] = []
    await detector.start((hit) => hits.push(hit.keywordIndex))
    detector.feedPcm(new Int16Array(1_280).buffer)
    await vi.waitFor(() => expect(hits).toEqual([0]))
    expect(tensors[0]).toEqual({ type: 'float32', dims: [1, 1_280] })
    expect(tensors[1]).toEqual({ type: 'float32', dims: [1, 76, 32, 1] })
    expect(tensors[2]).toEqual({ type: 'float32', dims: [1, 1, 96] })
    detector.dispose()
  })
})

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { AppSettings, VoicePhase } from '../types'

export const OPEN_WAKE_WORD_SAMPLE_RATE = 16_000
export const OPEN_WAKE_WORD_FRAME_LENGTH = 1_280 // 80 ms at 16 kHz
export const OPEN_WAKE_WORD_MEL_FRAMES = 76
export const OPEN_WAKE_WORD_MEL_BINS = 32

export interface WakeWordHit {
  keywordIndex: number
  timestamp: number
  score?: number
}

export interface WakeWordDetector {
  readonly frameLength: number
  start(onWake: (hit: WakeWordHit) => void): void | Promise<void>
  feedPcm(pcm: ArrayBuffer | ArrayBufferView): void
  stop(): void
  dispose?(): void
}

export class NullWakeWordDetector implements WakeWordDetector {
  readonly frameLength = OPEN_WAKE_WORD_FRAME_LENGTH

  constructor(readonly reason = 'Wake-word model is not configured.') {}

  start(): void {}
  feedPcm(): void {}
  stop(): void {}
  dispose(): void {}
}

/** Injectable engine seam for deterministic tests and alternative local runtimes. */
export interface OpenWakeWordEngine {
  readonly frameLength: number
  process(frame: Int16Array): number | Promise<number>
  reset?(): void
  dispose?(): void
}

interface OpenWakeWordTensor {
  data: unknown
  dims?: readonly number[]
}

interface OpenWakeWordSession {
  inputNames?: readonly string[]
  outputNames?: readonly string[]
  run(feeds: Record<string, unknown>): Promise<Record<string, OpenWakeWordTensor>>
  getInputs?(): Array<{ name: string; dims?: readonly (number | string)[] }>
}

export interface OpenWakeWordRuntime {
  Tensor: new (type: string, data: unknown, dims: readonly number[]) => unknown
  InferenceSession: {
    create(path: string, options?: Record<string, unknown>): Promise<OpenWakeWordSession>
  }
}

interface OpenWakeWordOnnxEngineOptions {
  runtime: OpenWakeWordRuntime
  modelPath: string
  melspectrogramPath: string
  embeddingPath: string
}

function firstOutput(outputs: Record<string, OpenWakeWordTensor>): OpenWakeWordTensor {
  const output = Object.values(outputs)[0]
  if (!output) throw new Error('openWakeWord returned no model output.')
  return output
}

function numericData(value: unknown): number[] {
  if (Array.isArray(value)) return value.filter((entry): entry is number => typeof entry === 'number')
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>)
  return []
}

function dimension(value: number | string | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

/**
 * The openWakeWord ONNX pipeline is intentionally kept in the main process:
 * PCM is converted to mel features, embeddings, and a custom classifier score
 * locally. Only a score crosses the detector boundary; no audio is uploaded.
 */
class OpenWakeWordOnnxEngine implements OpenWakeWordEngine {
  readonly frameLength = OPEN_WAKE_WORD_FRAME_LENGTH
  private readonly melSession: OpenWakeWordSession
  private readonly embeddingSession: OpenWakeWordSession
  private readonly classifierSession: OpenWakeWordSession
  private readonly tensor: OpenWakeWordRuntime['Tensor']
  private readonly melInputName: string
  private readonly embeddingInputName: string
  private readonly classifierInputName: string
  private readonly classifierWindow: number
  private readonly embeddingSize: number
  private rawBuffer: number[] = []
  private melBuffer: number[] = []
  private featureBuffer: number[] = []

  private constructor(
    private readonly options: OpenWakeWordOnnxEngineOptions,
    melSession: OpenWakeWordSession,
    embeddingSession: OpenWakeWordSession,
    classifierSession: OpenWakeWordSession
  ) {
    this.melSession = melSession
    this.embeddingSession = embeddingSession
    this.classifierSession = classifierSession
    this.tensor = options.runtime.Tensor
    this.melInputName = melSession.inputNames?.[0] ?? 'input'
    this.embeddingInputName = embeddingSession.inputNames?.[0] ?? 'input_1'
    this.classifierInputName = classifierSession.inputNames?.[0] ?? 'input'
    const classifierInput = classifierSession.getInputs?.()[0]
    const classifierDims = classifierInput?.dims ?? []
    this.classifierWindow = dimension(classifierDims[1], 16)
    this.embeddingSize = dimension(classifierDims[classifierDims.length - 1], 96)
    this.reset()
  }

  static async create(options: OpenWakeWordOnnxEngineOptions): Promise<OpenWakeWordOnnxEngine> {
    const sessionOptions = {
      executionProviders: ['cpu'],
      interOpNumThreads: 1,
      intraOpNumThreads: 1
    }
    const [melSession, embeddingSession, classifierSession] = await Promise.all([
      options.runtime.InferenceSession.create(resolve(options.melspectrogramPath), sessionOptions),
      options.runtime.InferenceSession.create(resolve(options.embeddingPath), sessionOptions),
      options.runtime.InferenceSession.create(resolve(options.modelPath), sessionOptions)
    ])
    return new OpenWakeWordOnnxEngine(options, melSession, embeddingSession, classifierSession)
  }

  async process(frame: Int16Array): Promise<number> {
    this.rawBuffer.push(...frame)
    if (this.rawBuffer.length > OPEN_WAKE_WORD_SAMPLE_RATE * 10) {
      this.rawBuffer = this.rawBuffer.slice(-OPEN_WAKE_WORD_SAMPLE_RATE * 10)
    }
    const audio = this.rawBuffer.slice(-frame.length - 160 * 3)
    if (audio.length < 400) return Number.NEGATIVE_INFINITY
    const melOutputs = await this.melSession.run({
      [this.melInputName]: new this.tensor('float32', Float32Array.from(audio), [1, audio.length])
    })
    const melOutput = firstOutput(melOutputs)
    const melValues = numericData(melOutput.data)
    const melBins = dimension(melOutput.dims?.[melOutput.dims.length - 1], OPEN_WAKE_WORD_MEL_BINS)
    if (melValues.length < melBins) return Number.NEGATIVE_INFINITY
    for (let offset = 0; offset + melBins <= melValues.length; offset += melBins) {
      for (let index = 0; index < melBins; index += 1) {
        // Matches openWakeWord's ONNX feature transform: spec / 10 + 2.
        this.melBuffer.push(melValues[offset + index] / 10 + 2)
      }
    }
    // The openWakeWord embedding model consumes a 76-frame mel window. Keep
    // only that sliding window so the detector can score after the first
    // 80-ms audio frame instead of waiting for an entire multi-second buffer.
    const requiredMelValues = OPEN_WAKE_WORD_MEL_FRAMES * melBins
    if (this.melBuffer.length > requiredMelValues) this.melBuffer = this.melBuffer.slice(-requiredMelValues)
    if (this.melBuffer.length < requiredMelValues) return Number.NEGATIVE_INFINITY

    const embeddingOutputs = await this.embeddingSession.run({
      [this.embeddingInputName]: new this.tensor(
        'float32',
        Float32Array.from(this.melBuffer),
        [1, OPEN_WAKE_WORD_MEL_FRAMES, melBins, 1]
      )
    })
    const embeddingValues = numericData(firstOutput(embeddingOutputs).data)
    if (embeddingValues.length < this.embeddingSize) return Number.NEGATIVE_INFINITY
    this.featureBuffer.push(...embeddingValues.slice(-this.embeddingSize))
    const maxFeatureValues = Math.max(this.classifierWindow, 120) * this.embeddingSize
    if (this.featureBuffer.length > maxFeatureValues) this.featureBuffer = this.featureBuffer.slice(-maxFeatureValues)
    const required = this.classifierWindow * this.embeddingSize
    if (this.featureBuffer.length < required) return Number.NEGATIVE_INFINITY

    const classifierInput = Float32Array.from(this.featureBuffer.slice(-required))
    const classifierOutputs = await this.classifierSession.run({
      [this.classifierInputName]: new this.tensor(
        'float32',
        classifierInput,
        [1, this.classifierWindow, this.embeddingSize]
      )
    })
    const scores = numericData(firstOutput(classifierOutputs).data)
    return scores.length > 0 ? Math.max(...scores) : Number.NEGATIVE_INFINITY
  }

  reset(): void {
    this.rawBuffer = []
    this.melBuffer = new Array(OPEN_WAKE_WORD_MEL_FRAMES * OPEN_WAKE_WORD_MEL_BINS).fill(1)
    this.featureBuffer = new Array(Math.max(0, this.classifierWindow - 1) * this.embeddingSize).fill(0)
  }

  dispose(): void {
    this.reset()
  }
}

export interface OpenWakeWordDetectorOptions {
  modelPath: string
  melspectrogramPath?: string
  embeddingPath?: string
  sensitivity?: number
  threshold?: number
  engine?: OpenWakeWordEngine
  runtime?: OpenWakeWordRuntime
  cooldownMs?: number
  /**
   * Frames in a row (80 ms each) that must reach the threshold before waking. A spoken "يا أوكتا"
   * stays above it for 4-6 frames; most look-alike words ("أكتر", "أو كده") spike for one or two.
   */
  minConsecutiveFrames?: number
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function thresholdFor(options: OpenWakeWordDetectorOptions): number {
  if (typeof options.threshold === 'number' && Number.isFinite(options.threshold)) {
    return clamp(options.threshold, 0, 1)
  }
  // More sensitivity means a lower classifier score is enough to wake.
  return 1 - clamp(options.sensitivity ?? 0.55, 0, 1)
}

export class OpenWakeWordDetector implements WakeWordDetector {
  private engine: OpenWakeWordEngine | undefined
  private onWake: ((hit: WakeWordHit) => void) | undefined
  private pending = new Int16Array(0)
  private active = false
  private lastHit = 0
  private readonly threshold: number
  private readonly cooldownMs: number
  private readonly minConsecutiveFrames: number
  private run = 0
  private processing = Promise.resolve()

  constructor(private readonly options: OpenWakeWordDetectorOptions) {
    this.engine = options.engine
    this.threshold = thresholdFor(options)
    this.cooldownMs = Math.max(500, Math.trunc(options.cooldownMs ?? 1_500))
    this.minConsecutiveFrames = Math.max(1, Math.trunc(options.minConsecutiveFrames ?? 3))
  }

  get frameLength(): number {
    return this.engine?.frameLength ?? OPEN_WAKE_WORD_FRAME_LENGTH
  }

  async start(onWake: (hit: WakeWordHit) => void): Promise<void> {
    if (!this.engine) {
      const runtime = this.options.runtime ?? await loadOpenWakeWordRuntime()
      this.engine = await OpenWakeWordOnnxEngine.create({
        runtime,
        modelPath: this.options.modelPath,
        melspectrogramPath: this.options.melspectrogramPath ?? join(dirname(resolve(this.options.modelPath)), 'melspectrogram.onnx'),
        embeddingPath: this.options.embeddingPath ?? join(dirname(resolve(this.options.modelPath)), 'embedding_model.onnx')
      })
    }
    this.engine.reset?.()
    this.pending = new Int16Array(0)
    this.run = 0
    this.onWake = onWake
    this.active = true
  }

  feedPcm(pcm: ArrayBuffer | ArrayBufferView): void {
    if (!this.active || !this.engine) return
    const frame = toInt16(pcm)
    if (frame.length === 0) return
    const combined = new Int16Array(this.pending.length + frame.length)
    combined.set(this.pending)
    combined.set(frame, this.pending.length)
    let offset = 0
    while (combined.length - offset >= this.frameLength) {
      const current = combined.slice(offset, offset + this.frameLength)
      offset += this.frameLength
      const engine = this.engine
      this.processing = this.processing
        .then(() => engine.process(current))
        .then((score) => this.acceptScore(score))
        .catch(() => undefined)
    }
    this.pending = combined.slice(offset)
  }

  stop(): void {
    this.active = false
    this.onWake = undefined
    this.pending = new Int16Array(0)
    this.run = 0
    this.engine?.reset?.()
  }

  dispose(): void {
    this.stop()
    this.engine?.dispose?.()
    this.engine = undefined
  }

  private acceptScore(score: number): void {
    if (!this.active) return
    if (!Number.isFinite(score) || score < this.threshold) {
      this.run = 0
      return
    }
    this.run += 1
    if (this.run < this.minConsecutiveFrames) return
    const timestamp = Date.now()
    if (timestamp - this.lastHit < this.cooldownMs) return
    this.lastHit = timestamp
    this.onWake?.({ keywordIndex: 0, timestamp, score })
  }
}

function toInt16(value: ArrayBuffer | ArrayBufferView): Int16Array {
  if (value instanceof Int16Array) return value
  if (value instanceof ArrayBuffer) {
    return new Int16Array(value.slice(0, value.byteLength - (value.byteLength % 2)))
  }
  const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  const usable = bytes.byteLength - (bytes.byteLength % 2)
  return new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + usable))
}

async function loadOpenWakeWordRuntime(): Promise<OpenWakeWordRuntime> {
  const loaded = await import('onnxruntime-node') as unknown as Partial<OpenWakeWordRuntime>
  if (!loaded.Tensor || !loaded.InferenceSession) throw new Error('ONNX Runtime did not expose its Node API.')
  return loaded as OpenWakeWordRuntime
}

export interface WakeWordDetectorSettings {
  wakeWordEnabled: boolean
  wakeWordModelPath: string
  wakeWordSensitivity: number
}

/** Loads the three openWakeWord ONNX artifacts lazily and fails closed. */
export async function createWakeWordDetector(
  settings: WakeWordDetectorSettings,
  runtime?: OpenWakeWordRuntime
): Promise<WakeWordDetector> {
  if (!settings.wakeWordEnabled) return new NullWakeWordDetector('Wake word is disabled in Settings.')
  const modelPath = settings.wakeWordModelPath.trim()
  if (!modelPath || !existsSync(modelPath)) {
    return new NullWakeWordDetector(`Wake-word model was not found: ${modelPath || '(empty path)'}`)
  }
  const root = dirname(resolve(modelPath))
  const melspectrogramPath = join(root, 'melspectrogram.onnx')
  const embeddingPath = join(root, 'embedding_model.onnx')
  if (!existsSync(melspectrogramPath) || !existsSync(embeddingPath)) {
    return new NullWakeWordDetector(
      `openWakeWord feature models are missing beside ${modelPath}. Expected melspectrogram.onnx and embedding_model.onnx.`
    )
  }
  try {
    const loadedRuntime = runtime ?? await loadOpenWakeWordRuntime()
    return new OpenWakeWordDetector({
      modelPath,
      melspectrogramPath,
      embeddingPath,
      sensitivity: settings.wakeWordSensitivity,
      runtime: loadedRuntime
    })
  } catch (error) {
    return new NullWakeWordDetector(
      `openWakeWord could not load: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

export type WakeSessionEvent =
  | { type: 'wake-word' }
  | { type: 'push-to-talk' }
  | { type: 'user-audio' }
  | { type: 'thinking' }
  | { type: 'speaking' }
  | { type: 'turn-complete' }
  | { type: 'stop' }
  | { type: 'error' }

/** Deterministic state machine shared by the real controller and fake-detector tests. */
export class WakeWordSessionMachine {
  private phase: VoicePhase = 'idle'
  private readonly listener?: (phase: VoicePhase) => void

  constructor(listener?: (phase: VoicePhase) => void) {
    this.listener = listener
  }

  get state(): VoicePhase {
    return this.phase
  }

  transition(event: WakeSessionEvent): VoicePhase {
    const next = this.nextState(event)
    if (next !== this.phase) {
      this.phase = next
      this.listener?.(next)
    }
    return this.phase
  }

  reset(): void {
    this.transition({ type: 'stop' })
  }

  private nextState(event: WakeSessionEvent): VoicePhase {
    if (event.type === 'stop') return 'idle'
    if (event.type === 'error') return 'error'
    if (event.type === 'wake-word' || event.type === 'push-to-talk') {
      return this.phase === 'idle' || this.phase === 'error' ? 'listening' : this.phase
    }
    if (event.type === 'user-audio') return this.phase === 'speaking' ? 'listening' : this.phase
    if (event.type === 'thinking') return this.phase === 'listening' ? 'thinking' : this.phase
    if (event.type === 'speaking') return this.phase === 'thinking' || this.phase === 'listening' ? 'speaking' : this.phase
    if (event.type === 'turn-complete') return this.phase === 'speaking' || this.phase === 'thinking' ? 'listening' : this.phase
    return this.phase
  }
}

export type WakeWordSettings = Pick<
  AppSettings,
  'wakeWordEnabled' | 'wakeWordModelPath' | 'wakeWordSensitivity'
>

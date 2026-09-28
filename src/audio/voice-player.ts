function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function sampleRate(mimeType: string): number {
  const rate = mimeType.match(/rate=(\d+)/i)
  return rate ? Number(rate[1]) : 24_000
}

/**
 * Head start given to the first chunk of a reply. Live audio arrives in ~40 ms pieces with network
 * jitter; starting each late piece "now" left tiny gaps between them, which is heard as a buzz.
 * Scheduling a little ahead keeps the pieces back to back.
 */
export const PLAYBACK_LEAD_SECONDS = 0.12

/** Start time for the next chunk: right after the previous one, or a short lead from now after a gap. */
export function nextStartTime(currentTime: number, scheduledEnd: number, lead = PLAYBACK_LEAD_SECONDS): number {
  return scheduledEnd > currentTime ? scheduledEnd : currentTime + lead
}

let activePlayer: VoiceAudioPlayer | undefined

/** How loud Octa is speaking right now, 0..1 (drives the face's mouth). */
export function currentVoiceLevel(): number {
  return activePlayer?.level() ?? 0
}

export class VoiceAudioPlayer {
  private context: AudioContext | undefined
  private analyser: AnalyserNode | undefined
  private readonly samples = new Float32Array(512)
  private nextStart = 0
  private queue: Promise<void> = Promise.resolve()
  private epoch = 0
  private readonly sources = new Set<AudioBufferSourceNode>()

  constructor() {
    activePlayer = this
  }

  private getContext(): AudioContext {
    if (!this.context) {
      this.context = new AudioContext({ latencyHint: 'interactive' })
      this.analyser = this.context.createAnalyser()
      this.analyser.fftSize = 1024
      this.analyser.connect(this.context.destination)
    }
    return this.context
  }

  /** RMS loudness of what is playing now, scaled to 0..1. */
  level(): number {
    if (!this.analyser || !this.context || this.context.state !== 'running' || this.sources.size === 0) return 0
    this.analyser.getFloatTimeDomainData(this.samples)
    let sum = 0
    for (const sample of this.samples) sum += sample * sample
    return Math.min(1, Math.sqrt(sum / this.samples.length) * 4)
  }

  /** Chunks are scheduled strictly in arrival order, even when decoding one takes longer. */
  play(data: string, mimeType: string): Promise<void> {
    const epoch = this.epoch
    const task = this.queue.then(() => this.schedule(data, mimeType, epoch))
    this.queue = task.catch(() => undefined)
    return task
  }

  private async schedule(data: string, mimeType: string, epoch: number): Promise<void> {
    const context = this.getContext()
    if (context.state !== 'running') await context.resume()
    const bytes = decodeBase64(data)
    let buffer: AudioBuffer
    if (/pcm|l16/i.test(mimeType)) {
      const raw = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2))
      buffer = context.createBuffer(1, raw.length, sampleRate(mimeType))
      const channel = buffer.getChannelData(0)
      for (let index = 0; index < raw.length; index += 1) channel[index] = raw[index] / 32_768
    } else {
      buffer = await context.decodeAudioData(bytes.slice().buffer)
    }
    if (epoch !== this.epoch) return
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(this.analyser ?? context.destination)
    this.sources.add(source)
    source.addEventListener('ended', () => this.sources.delete(source), { once: true })
    const start = nextStartTime(context.currentTime, this.nextStart)
    source.start(start)
    this.nextStart = start + buffer.duration
  }

  stop(): void {
    this.epoch += 1
    for (const source of this.sources) {
      try {
        source.stop()
      } catch {
        // A source that has already ended is safe to ignore.
      }
    }
    this.sources.clear()
    this.nextStart = 0
  }

  async dispose(): Promise<void> {
    this.stop()
    if (activePlayer === this) activePlayer = undefined
    await this.context?.close()
    this.context = undefined
  }
}

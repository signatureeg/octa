import { Buffer } from 'node:buffer'
import type { AppSettings, VoiceAudioEvent, VoiceLanguage, VoiceState, VoiceTranscriptEvent } from '../types'
import { liveFunctionCalls, type GeminiLiveEvent } from '../cloud/gemini-live'
import type { ConversationRepository } from './voice/conversation'
import {
  ReadBackApprovalGate,
  isApprovalPhrase,
  type ApprovalResult
} from './voice/readback'
import { detectConversationLanguage } from './voice/language'
import {
  WakeWordSessionMachine,
  type WakeSessionEvent,
  type WakeWordDetector
} from './wake-word'
import type { WorkflowGateApproveRequest, WorkflowGateApproval } from './voice/workflow-gate'

export type VoiceSessionSource = 'wake-word' | 'push-to-talk'

export interface VoiceSession {
  open(): Promise<void> | void
  sendPcm(pcm: ArrayBuffer | ArrayBufferView): void | Promise<void>
  sendText(text: string): void | Promise<void>
  interrupt(): void | Promise<void>
  close(): void
  sendToolResponse?(responses: Array<{ id: string; name: string; response: Record<string, unknown> }>): void
}

export interface VoiceFallback {
  speak(text: string, options?: { voiceName?: string }): void | Promise<void>
  transcribe?(audio: ArrayBuffer, options?: { language?: 'auto' | 'ar' | 'en' }): Promise<string>
  stop?(): void | Promise<void>
}

export interface VoiceControllerOptions {
  settings: () => AppSettings
  detector: WakeWordDetector
  createSession: (options: {
    source: VoiceSessionSource
    model: string
    onEvent: (event: GeminiLiveEvent) => void
  }) => VoiceSession | Promise<VoiceSession>
  fallback?: VoiceFallback
  conversation?: ConversationRepository
  approvalGate?: ReadBackApprovalGate
  approveGate?: (request: WorkflowGateApproveRequest) => WorkflowGateApproval | Promise<WorkflowGateApproval>
  onState?: (state: VoiceState) => void
  onTranscript?: (event: VoiceTranscriptEvent) => void
  onLanguage?: (language: VoiceLanguage, conversationId: string | null) => void
  onMessage?: (message: string, language: VoiceLanguage | null) => void
  /** Runs a function the Live voice called; the result is sent back as the tool response. */
  onToolCall?: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
  conversationId?: string
}

const DEFAULT_STATE: VoiceState = {
  phase: 'idle',
  source: null,
  transcript: '',
  language: null,
  model: null
}

function copyAudio(value: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value.slice(0)
  const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  return bytes.slice().buffer
}

function hasSpeech(value: ArrayBuffer | ArrayBufferView): boolean {
  const bytes = new Uint8Array(
    value instanceof ArrayBuffer ? value : value.buffer,
    value instanceof ArrayBuffer ? 0 : value.byteOffset,
    value instanceof ArrayBuffer ? value.byteLength : value.byteLength
  )
  if (bytes.byteLength < 2) return false
  const samples = new Int16Array(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength - (bytes.byteLength % 2))
  )
  if (samples.length === 0) return false
  let sum = 0
  for (const sample of samples) {
    const normalized = sample / 32_768
    sum += normalized * normalized
  }
  return Math.sqrt(sum / samples.length) >= 0.018
}

function mirrorMessage(language: VoiceLanguage | null): string {
  if (language === 'en') return 'I need to read the exact payload back first.'
  if (language === 'mixed') return 'لازم أقرأ الـ payload كامل الأول قبل الموافقة.'
  return 'لازم أقرأ التفاصيل كاملة الأول قبل الموافقة.'
}

/**
 * Main-process voice controller. The detector receives every PCM frame locally;
 * a Live session is created only after a wake hit or a push-to-talk trigger.
 */
export class VoiceController {
  private readonly machine: WakeWordSessionMachine
  private state: VoiceState = { ...DEFAULT_STATE }
  private session: VoiceSession | undefined
  private source: VoiceSessionSource | null = null
  private opening: Promise<void> | undefined
  private liveReady = false
  private started = false
  private pendingAudio: ArrayBuffer[] = []
  private fallbackAudio: ArrayBuffer[] = []
  private fallbackTimer: ReturnType<typeof setTimeout> | undefined
  private lastFinalUserText = ''
  private readonly approvalGate: ReadBackApprovalGate

  constructor(private readonly options: VoiceControllerOptions) {
    this.approvalGate = options.approvalGate ?? new ReadBackApprovalGate()
    this.machine = new WakeWordSessionMachine((phase) => {
      this.state = { ...this.state, phase }
      this.options.onState?.({ ...this.state })
    })
  }

  get currentState(): VoiceState {
    return { ...this.state }
  }

  get readBack(): ReadBackApprovalGate {
    return this.approvalGate
  }

  replaceFallback(fallback: VoiceFallback | undefined): void {
    this.options.fallback = fallback
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    try {
      await this.options.detector.start((hit) => {
        void this.handleWake(hit.timestamp)
      })
    } catch (error) {
      this.options.onMessage?.(
        `Wake-word detector unavailable: ${error instanceof Error ? error.message : String(error)}`,
        null
      )
    }
  }

  /** Re-load the local detector after the owner changes its model settings. */
  async replaceDetector(detector: WakeWordDetector): Promise<void> {
    this.options.detector.stop()
    this.options.detector.dispose?.()
    this.options.detector = detector
    if (!this.started) return
    await this.options.detector.start((hit) => {
      void this.handleWake(hit.timestamp)
    })
  }

  async pushToTalk(): Promise<void> {
    if (!this.options.settings().pushToTalkEnabled) return
    if (this.state.phase === 'idle' || this.state.phase === 'error') {
      await this.activate('push-to-talk')
      return
    }
    if (this.source === 'push-to-talk' && this.state.phase === 'listening') {
      this.stopSession()
      return
    }
    if (this.state.phase === 'speaking') await this.interrupt()
  }

  async handleWake(timestamp = Date.now()): Promise<void> {
    if (!this.options.settings().wakeWordEnabled) return
    if (this.state.phase !== 'idle' && this.state.phase !== 'error') return
    await this.activate('wake-word', timestamp)
  }

  feedPcm(pcm: ArrayBuffer | ArrayBufferView): void {
    // This call is intentionally first and unconditional: before activation the
    // detector sees PCM, but no cloud client or network transport does.
    this.options.detector.feedPcm(pcm)
    if (this.state.phase === 'speaking' && hasSpeech(pcm)) {
      void this.interrupt()
    }
    if (!this.session || !this.liveReady) {
      if (this.opening && this.pendingAudio.length < 4) this.pendingAudio.push(copyAudio(pcm))
      else if (this.source && this.options.fallback?.transcribe) {
        this.fallbackAudio.push(copyAudio(pcm))
        this.scheduleFallbackTranscription()
      }
      return
    }
    try {
      const result = this.session.sendPcm(pcm)
      if (result instanceof Promise) void result.catch((error) => this.handleLiveFailure(error))
    } catch (error) {
      this.handleLiveFailure(error)
    }
  }

  async interrupt(): Promise<void> {
    await this.session?.interrupt()
    await this.options.fallback?.stop?.()
    this.machine.transition({ type: 'user-audio' })
  }

  /** Speak planner questions/results and register exact read-back payloads. */
  async readBackPayload(payload: unknown, text: string, gateId?: string): Promise<void> {
    const spoken = text.trim()
    if (!spoken) return
    await this.speakExact(spoken)
    this.approvalGate.recordReadBack(payload, spoken, gateId)
  }

  /** Put an app update into the open live conversation; false when no session is open. */
  announce(text: string): boolean {
    const value = text.trim()
    if (!value || !this.session || !this.liveReady) return false
    try {
      const result = this.session.sendText(value)
      if (result instanceof Promise) void result.catch((error) => this.handleLiveFailure(error))
      return true
    } catch {
      return false
    }
  }

  async speak(text: string): Promise<void> {
    await this.speakExact(text.trim())
  }

  async approveTranscript(transcript: string): Promise<ApprovalResult> {
    const result = this.approvalGate.approve(transcript)
    if (result.approved) {
      if (result.gateId && this.options.approveGate) {
        await this.options.approveGate({
          gateId: result.gateId,
          payload: result.payload,
          channel: 'voice'
        })
      }
      return result
    }
    if (isApprovalPhrase(transcript)) {
      const language = this.state.language
      const message = mirrorMessage(language)
      this.options.onMessage?.(message, language)
      await this.speakExact(message).catch(() => undefined)
    }
    return result
  }

  async submitFallbackCapture(audio: ArrayBuffer, language: 'auto' | 'ar' | 'en' = 'auto'): Promise<string> {
    if (!this.options.fallback?.transcribe) throw new Error('Voice fallback transcription is unavailable.')
    const text = (await this.options.fallback.transcribe(audio, { language })).trim()
    if (text) await this.handleFinalUserTranscript(text)
    return text
  }

  stopSession(): void {
    void this.flushFallbackTranscription()
    this.session?.close()
    this.session = undefined
    this.liveReady = false
    this.opening = undefined
    this.source = null
    this.pendingAudio = []
    this.fallbackAudio = []
    this.clearFallbackTimer()
    this.machine.transition({ type: 'stop' })
  }

  dispose(): void {
    this.clearFallbackTimer()
    this.options.detector.stop()
    this.options.detector.dispose?.()
    this.stopSession()
    this.started = false
  }

  private async activate(source: VoiceSessionSource, _timestamp = Date.now()): Promise<void> {
    if (this.opening || this.session) return
    this.source = source
    this.pendingAudio = []
    this.lastFinalUserText = ''
    this.machine.transition({ type: source === 'wake-word' ? 'wake-word' : 'push-to-talk' })
    const settings = this.options.settings()
    const model = settings.geminiLiveModelOverride.trim() || settings.geminiLiveModel.trim()
    this.state = {
      ...this.state,
      source,
      model: model || null,
      error: undefined
    }
    this.options.onState?.({ ...this.state })
    this.opening = (async () => {
      try {
        const session = await this.options.createSession({
          source,
          model,
          onEvent: (event) => this.handleLiveEvent(event)
        })
        this.session = session
        await session.open()
        this.liveReady = true
        if (source === 'wake-word') {
          const greeting = settings.wakeGreeting.trim()
          if (greeting) await session.sendText(greeting)
        }
        const pending = this.pendingAudio.splice(0)
        for (const chunk of pending) await session.sendPcm(chunk)
      } catch (error) {
        this.handleLiveFailure(error)
      } finally {
        this.opening = undefined
      }
    })()
    await this.opening
  }

  private handleLiveEvent(event: GeminiLiveEvent): void {
    if (event.type === 'audio') {
      this.machine.transition({ type: 'speaking' })
      return
    }
    if (event.type === 'transcript') {
      this.state = { ...this.state, transcript: event.text }
      this.options.onTranscript?.({
        text: event.text,
        final: event.final,
        source: event.source,
        languageHint: event.languageHint
      })
      if (event.source === 'assistant') {
        this.machine.transition({ type: 'speaking' })
      } else if (event.final) {
        this.machine.transition({ type: 'thinking' })
        void this.handleFinalUserTranscript(event.text, event.languageHint)
      }
      this.options.onState?.({ ...this.state })
      return
    }
    if (event.type === 'interrupted') {
      this.machine.transition({ type: 'user-audio' })
      return
    }
    if (event.type === 'turn-complete') {
      this.machine.transition({ type: 'turn-complete' })
      return
    }
    if (event.type === 'tool-call') {
      void this.handleToolCall(event.value)
      return
    }
    if (event.type === 'error') this.handleLiveFailure(new Error(event.message))
  }

  private async handleToolCall(value: unknown): Promise<void> {
    const calls = liveFunctionCalls(value)
    if (calls.length === 0) return
    const session = this.session
    const responses = await Promise.all(calls.map(async (call) => {
      let response: Record<string, unknown>
      try {
        response = this.options.onToolCall
          ? await this.options.onToolCall(call.name, call.args)
          : { error: 'Tools are unavailable.' }
      } catch (error) {
        response = { error: error instanceof Error ? error.message : String(error) }
      }
      return { id: call.id, name: call.name, response }
    }))
    if (session !== this.session || !this.liveReady) return
    try {
      session?.sendToolResponse?.(responses)
    } catch (error) {
      this.handleLiveFailure(error)
    }
  }

  private async handleFinalUserTranscript(text: string, languageHint?: string): Promise<void> {
    const value = text.trim()
    if (!value || value === this.lastFinalUserText) return
    this.lastFinalUserText = value
    const language = detectConversationLanguage(value, languageHint)
    this.state = { ...this.state, language, transcript: value }
    this.options.conversation?.append(
      this.options.conversationId ?? 'default',
      'user',
      value,
      languageHint
    )
    this.options.onLanguage?.(language, this.options.conversationId ?? null)
    this.options.onState?.({ ...this.state })
    if (isApprovalPhrase(value)) await this.approveTranscript(value)
  }

  private async speakExact(text: string): Promise<void> {
    if (!text) return
    if (this.session && this.liveReady) {
      try {
        await this.session.sendText(text)
        return
      } catch (error) {
        this.options.onMessage?.(
          `Gemini Live speech failed: ${error instanceof Error ? error.message : String(error)}`,
          this.state.language
        )
      }
    }
    if (this.options.fallback) {
      try {
        await this.options.fallback.speak(text, { voiceName: this.options.settings().voiceName })
        return
      } catch (error) {
        this.options.onMessage?.(
          `TTS fallback unavailable: ${error instanceof Error ? error.message : String(error)}`,
          this.state.language
        )
      }
    }
    throw new Error('No voice output transport is available.')
  }

  private handleLiveFailure(error: unknown): void {
    this.liveReady = false
    const message = error instanceof Error ? error.message : String(error)
    this.state = { ...this.state, error: message }
    this.options.onState?.({ ...this.state })
    this.options.onMessage?.(`Gemini Live unavailable: ${message}`, this.state.language)
    try {
      this.session?.close()
    } catch {
      // best effort
    }
    if (this.pendingAudio.length > 0 && this.options.fallback?.transcribe) {
      this.fallbackAudio.push(...this.pendingAudio.splice(0))
      this.scheduleFallbackTranscription()
    }
    this.session = undefined
    this.machine.transition({ type: 'error' })
  }

  private scheduleFallbackTranscription(): void {
    this.clearFallbackTimer()
    this.fallbackTimer = setTimeout(() => {
      this.fallbackTimer = undefined
      void this.flushFallbackTranscription()
    }, 700)
    this.fallbackTimer.unref?.()
  }

  private clearFallbackTimer(): void {
    if (this.fallbackTimer === undefined) return
    clearTimeout(this.fallbackTimer)
    this.fallbackTimer = undefined
  }

  private async flushFallbackTranscription(): Promise<void> {
    this.clearFallbackTimer()
    const transcribe = this.options.fallback?.transcribe
    if (!transcribe || this.fallbackAudio.length === 0) return
    const chunks = this.fallbackAudio.splice(0)
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
    const language = this.state.language === 'ar-EG' ? 'ar' : this.state.language === 'en' ? 'en' : 'auto'
    try {
      await this.handleFinalUserTranscript(await transcribe(pcm16ToWav(bytes), { language }))
    } catch (error) {
      this.options.onMessage?.(
        `Fallback transcription unavailable: ${error instanceof Error ? error.message : String(error)}`,
        this.state.language
      )
    }
  }
}

/** Backwards-compatible name retained for the copied Tamim OS dictation seam. */
export class DictationController extends VoiceController {}

/** Convert the local PCM stream to the WAV container expected by fallback STT. */
export function pcm16ToWav(pcm: ArrayBuffer | ArrayBufferView, sampleRate = 16_000): ArrayBuffer {
  const bytes = Buffer.from(
    pcm instanceof ArrayBuffer ? pcm : pcm.buffer,
    pcm instanceof ArrayBuffer ? 0 : pcm.byteOffset,
    pcm instanceof ArrayBuffer ? pcm.byteLength : pcm.byteLength
  )
  const output = Buffer.alloc(44 + bytes.byteLength)
  output.write('RIFF', 0)
  output.writeUInt32LE(36 + bytes.byteLength, 4)
  output.write('WAVE', 8)
  output.write('fmt ', 12)
  output.writeUInt32LE(16, 16)
  output.writeUInt16LE(1, 20)
  output.writeUInt16LE(1, 22)
  output.writeUInt32LE(sampleRate, 24)
  output.writeUInt32LE(sampleRate * 2, 28)
  output.writeUInt16LE(2, 32)
  output.writeUInt16LE(16, 34)
  output.write('data', 36)
  output.writeUInt32LE(bytes.byteLength, 40)
  bytes.copy(output, 44)
  return output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength)
}

export function voiceAudioEvent(data: Buffer, mimeType: string): VoiceAudioEvent {
  return {
    data: data.toString('base64'),
    mimeType
  }
}

export function wakeSessionEventForPhase(phase: VoiceState['phase']): WakeSessionEvent {
  if (phase === 'listening') return { type: 'wake-word' }
  if (phase === 'thinking') return { type: 'thinking' }
  if (phase === 'speaking') return { type: 'speaking' }
  if (phase === 'error') return { type: 'error' }
  return { type: 'stop' }
}

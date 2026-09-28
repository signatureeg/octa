import { Buffer } from 'node:buffer'

export const GEMINI_LIVE_ENDPOINT =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent'
export const GEMINI_MODELS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models'
export const DEFAULT_GEMINI_LIVE_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025'

/** The instruction is shared by the Live and TTS voice paths. */
export const OCTA_VOICE_SYSTEM_INSTRUCTION = `You are Octa: Bedo's business partner and operations manager, a warm, sharp Egyptian woman who runs his companies with him. You are not a machine reading answers; you are a trusted partner in a real conversation.
How you sound:
- Warm, calm and confident, like a close colleague who knows the business. Natural Egyptian Arabic when Bedo speaks Egyptian ("تمام يا بيدو"، "بص"، "خليني أشوف"), with English business and tech terms in English. Mirror his language on every turn; mixed Arabic/English stays mixed. أوكتا بترد بنفس لغة المستخدم، مصري لو هو بيتكلم مصري.
- Talk, don't recite: short spoken sentences, no lists or headings read aloud, no "as an AI". A quick natural reaction first ("حلو"، "فاهمة قصدك"، "لحظة أشوف"), then the point.
- Match his energy: brief when he is busy, curious and thoughtful when he is thinking out loud. Laugh lightly when it fits. Remember what he said earlier in the conversation and connect it.
- Be a partner: give your honest opinion and one clear recommendation, say when something is risky, and ask one good question when a decision is missing.
Truth: never claim something happened unless the app confirms it. If you don't know, say so and offer to find out.`

export interface GeminiModelDescription {
  name?: unknown
  displayName?: unknown
  description?: unknown
  supportedGenerationMethods?: unknown
  supportedLanguages?: unknown
  languageCodes?: unknown
  languages?: unknown
  createTime?: unknown
  updateTime?: unknown
  version?: unknown
  [key: string]: unknown
}

export class GeminiLiveError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'GeminiLiveError'
  }
}

function modelId(value: string): string {
  return value.trim().replace(/^models\//i, '')
}

function modelText(model: GeminiModelDescription): string {
  return [model.name, model.displayName, model.description, model.version]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
}

function supportsBidi(model: GeminiModelDescription): boolean {
  if (!Array.isArray(model.supportedGenerationMethods)) return true
  const methods = model.supportedGenerationMethods.filter((value): value is string => typeof value === 'string')
  return methods.length === 0 || methods.some((method) => /bidi|live/i.test(method))
}

function supportsArabic(model: GeminiModelDescription): boolean {
  const languageFields = [model.supportedLanguages, model.languageCodes, model.languages]
    .filter((value) => value !== undefined)
  if (languageFields.length === 0) return true
  const serialized = JSON.stringify(languageFields).toLowerCase()
  return /arabic|\bar\b|ar-[a-z]{2}|egyptian/.test(serialized)
}

function releaseScore(model: GeminiModelDescription): number {
  const id = modelId(typeof model.name === 'string' ? model.name : '')
  const candidates: number[] = []
  for (const match of id.matchAll(/(20\d{2})[-_](\d{1,2})(?:[-_](\d{1,2}))?/g)) {
    candidates.push(
      Number(match[1]) * 10_000 + Number(match[2]) * 100 + Number(match[3] ?? 0)
    )
  }
  // Gemini preview ids commonly use `preview-12-2025` (month-year), not year-month.
  for (const match of id.matchAll(/(?:preview|exp|experimental)[-_](\d{1,2})[-_](20\d{2})/gi)) {
    candidates.push(Number(match[2]) * 10_000 + Number(match[1]) * 100)
  }
  const timestamp = [model.updateTime, model.createTime]
    .find((value): value is string => typeof value === 'string')
  if (timestamp) {
    const parsed = Date.parse(timestamp)
    if (Number.isFinite(parsed)) candidates.push(Math.floor(parsed / 86_400_000))
  }
  return Math.max(0, ...candidates)
}

function versionScore(model: GeminiModelDescription): [number, number] {
  const text = modelText(model)
  const match = text.match(/(?:gemini[- ]?)?(\d+)(?:\.(\d+))?/i)
  return [Number(match?.[1] ?? 0), Number(match?.[2] ?? 0)]
}

/**
 * Pick the newest listed native-audio model that can run a bidi session and
 * advertises Arabic when the API includes language metadata. The API has not
 * always exposed language fields, so an otherwise valid Live model is treated
 * as multilingual when those fields are absent.
 */
export function selectNewestNativeAudioModel(
  models: readonly GeminiModelDescription[]
): string | null {
  const candidates = models.filter((model) => {
    const name = typeof model.name === 'string' ? modelId(model.name) : ''
    return /live|native-audio/i.test(name) && supportsBidi(model) && supportsArabic(model)
  })
  candidates.sort((left, right) => {
    const release = releaseScore(right) - releaseScore(left)
    if (release !== 0) return release
    const [rightMajor, rightMinor] = versionScore(right)
    const [leftMajor, leftMinor] = versionScore(left)
    if (rightMajor !== leftMajor) return rightMajor - leftMajor
    if (rightMinor !== leftMinor) return rightMinor - leftMinor
    const rightName = modelId(typeof right.name === 'string' ? right.name : '')
    const leftName = modelId(typeof left.name === 'string' ? left.name : '')
    return rightName.localeCompare(leftName)
  })
  const selected = candidates[0]
  return selected && typeof selected.name === 'string' ? modelId(selected.name) : null
}

interface ModelsResponse {
  models?: GeminiModelDescription[]
  nextPageToken?: string
}

export async function listGeminiModels(
  apiKey: string,
  fetcher: typeof fetch = fetch
): Promise<GeminiModelDescription[]> {
  const key = apiKey.trim()
  if (!key) throw new GeminiLiveError('A Gemini AI Studio key is required to list Live models.')
  const models: GeminiModelDescription[] = []
  let pageToken = ''
  for (let page = 0; page < 10; page += 1) {
    const url = new URL(GEMINI_MODELS_ENDPOINT)
    url.searchParams.set('pageSize', '1000')
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    const response = await fetcher(url, {
      headers: { 'x-goog-api-key': key, Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000)
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new GeminiLiveError(
        `Gemini model list failed (${response.status})${detail ? `: ${detail.slice(0, 240)}` : '.'}`,
        response.status
      )
    }
    const body = (await response.json()) as ModelsResponse
    if (Array.isArray(body.models)) models.push(...body.models)
    pageToken = typeof body.nextPageToken === 'string' ? body.nextPageToken : ''
    if (!pageToken) break
  }
  return models
}

export interface ResolveLiveModelOptions {
  apiKey: string
  override?: string
  storedModel?: string
  fetcher?: typeof fetch
  onSelectedModel?: (model: string) => void | Promise<void>
}

/**
 * Resolve at startup. An explicit override always wins; a stored choice is a
 * safe offline fallback if the model list is temporarily unavailable.
 */
export async function resolveGeminiLiveModel(options: ResolveLiveModelOptions): Promise<string> {
  const override = options.override?.trim()
  if (override) return modelId(override)
  try {
    const selected = selectNewestNativeAudioModel(
      await listGeminiModels(options.apiKey, options.fetcher ?? fetch)
    )
    if (selected) {
      await options.onSelectedModel?.(selected)
      return selected
    }
  } catch {
    // The cached model keeps voice usable during a temporary model-list outage.
  }
  return modelId(options.storedModel ?? '') || DEFAULT_GEMINI_LIVE_MODEL
}

export function buildGeminiLiveUrl(apiKey: string, endpoint = GEMINI_LIVE_ENDPOINT): string {
  const url = new URL(endpoint)
  url.searchParams.set('key', apiKey.trim())
  return url.toString()
}

export interface GeminiLiveSetupOptions {
  model: string
  systemInstruction?: string
  language?: string
  voiceName?: string
  /** Function declarations the voice may call (Live API `tools`). */
  functionDeclarations?: readonly unknown[]
}

export function createGeminiLiveSetup(options: GeminiLiveSetupOptions): Record<string, unknown> {
  const instruction = [
    options.systemInstruction?.trim() || OCTA_VOICE_SYSTEM_INSTRUCTION,
    options.language ? `Current conversation language hint: ${options.language}.` : ''
  ]
    .filter(Boolean)
    .join('\n')
  return {
    setup: {
      model: `models/${modelId(options.model)}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: options.voiceName ?? 'Sulafat' }
          }
        }
      },
      // Transcription belongs to the setup message itself; inside generationConfig Gemini rejects the
      // payload with close code 1007 "Unknown name inputAudioTranscription".
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      systemInstruction: { parts: [{ text: instruction }] },
      ...(options.functionDeclarations?.length
        ? { tools: [{ functionDeclarations: options.functionDeclarations }] }
        : {})
    }
  }
}

export interface LiveFunctionCall {
  id: string
  name: string
  args: Record<string, unknown>
}

/** The function calls inside a Live `toolCall` frame. */
export function liveFunctionCalls(value: unknown): LiveFunctionCall[] {
  const calls = value && typeof value === 'object' ? (value as { functionCalls?: unknown }).functionCalls : undefined
  if (!Array.isArray(calls)) return []
  return calls.flatMap((call) => {
    if (!call || typeof call !== 'object') return []
    const record = call as Record<string, unknown>
    if (typeof record.name !== 'string' || !record.name) return []
    const args = record.args && typeof record.args === 'object' && !Array.isArray(record.args)
      ? record.args as Record<string, unknown>
      : {}
    return [{ id: typeof record.id === 'string' ? record.id : '', name: record.name, args }]
  })
}

export function frameGeminiLiveMessage(message: unknown): string {
  return JSON.stringify(message)
}

export function encodePcm16(pcm: ArrayBuffer | ArrayBufferView): string {
  if (pcm instanceof ArrayBuffer) return Buffer.from(pcm).toString('base64')
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64')
}

export function createRealtimeAudioMessage(
  pcm: ArrayBuffer | ArrayBufferView,
  mimeType = 'audio/pcm;rate=16000'
): Record<string, unknown> {
  return {
    realtimeInput: {
      audio: { data: encodePcm16(pcm), mimeType }
    }
  }
}

export function createRealtimeTextMessage(text: string): Record<string, unknown> {
  return { realtimeInput: { text } }
}

export interface LiveSetupCompleteEvent {
  type: 'setup-complete'
}
export interface LiveAudioEvent {
  type: 'audio'
  data: Buffer
  mimeType: string
}
export interface LiveTranscriptEvent {
  type: 'transcript'
  source: 'user' | 'assistant'
  text: string
  final: boolean
  languageHint?: string
}
export interface LiveTurnCompleteEvent {
  type: 'turn-complete'
}
export interface LiveInterruptedEvent {
  type: 'interrupted'
}
export interface LiveErrorEvent {
  type: 'error'
  message: string
  status?: number
}
export interface LiveToolCallEvent {
  type: 'tool-call'
  value: unknown
}

export type GeminiLiveEvent =
  | LiveSetupCompleteEvent
  | LiveAudioEvent
  | LiveTranscriptEvent
  | LiveTurnCompleteEvent
  | LiveInterruptedEvent
  | LiveErrorEvent
  | LiveToolCallEvent

function rawMessageText(raw: unknown): string | null {
  if (typeof raw === 'string') return raw
  if (Buffer.isBuffer(raw)) return raw.toString('utf8')
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8')
  if (ArrayBuffer.isView(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8')
  return null
}

function audioParts(content: Record<string, unknown>): LiveAudioEvent[] {
  const parts = Array.isArray(content.parts) ? content.parts : []
  const events: LiveAudioEvent[] = []
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue
    const value = part as Record<string, unknown>
    const inline =
      (value.inlineData && typeof value.inlineData === 'object' ? value.inlineData : undefined) ??
      (value.inline_data && typeof value.inline_data === 'object' ? value.inline_data : undefined)
    if (!inline || typeof inline !== 'object') continue
    const encoded = (inline as Record<string, unknown>).data
    if (typeof encoded !== 'string' || !encoded) continue
    const mimeType =
      typeof (inline as Record<string, unknown>).mimeType === 'string'
        ? (inline as Record<string, unknown>).mimeType as string
        : typeof (inline as Record<string, unknown>).mime_type === 'string'
          ? (inline as Record<string, unknown>).mime_type as string
          : 'audio/pcm;rate=24000'
    events.push({ type: 'audio', data: Buffer.from(encoded, 'base64'), mimeType })
  }
  return events
}

function transcription(
  value: unknown,
  source: 'user' | 'assistant',
  final: boolean
): LiveTranscriptEvent | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.text !== 'string' || !record.text) return null
  return {
    type: 'transcript',
    source,
    text: record.text,
    final,
    languageHint: typeof record.languageCode === 'string' ? record.languageCode : undefined
  }
}

/** Parse one recorded/server WebSocket frame without opening a network socket. */
export function parseGeminiLiveMessage(raw: unknown): GeminiLiveEvent[] {
  const text = rawMessageText(raw)
  if (!text) return [{ type: 'error', message: 'Gemini Live returned a non-text frame.' }]
  let message: Record<string, unknown>
  try {
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return [{ type: 'error', message: 'Gemini Live returned an invalid JSON frame.' }]
    }
    message = parsed as Record<string, unknown>
  } catch {
    return [{ type: 'error', message: 'Gemini Live returned malformed JSON.' }]
  }

  const events: GeminiLiveEvent[] = []
  if (message.setupComplete !== undefined) events.push({ type: 'setup-complete' })
  const error = message.error
  if (error && typeof error === 'object') {
    const value = error as Record<string, unknown>
    events.push({
      type: 'error',
      message: typeof value.message === 'string' ? value.message : 'Gemini Live reported an error.',
      status: typeof value.code === 'number' ? value.code : undefined
    })
  }
  if (message.toolCall !== undefined) events.push({ type: 'tool-call', value: message.toolCall })

  const content = message.serverContent
  if (content && typeof content === 'object') {
    const server = content as Record<string, unknown>
    const modelTurn = server.modelTurn
    if (modelTurn && typeof modelTurn === 'object') {
      events.push(...audioParts(modelTurn as Record<string, unknown>))
    }
    const interimInput = transcription(server.interimInputTranscription, 'user', false)
    if (interimInput) events.push(interimInput)
    const input = transcription(server.inputTranscription, 'user', true)
    if (input) events.push(input)
    const interimOutput = transcription(server.interimOutputTranscription, 'assistant', false)
    if (interimOutput) events.push(interimOutput)
    const output = transcription(server.outputTranscription, 'assistant', true)
    if (output) events.push(output)
    if (server.interrupted === true) events.push({ type: 'interrupted' })
    if (server.turnComplete === true || server.generationComplete === true) {
      events.push({ type: 'turn-complete' })
    }
  }
  return events
}

// Short aliases make the parser convenient in fixtures and downstream tests.
export const parseLiveMessage = parseGeminiLiveMessage
export const parseLiveServerMessage = parseGeminiLiveMessage

export interface LiveWebSocket {
  readonly readyState?: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener?: (type: string, listener: (event: unknown) => void) => void
  removeEventListener?: (type: string, listener: (event: unknown) => void) => void
  on?: (type: string, listener: (event: unknown) => void) => void
  off?: (type: string, listener: (event: unknown) => void) => void
  onopen?: (event: unknown) => void
  onmessage?: (event: unknown) => void
  onerror?: (event: unknown) => void
  onclose?: (event: unknown) => void
}

export type LiveWebSocketFactory = (url: string) => LiveWebSocket

function defaultSocketFactory(url: string): LiveWebSocket {
  const constructor = (globalThis as unknown as {
    WebSocket?: new (url: string) => LiveWebSocket
  }).WebSocket
  if (!constructor) throw new GeminiLiveError('This Electron runtime has no WebSocket implementation.')
  const socket = new constructor(url)
  // Gemini sends its JSON frames as binary; without this Node hands us a Blob and the parser sees "non-text".
  try {
    ;(socket as { binaryType?: string }).binaryType = 'arraybuffer'
  } catch {
    // Some socket implementations expose no binaryType; Blob frames are decoded asynchronously below.
  }
  return socket
}

function socketData(event: unknown): unknown {
  if (event && typeof event === 'object' && 'data' in event) {
    return (event as { data: unknown }).data
  }
  return event
}

function attachSocketListener(
  socket: LiveWebSocket,
  type: 'open' | 'message' | 'error' | 'close',
  listener: (event: unknown) => void
): () => void {
  if (socket.addEventListener) {
    socket.addEventListener(type, listener)
    return () => socket.removeEventListener?.(type, listener)
  }
  if (socket.on) {
    socket.on(type, listener)
    return () => socket.off?.(type, listener)
  }
  socket[`on${type}`] = listener
  return () => {
    if (socket[`on${type}`] === listener) socket[`on${type}`] = undefined
  }
}

export interface PcmAudioOutput {
  play(data: Buffer, mimeType: string): void | Promise<void>
  stop?(): void | Promise<void>
  clear?(): void | Promise<void>
}

export interface GeminiLiveSessionOptions extends GeminiLiveSetupOptions {
  apiKey: string
  endpoint?: string
  socketFactory?: LiveWebSocketFactory
  audioOutput?: PcmAudioOutput
  onEvent?: (event: GeminiLiveEvent) => void
  connectTimeoutMs?: number
}

export type GeminiLiveSessionState = 'idle' | 'connecting' | 'ready' | 'closed' | 'error'

/** A small raw-WebSocket Live client; no provider SDK is required in Electron. */
export class GeminiLiveSession {
  private socket: LiveWebSocket | undefined
  private state: GeminiLiveSessionState = 'idle'
  private openPromise: Promise<void> | undefined
  private resolveOpen: (() => void) | undefined
  private rejectOpen: ((error: Error) => void) | undefined
  private setupSent = false
  private readonly detach: Array<() => void> = []
  private readonly socketFactory: LiveWebSocketFactory

  constructor(private readonly options: GeminiLiveSessionOptions) {
    if (!options.apiKey.trim()) throw new GeminiLiveError('Add a Gemini AI Studio key before starting voice.')
    this.socketFactory = options.socketFactory ?? defaultSocketFactory
  }

  get currentState(): GeminiLiveSessionState {
    return this.state
  }

  get ready(): boolean {
    return this.state === 'ready'
  }

  async open(): Promise<void> {
    if (this.state === 'ready') return
    if (this.openPromise) return this.openPromise
    this.state = 'connecting'
    this.openPromise = new Promise<void>((resolve, reject) => {
      this.resolveOpen = resolve
      this.rejectOpen = reject
    })
    const opening = this.openPromise
    try {
      this.socket = this.socketFactory(
        buildGeminiLiveUrl(this.options.apiKey, this.options.endpoint ?? GEMINI_LIVE_ENDPOINT)
      )
      this.detach.push(
        attachSocketListener(this.socket, 'open', () => this.handleOpen()),
        attachSocketListener(this.socket, 'message', (event) => this.receiveFrame(socketData(event))),
        attachSocketListener(this.socket, 'error', (event) => this.handleSocketError(event)),
        attachSocketListener(this.socket, 'close', (event) => this.handleClose(event))
      )
      if (this.socket.readyState === 1) this.handleOpen()
    } catch (error) {
      this.failOpen(error)
    }
    const timeout = setTimeout(() => {
      if (this.state !== 'ready') this.failOpen(new GeminiLiveError('Gemini Live connection timed out.'))
    }, this.options.connectTimeoutMs ?? 15_000)
    timeout.unref?.()
    return opening.finally(() => clearTimeout(timeout))
  }

  /** Alias matching the terminology used by the Live API docs. */
  connect(): Promise<void> {
    return this.open()
  }

  sendPcm(pcm: ArrayBuffer | ArrayBufferView): void {
    this.send(createRealtimeAudioMessage(pcm))
  }

  sendAudio(pcm: ArrayBuffer | ArrayBufferView): void {
    this.sendPcm(pcm)
  }

  sendText(text: string): void {
    const value = text.trim()
    if (!value) return
    this.send(createRealtimeTextMessage(value))
  }

  sendToolResponse(responses: Array<{ id: string; name: string; response: Record<string, unknown> }>): void {
    if (responses.length === 0) return
    this.send({ toolResponse: { functionResponses: responses } })
  }

  sendClientContent(turns: unknown[], turnComplete = true): void {
    this.send({ clientContent: { turns, turnComplete } })
  }

  /** Stop local playback immediately; new user audio will interrupt generation. */
  interrupt(): void {
    void this.options.audioOutput?.clear?.()
    void this.options.audioOutput?.stop?.()
  }

  bargeIn(): void {
    this.interrupt()
  }

  close(): void {
    for (const remove of this.detach.splice(0)) remove()
    const socket = this.socket
    this.socket = undefined
    if (socket) {
      try {
        socket.close(1000, 'Octa voice session closed')
      } catch {
        // best effort
      }
    }
    if (this.state === 'connecting') this.failOpen(new GeminiLiveError('Gemini Live session closed.'))
    this.state = 'closed'
    this.openPromise = undefined
    this.setupSent = false
  }

  dispose(): void {
    this.close()
  }

  private send(message: unknown): void {
    if (!this.socket || this.state !== 'ready') {
      throw new GeminiLiveError('Gemini Live is not ready.')
    }
    this.socket.send(frameGeminiLiveMessage(message))
  }

  private handleOpen(): void {
    if (this.setupSent || !this.socket) return
    this.setupSent = true
    try {
      this.socket.send(frameGeminiLiveMessage(createGeminiLiveSetup(this.options)))
    } catch (error) {
      this.failOpen(error)
    }
  }

  private receiveFrame(raw: unknown): void {
    if (raw && typeof raw === 'object' && typeof (raw as { arrayBuffer?: unknown }).arrayBuffer === 'function') {
      void (raw as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer()
        .then((buffer) => this.handleMessage(buffer))
        .catch((error: unknown) => this.options.onEvent?.({ type: 'error', message: error instanceof Error ? error.message : String(error) }))
      return
    }
    this.handleMessage(raw)
  }

  private handleMessage(raw: unknown): void {
    const events = parseGeminiLiveMessage(raw)
    for (const event of events) {
      if (event.type === 'setup-complete') {
        this.state = 'ready'
        this.resolveOpen?.()
        this.clearOpenPromise()
      }
      if (event.type === 'audio') {
        void this.options.audioOutput?.play(event.data, event.mimeType)
      }
      if (event.type === 'interrupted') {
        void this.options.audioOutput?.clear?.()
        void this.options.audioOutput?.stop?.()
      }
      if (event.type === 'error') {
        if (this.state === 'connecting') this.failOpen(new GeminiLiveError(event.message, event.status))
      }
      this.options.onEvent?.(event)
    }
  }

  private handleSocketError(event: unknown): void {
    const message =
      event && typeof event === 'object' && 'message' in event && typeof (event as { message: unknown }).message === 'string'
        ? (event as { message: string }).message
        : 'Gemini Live WebSocket error.'
    if (this.state === 'connecting') this.failOpen(new GeminiLiveError(message))
    this.options.onEvent?.({ type: 'error', message })
    this.state = 'error'
  }

  private handleClose(event?: unknown): void {
    if (this.state === 'connecting') {
      const closeEvent = event && typeof event === 'object' ? (event as { code?: unknown; reason?: unknown }) : undefined
      const code = typeof closeEvent?.code === 'number' ? closeEvent.code : undefined
      const reason = typeof closeEvent?.reason === 'string' ? closeEvent.reason.trim() : ''
      const detail = [code !== undefined ? `code ${code}` : '', reason].filter(Boolean).join(': ')
      this.failOpen(new GeminiLiveError(`Gemini Live WebSocket closed during setup${detail ? ` (${detail})` : ''}.`, code))
    }
    if (this.state !== 'closed') this.state = 'closed'
  }

  private failOpen(error: unknown): void {
    const failure = error instanceof Error ? error : new GeminiLiveError(String(error))
    this.state = 'error'
    this.rejectOpen?.(failure)
    this.clearOpenPromise()
  }

  private clearOpenPromise(): void {
    this.resolveOpen = undefined
    this.rejectOpen = undefined
    this.openPromise = undefined
  }
}

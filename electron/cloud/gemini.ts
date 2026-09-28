import type { TranscriptionLanguage } from '../types'
import { createTransport, type AiAuth, type GeminiTransport } from './vertex'
import { parseMediaDescription, type MediaDescription } from './media-description'

export const CLEANUP_SYSTEM_PROMPT = `You are a transcription cleanup assistant. You will receive a raw speech-to-text transcript that mixes Arabic (Egyptian dialect) and English. Your job:
- Remove filler words and false starts.
- Fix punctuation and capitalization.
- Structure the text into clear sentences.
- Preserve the speaker's original language choice for each word. If something was said in English, keep it in English; if in Arabic, keep it in Arabic. Do NOT translate.
- Keep every word in the script it was spoken in. Arabic stays in Arabic script, English stays in Latin script. Never transliterate between scripts, in either direction.
- Do not change the meaning or add commentary. Return ONLY the cleaned text.`

// gemini-2.5-flash-lite already returns HTTP 404 "no longer available" — cleanup
// was silently falling back to the un-cleaned transcript. 3.5 Flash-Lite is the
// fastest replacement measured on the streaming endpoint (~0.6 s) and preserves
// code-switched English.
const CLEANUP_MODEL = 'gemini-3.5-flash-lite'
// Gemini 2.5 is scheduled for retirement (2.5 Flash/Pro from 2026-10-16), so STT
// runs on 3.5 Flash. Thinking MUST stay disabled: measured on real Egyptian
// dictation, 3.5 Flash with thinkingBudget:0 is ~2.5 s, while the same model with
// default thinking took 185 s and returned nothing. 3.6 Flash and the *-lite /
// *-latest aliases REJECT thinkingBudget:0 (HTTP 400) and cannot be used here —
// verify a candidate accepts it before ever swapping this constant.
const TRANSCRIBE_MODEL = 'gemini-3.5-flash'
/** Gemini's native audio response surface used when a Live session is down. */
export const GEMINI_TTS_MODEL = 'gemini-3.5-flash'
const TRANSCRIBE_GENERATION_CONFIG = { temperature: 0, thinkingConfig: { thinkingBudget: 0 } }
// Files/recordings can be hours long, so give them a large token ceiling and a
// generous timeout — a whole meeting must not be cut off or aborted mid-flight.
const MEDIA_GENERATION_CONFIG = {
  temperature: 0,
  thinkingConfig: { thinkingBudget: 0 },
  maxOutputTokens: 65_536
}
const CLEANUP_HEADERS_TIMEOUT_MS = 20_000
const TRANSCRIBE_TIMEOUT_MS = 180_000
const MEDIA_TRANSCRIBE_TIMEOUT_MS = 1_800_000
// Requests carry base64 (~1.33x), and the JSON request cap is ~20 MB. Anything
// at or above this goes through the resumable Files API instead of inline data.
const INLINE_MEDIA_LIMIT = 15 * 1024 * 1024
const FILE_ACTIVE_TIMEOUT_MS = 300_000
// The speaker constantly borrows English words mid-Arabic-sentence. Without the
// explicit worked examples below, the model writes them phonetically in Arabic
// letters ("كودكس" for "Codex", "ريسيرش" for "research") — measured on real
// dictation, these examples roughly double the number of English words that
// survive in Latin script. The anti-repetition line guards the degenerate
// "آآآآآآ" loop that greedy decoding can fall into.
const SCRIPT_RULES = `CRITICAL RULE — English words MUST be written in Latin letters, never spelled out in Arabic letters:
Whenever you hear an English word, write it using the English alphabet, spelled as it is in English.
- hears "text" -> writes: text   (NEVER التكست / تكست)
- hears "research" -> writes: research   (NEVER ريسيرش)
- hears "Codex" -> writes: Codex   (NEVER كودكس)
- hears "update" -> writes: update   (NEVER ابديت)
- hears "meeting" -> writes: meeting   (NEVER ميتنج)
An Arabic article before an English word stays Arabic: write "الـ text", "الـ OCR".
Arabic words stay in Arabic script. Never translate in either direction.

OTHER RULES:
- Write a filler sound at most once ("آه"), never a long run of one repeated letter.
- Never repeat the same word or letter more than twice in a row.
- Do not summarize, rephrase, correct grammar, or add commentary, labels, speaker names, or timestamps.`

const MEDIA_TRANSCRIBE_PROMPT = `You are a verbatim transcriber. Transcribe every clearly spoken word in this recording, word for word. Speech may be in Egyptian Arabic and may switch into English for individual words or technical terms.

${SCRIPT_RULES}
- Transcribe the speech even if there is background music or noise.

Output only the raw transcript text.`

// On a file with no speech the model answers the instruction instead of
// transcribing — "حاضر", "أه", "_" — and with the prompt placed before the audio
// it sometimes invents a plausible transcript. Measured on music-only reels
// (2026-09-05): putting the prompt AFTER the audio and forbidding
// acknowledgements is the order that let real speech through where the default
// order returned one token, so the caller retries with it when a result is
// tiny — after describeMedia() has confirmed there is speech at all.
const MEDIA_NO_ACK_RULE = `
Start the transcript immediately with the first spoken words. Never reply to these instructions or acknowledge them (no "حاضر", no "OK"), never summarize — output the transcript only.`
const MEDIA_DESCRIBE_PROMPT = `Describe this audio recording precisely, as JSON with keys: contents (one of: speech, singing, music_only, speech_over_music, mixed), languages (array of language names), speakers (number), background_music (boolean), speech_clarity (one of: clear, muffled, none), notes (one sentence). Do not transcribe lyrics; only describe.`
// Describing runs with a small thinking budget (this value classified two
// music-only reels correctly); the answer is ~100 tokens, so it stays cheap.
const MEDIA_DESCRIBE_CONFIG = {
  temperature: 0,
  thinkingConfig: { thinkingBudget: 2048 },
  maxOutputTokens: 1024
}

const TRANSCRIBE_PROMPT = `You are a verbatim transcriber of a voice note. The speaker uses Egyptian Arabic and switches into English for individual words and technical terms.

${SCRIPT_RULES}

Output only the raw transcript text.`

// Gemini accepts Opus audio in a WebM or Ogg container; strip the codecs
// parameter the recorder appends so the inline mime_type is one it recognizes.
function transcriptionMimeType(mimeType: string): string {
  const base = mimeType.split(';')[0].trim().toLowerCase()
  const supported = [
    'audio/webm',
    'audio/ogg',
    'audio/wav',
    'audio/mpeg',
    'audio/mp3',
    'audio/flac',
    'audio/aac'
  ]
  return supported.includes(base) ? base : 'audio/webm'
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true }
    )
  })
}

export class GeminiApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfter?: string
  ) {
    super(message)
    this.name = 'GeminiApiError'
  }
}

export function isGeminiRateLimitError(error: unknown): error is GeminiApiError {
  return error instanceof GeminiApiError && error.status === 429
}

async function errorFromResponse(response: Response): Promise<GeminiApiError> {
  const retryAfter = response.headers.get('retry-after') ?? undefined
  let detail = ''
  const raw = await response.text().catch(() => '')
  try {
    const payload = JSON.parse(raw) as {
      error?: { message?: string }
      message?: string
    }
    detail = payload.error?.message ?? payload.message ?? ''
  } catch {
    detail = raw
  }
  const message =
    response.status === 429
      ? `Gemini rate limit reached${retryAfter ? `; retry in ${retryAfter}s` : ''}.`
      : `Gemini request failed (${response.status})${detail ? `: ${detail}` : '.'}`
  return new GeminiApiError(message, response.status, retryAfter)
}

function extractSseEvents(buffer: string): { events: string[]; remainder: string } {
  const normalized = buffer.replaceAll('\r\n', '\n')
  const blocks = normalized.split('\n\n')
  const remainder = blocks.pop() ?? ''
  const events = blocks.flatMap((block) =>
    block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
  )
  return { events, remainder }
}

export class GeminiClient {
  private readonly transport: GeminiTransport

  // Accepts a bare API key string (Gemini Developer API, and what every
  // existing call site and test passes) or an AiAuth for Vertex.
  constructor(auth: string | AiAuth, private readonly fetcher: typeof fetch = fetch) {
    if (typeof auth === 'string') {
      if (!auth.trim()) throw new Error('Add your Gemini API key in Settings first.')
      auth = { kind: 'api-key', apiKey: auth }
    }
    this.transport = createTransport(auth, fetcher)
  }

  /** Send the smallest useful request so Settings can verify the selected provider. */
  async testConnection(signal?: AbortSignal): Promise<string> {
    const response = await this.fetcher(this.transport.nativeUrl(TRANSCRIBE_MODEL), {
      method: 'POST',
      headers: {
        ...(await this.transport.nativeHeaders()),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Reply with exactly: ok' }] }],
        generationConfig: { temperature: 0, thinkingConfig: { thinkingBudget: 0 } }
      }),
      signal: signal ?? AbortSignal.timeout(30_000)
    })
    if (!response.ok) throw await errorFromResponse(response)
    const payload = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }>
    }
    const text = (payload.candidates?.[0]?.content?.parts ?? [])
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('')
      .trim()
    if (!text) throw new GeminiApiError('Gemini returned an empty connection response.', 502)
    return text
  }

  async transcribe(
    audio: ArrayBuffer,
    options: {
      mimeType: string
      dictionary: string[]
      language: TranscriptionLanguage
    },
    signal?: AbortSignal
  ): Promise<string> {
    const languageHint =
      options.language === 'ar'
        ? ' The primary language is Arabic.'
        : options.language === 'en'
          ? ' The primary language is English.'
          : ''
    const terms = options.dictionary.filter(Boolean).slice(0, 120).join(', ')
    const promptText =
      `${TRANSCRIBE_PROMPT}${languageHint}` +
      (terms ? `\nKnown terms that may appear — keep their exact spelling: ${terms}.` : '')

    const deadline = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS)])
      : AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS)
    const response = await this.fetcher(
      this.transport.nativeUrl(TRANSCRIBE_MODEL),
      {
        method: 'POST',
        headers: {
          ...(await this.transport.nativeHeaders()),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          contents: [
            {
              // Vertex rejects contents without an explicit role; the Gemini
              // Developer API merely defaults it. Always send one.
              role: 'user',
              parts: [
                { text: promptText },
                {
                  inline_data: {
                    mime_type: transcriptionMimeType(options.mimeType),
                    data: Buffer.from(audio).toString('base64')
                  }
                }
              ]
            }
          ],
          generationConfig: TRANSCRIBE_GENERATION_CONFIG
        }),
        signal: deadline
      }
    )
    if (!response.ok) throw await errorFromResponse(response)
    const payload = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }>
    }
    const text = (payload.candidates?.[0]?.content?.parts ?? [])
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('')
      .trim()
    if (!text) {
      throw new GeminiApiError('Gemini returned an invalid transcription response.', 502)
    }
    return text
  }

  // Transcribe an arbitrary uploaded audio/video file. Small files are sent
  // inline; larger files (and video) go through the resumable Files API. Unlike
  // the live-dictation transcribe(), an empty result is allowed here — a file
  // may legitimately contain no speech. `audioFirst` puts the prompt after the
  // audio with the anti-acknowledgement rule (see MEDIA_NO_ACK_RULE).
  async transcribeMedia(
    bytes: Buffer,
    mimeType: string,
    signal?: AbortSignal,
    options: { audioFirst?: boolean } = {}
  ): Promise<string> {
    const mediaPart =
      bytes.length < INLINE_MEDIA_LIMIT
        ? { inline_data: { mime_type: mimeType, data: bytes.toString('base64') } }
        : { file_data: await this.uploadForTranscription(bytes, mimeType, signal) }
    const parts = options.audioFirst
      ? [mediaPart, { text: `${MEDIA_TRANSCRIBE_PROMPT}${MEDIA_NO_ACK_RULE}` }]
      : [{ text: MEDIA_TRANSCRIBE_PROMPT }, mediaPart]

    const deadline = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(MEDIA_TRANSCRIBE_TIMEOUT_MS)])
      : AbortSignal.timeout(MEDIA_TRANSCRIBE_TIMEOUT_MS)
    const response = await this.fetcher(
      this.transport.nativeUrl(TRANSCRIBE_MODEL),
      {
        method: 'POST',
        headers: {
          ...(await this.transport.nativeHeaders()),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: MEDIA_GENERATION_CONFIG
        }),
        signal: deadline
      }
    )
    if (!response.ok) throw await errorFromResponse(response)
    const payload = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }>
    }
    return (payload.candidates?.[0]?.content?.parts ?? [])
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('')
      .trim()
  }

  // What a recording contains. Used when a transcript comes back empty or tiny
  // to tell "there is no speech in this file" apart from a model bail-out —
  // the two look identical from the transcript alone. Inline-sized files only;
  // null means "could not tell".
  async describeMedia(
    bytes: Buffer,
    mimeType: string,
    signal?: AbortSignal
  ): Promise<MediaDescription | null> {
    if (bytes.length >= INLINE_MEDIA_LIMIT) return null
    const deadline = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS)])
      : AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS)
    const response = await this.fetcher(this.transport.nativeUrl(TRANSCRIBE_MODEL), {
      method: 'POST',
      headers: {
        ...(await this.transport.nativeHeaders()),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { inline_data: { mime_type: mimeType, data: bytes.toString('base64') } },
              { text: MEDIA_DESCRIBE_PROMPT }
            ]
          }
        ],
        generationConfig: MEDIA_DESCRIBE_CONFIG
      }),
      signal: deadline
    })
    if (!response.ok) throw await errorFromResponse(response)
    const payload = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }>
    }
    return parseMediaDescription(
      (payload.candidates?.[0]?.content?.parts ?? [])
        .map((part) => (typeof part.text === 'string' ? part.text : ''))
        .join('')
    )
  }

  private async uploadForTranscription(
    bytes: Buffer,
    mimeType: string,
    signal?: AbortSignal
  ): Promise<{ mime_type: string; file_uri: string }> {
    const uploadUrl0 = this.transport.uploadUrl()
    if (!uploadUrl0) {
      // Vertex has no Files API — its file_data only takes gs:// URIs. Files
      // this large are rare (the media pipeline compresses and chunks first),
      // so refuse loudly instead of failing with an opaque 400. Status 413
      // deliberately does not read as a capacity error to the fallback logic.
      throw new GeminiApiError(
        'This file is too large for Vertex (over 15 MB after compression). Switch AI provider to Gemini API key for this file.',
        413
      )
    }
    const start = await this.fetcher(uploadUrl0, {
      method: 'POST',
      headers: {
        ...(await this.transport.nativeHeaders()),
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(bytes.length),
        'X-Goog-Upload-Header-Content-Type': mimeType,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ file: { display_name: 'octa-media' } }),
      signal
    })
    if (!start.ok) throw await errorFromResponse(start)
    const uploadUrl = start.headers.get('x-goog-upload-url')
    if (!uploadUrl) throw new GeminiApiError('Gemini did not return an upload URL.', 502)

    const upload = await this.fetcher(uploadUrl, {
      method: 'POST',
      headers: {
        'Content-Length': String(bytes.length),
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize'
      },
      body: new Uint8Array(bytes),
      signal
    })
    if (!upload.ok) throw await errorFromResponse(upload)
    const info = (await upload.json()) as {
      file?: { uri?: string; name?: string; state?: string }
    }
    const file = info.file
    if (!file?.uri || !file.name) {
      throw new GeminiApiError('Gemini upload returned no file handle.', 502)
    }
    await this.waitUntilActive(file.name, file.state, signal)
    return { mime_type: mimeType, file_uri: file.uri }
  }

  private async waitUntilActive(
    name: string,
    initialState: string | undefined,
    signal?: AbortSignal
  ): Promise<void> {
    let state = initialState ?? 'PROCESSING'
    const deadline = Date.now() + FILE_ACTIVE_TIMEOUT_MS
    while (state !== 'ACTIVE') {
      if (state === 'FAILED') throw new GeminiApiError('Gemini could not process the file.', 502)
      if (Date.now() > deadline) throw new GeminiApiError('Gemini file processing timed out.', 504)
      await delay(1_500, signal)
      // fileUrl is only null on Vertex, and Vertex never reaches here — the
      // upload path that produces file names refuses to run there.
      const res = await this.fetcher(this.transport.fileUrl(name) ?? '', {
        headers: await this.transport.nativeHeaders(),
        signal
      })
      if (!res.ok) throw await errorFromResponse(res)
      const body = (await res.json()) as { state?: string }
      state = body.state ?? state
    }
  }

  async cleanup(
    raw: string,
    onText: (text: string) => void,
    signal?: AbortSignal
  ): Promise<string> {
    const controller = new AbortController()
    const forwardAbort = (): void => controller.abort(signal?.reason)
    if (signal?.aborted) forwardAbort()
    signal?.addEventListener('abort', forwardAbort)
    let headersTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => controller.abort(new GeminiApiError('Gemini cleanup timed out.', 408)),
      CLEANUP_HEADERS_TIMEOUT_MS
    )
    const clearHeadersTimer = (): void => {
      if (headersTimer === undefined) return
      clearTimeout(headersTimer)
      headersTimer = undefined
    }

    try {
      const response = await this.fetcher(this.transport.openaiChatUrl(), {
        method: 'POST',
        headers: {
          ...(await this.transport.openaiHeaders()),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this.transport.openaiModel(CLEANUP_MODEL),
          messages: [
            { role: 'system', content: CLEANUP_SYSTEM_PROMPT },
            { role: 'user', content: raw }
          ],
          temperature: 0.1,
          max_tokens: Math.min(8192, Math.max(96, raw.length * 2)),
          stream: true
        }),
        signal: controller.signal
      })
      clearHeadersTimer()
      if (!response.ok) throw await errorFromResponse(response)
      if (!response.body) {
        throw new GeminiApiError('Gemini returned an empty cleanup stream.', 502)
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let cleaned = ''

      const consume = (event: string): void => {
        if (!event || event === '[DONE]') return
        const payload = JSON.parse(event) as {
          choices?: Array<{ delta?: { content?: unknown } }>
        }
        const content = payload.choices?.[0]?.delta?.content
        if (typeof content === 'string' && content) {
          cleaned += content
          onText(cleaned)
        }
      }

      while (true) {
        const { value, done } = await reader.read()
        buffer += decoder.decode(value, { stream: !done })
        const parsed = extractSseEvents(buffer)
        buffer = parsed.remainder
        for (const event of parsed.events) consume(event)
        if (done) break
      }
      if (buffer.trim()) {
        for (const line of buffer.split(/\r?\n/)) {
          if (line.startsWith('data:')) consume(line.slice(5).trim())
        }
      }
      if (!cleaned.trim()) throw new GeminiApiError('Gemini returned an empty cleanup result.', 502)
      return cleaned.trim()
    } finally {
      clearHeadersTimer()
      signal?.removeEventListener('abort', forwardAbort)
    }
  }

  /**
   * Synthesize exact read-back text through Gemini's audio response modality.
   * Live is the preferred conversational transport; this method is deliberately
   * unary so it remains useful while a Live socket is reconnecting.
   */
  async synthesizeSpeech(
    text: string,
    options: { model?: string; voiceName?: string } = {},
    signal?: AbortSignal
  ): Promise<{ audio: ArrayBuffer; mimeType: string }> {
    const value = text.trim()
    if (!value) throw new Error('TTS text cannot be empty.')
    const response = await this.fetcher(this.transport.nativeUrl(options.model ?? GEMINI_TTS_MODEL), {
      method: 'POST',
      headers: {
        ...(await this.transport.nativeHeaders()),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: value }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: options.voiceName ?? 'Sulafat' }
            }
          },
          temperature: 0,
          thinkingConfig: { thinkingBudget: 0 }
        }
      }),
      signal: signal ?? AbortSignal.timeout(30_000)
    })
    if (!response.ok) throw await errorFromResponse(response)
    const payload = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{
        inlineData?: { data?: unknown; mimeType?: unknown }
        inline_data?: { data?: unknown; mime_type?: unknown }
      }> } }>
    }
    const audioPart = payload.candidates?.[0]?.content?.parts?.find((part) => {
      return typeof part.inlineData?.data === 'string' || typeof part.inline_data?.data === 'string'
    })
    const data = audioPart?.inlineData?.data ?? audioPart?.inline_data?.data
    if (typeof data !== 'string' || !data) {
      throw new GeminiApiError('Gemini returned no audio for the TTS request.', 502)
    }
    const mimeType =
      (typeof audioPart?.inlineData?.mimeType === 'string' && audioPart.inlineData.mimeType) ||
      (typeof audioPart?.inline_data?.mime_type === 'string' && audioPart.inline_data.mime_type) ||
      'audio/pcm;rate=24000'
    const audio = Buffer.from(data, 'base64')
    return {
      audio: audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength),
      mimeType
    }
  }
}

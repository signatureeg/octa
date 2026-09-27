// Generate wake-word training speech with Gemini TTS: positives ("يا أوكتا" / "أوكتا") and near-miss negatives.
// Output: 16 kHz mono s16le WAV files under tts/pos/<voice>-<style>.wav and tts/neg/<voice>-<n>.wav
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'

const ROOT = process.env.WAKEWORD_DIR || new URL('../../.octa/wakeword/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const db = new Database('C:/Octa/octa.db', { readonly: true })
const KEY = JSON.parse(db.prepare('select value from app_settings where key=?').get('geminiApiKey').value)
const MODEL = process.env.TTS_MODEL || 'gemini-3.8-flash-tts'

const VOICES = ['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar', 'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat']

const POS_STYLES = [
  ['normal', 'بلهجة مصرية طبيعية، زي ما حد بينادي على مساعد صوتي في البيت'],
  ['casual', 'بلهجة مصرية، بسرعة وبكسل، كأنك مشغول ومش باصص'],
  ['loud', 'بلهجة مصرية، بصوت عالي شوية كأنك بتنادي من أوضة تانية'],
  ['soft', 'بلهجة مصرية، بصوت واطي وهادي كأنك بالليل']
]
const POS_TEXT = 'يا أوكتا ... أوكتا ... يا أوكتا! ... يا أوكتا؟ ... أوكتا ... يا أوكتا ... أوكتا! ... يا أوكتا'

const NEG_TEXTS = [
  'يا دكتور ... أكتوبر ... أوكي ... يا أستاذ ... أوكا ... يا أختي ... أكتر ... يا أوسطى ... أوتوبيس ... يا أحمد',
  'okay ... October ... octopus ... doctor ... hey Google ... yoga ... vodka ... Alexa ... hey Siri ... actor',
  'بص يا باشا، إحنا محتاجين نخلص الشغل ده النهارده، وابعتلي الملف على الواتساب قبل المغرب.',
  'طب يا عم، أنا عايز أشوف التقرير بتاع الشهر ده، وقولي الأرقام نزلت ولا طلعت.',
  'Can you send me the file before the meeting? I need to review the numbers and the design first.',
  'يا جماعة، الإعلان ده محتاج يتعدل، الألوان مش مظبوطة والكلام طويل أوي.',
  'اوكسجين ... أكتاف ... يا ختي ... أوكرانيا ... يا أكرم ... إكتب ... أوكازيون ... يا عمو ... أكتوبر ... أوبرا',
  'Let us schedule a call tomorrow at ten, and please remind me about the client proposal.'
]

async function tts(voice, style, text) {
  const body = {
    contents: [{ role: 'user', parts: [{ text: `${style}. اقرأ النص ده بالظبط وسيب ثانية سكوت مكان كل "...":\n${text}` }] }],
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } }
  }
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST', headers: { 'x-goog-api-key': KEY, 'content-type': 'application/json' }, body: JSON.stringify(body)
    })
    if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 4000 * (attempt + 1))); continue }
    const json = await res.json()
    const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)
    if (!part) throw new Error(`no audio for ${voice}: ${JSON.stringify(json).slice(0, 200)}`)
    const rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType)?.[1] ?? 24000)
    return { pcm: Buffer.from(part.inlineData.data, 'base64'), rate, wav: /wav/i.test(part.inlineData.mimeType) }
  }
  throw new Error(`rate limited for ${voice}`)
}

function toWav16k(pcm, rate, target, wav) {
  const raw = target + (wav ? '.src.wav' : '.raw')
  writeFileSync(raw, pcm)
  const input = wav ? ['-i', raw] : ['-f', 's16le', '-ar', String(rate), '-ac', '1', '-i', raw]
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...input, '-ar', '16000', '-ac', '1', '-sample_fmt', 's16', target])
  execFileSync('cmd', ['/c', 'del', '/q', raw.replace(/\//g, '\\')])
}

const jobs = []
for (const voice of VOICES) {
  for (const [name, style] of POS_STYLES) jobs.push({ kind: 'pos', voice, file: `${voice}-${name}.wav`, style, text: POS_TEXT })
  NEG_TEXTS.forEach((text, i) => { if ((i + VOICES.indexOf(voice)) % 2 === 0) jobs.push({ kind: 'neg', voice, file: `${voice}-${i}.wav`, style: 'بلهجة مصرية طبيعية', text }) })
}
for (const kind of ['pos', 'neg']) mkdirSync(join(ROOT, 'tts', kind), { recursive: true })
let done = 0, failed = 0
const queue = jobs.filter((j) => !existsSync(join(ROOT, 'tts', j.kind, j.file)))
console.log(`jobs: ${jobs.length}, todo: ${queue.length}`)
async function worker() {
  for (;;) {
    const job = queue.shift()
    if (!job) return
    try {
      const { pcm, rate, wav } = await tts(job.voice, job.style, job.text)
      toWav16k(pcm, rate, join(ROOT, 'tts', job.kind, job.file), wav)
      done++
    } catch (error) {
      failed++
      console.log('FAIL', job.file, String(error.message).slice(0, 160))
    }
    if ((done + failed) % 20 === 0) console.log(`progress ${done + failed}/${jobs.length} (failed ${failed})`)
  }
}
await Promise.all(Array.from({ length: Number(process.env.CONCURRENCY || 4) }, worker))
console.log(`finished: ${done} ok, ${failed} failed`)

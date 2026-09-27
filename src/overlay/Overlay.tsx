import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { LoaderCircle, Mic, Volume2, X } from 'lucide-react'
import type { VoiceState } from '../../electron/types'
import type { Locale, TranslationKey } from '../i18n'
import { applyLocale, t } from '../i18n'

/** Compact voice indicator adapted from Tamim OS's always-on overlay. */
export function Overlay(): React.JSX.Element {
  const [state, setState] = useState<VoiceState>({
    phase: 'idle',
    source: null,
    transcript: '',
    language: null,
    model: null
  })
  const locale: Locale = 'ar'

  useEffect(() => {
    applyLocale(locale)
    void window.octa.voice.state().then(setState).catch(() => undefined)
    return window.octa.voice.onState(setState)
  }, [])

  const labels: Record<VoiceState['phase'], TranslationKey> = {
    idle: 'voiceIdle',
    listening: 'voiceListening',
    thinking: 'voiceThinking',
    speaking: 'voiceSpeaking',
    error: 'voiceError'
  }
  const visible = state.phase !== 'idle'
  const Icon = state.phase === 'speaking' ? Volume2 : state.phase === 'thinking' ? LoaderCircle : Mic

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          className={`voice-overlay ${state.phase}`}
          initial={{ opacity: 0, y: 12, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8, scale: 0.98 }}
        >
          <span className="voice-overlay-icon"><Icon className={state.phase === 'thinking' ? 'spin' : ''} size={15} /></span>
          <div className="voice-overlay-copy">
            <strong>{t(labels[state.phase], locale)}</strong>
            <span dir="auto">{state.transcript || state.error || t('voiceReady', locale)}</span>
          </div>
          <button
            aria-label={t('voiceStop', locale)}
            className="voice-overlay-close"
            // X closes the pop-up: end the voice session and silence any reply. The wake word keeps listening.
            onClick={() => void window.octa.voice.stop()}
            title={t('voiceStop', locale)}
            type="button"
          >
            <X size={14} />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

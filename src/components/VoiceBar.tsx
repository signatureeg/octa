import { useEffect, useState } from 'react'
import { Octagon } from 'lucide-react'
import { OctaFace } from './OctaFace'
import type { VoicePhase, VoiceState } from '../../electron/types'
import type { Locale, TranslationKey } from '../i18n'
import { t } from '../i18n'

export type VoiceBarPhase = 'idle' | 'listening' | 'thinking' | 'speaking'

const phaseKeys: Record<VoicePhase, TranslationKey> = {
  idle: 'voiceIdle',
  listening: 'voiceListening',
  thinking: 'voiceThinking',
  speaking: 'voiceSpeaking',
  error: 'voiceError'
}

export function VoiceBar({ locale }: { locale: Locale }): React.JSX.Element {
  const [state, setState] = useState<VoiceState>({
    phase: 'idle',
    source: null,
    transcript: '',
    language: null,
    model: null
  })
  const [message, setMessage] = useState('')

  useEffect(() => {
    void window.octa.voice.state().then(setState).catch(() => undefined)
    const removeState = window.octa.voice.onState(setState)
    const removeMessage = window.octa.voice.onMessage((next) => setMessage(next))
    return () => {
      removeState()
      removeMessage()
    }
  }, [])

  const label = (key: TranslationKey): string => t(key, locale)
  const active = state.phase !== 'idle'
  const actionLabel = state.phase === 'speaking' ? label('voiceInterrupt') : active ? label('voiceStop') : label('voiceStart')

  return (
    <section className={`voice-bar ${active ? 'active' : ''} ${state.phase}`} aria-label={label('voice')}>
      <div className="voice-bar-face" aria-hidden="true">
        <OctaFace phase={state.phase} size={52} />
      </div>
      <div className="voice-bar-copy">
        <strong>{label(phaseKeys[state.phase])}</strong>
        <span dir="auto">{state.transcript || (state.error ?? (message || label('voiceReady')))}</span>
      </div>
      <div className="voice-bar-actions">
        {state.phase !== 'idle' && state.phase !== 'error' && (
          <button className="voice-interrupt" onClick={() => void window.octa.voice.interrupt()} type="button">
            <Octagon size={13} /> {label('voiceInterrupt')}
          </button>
        )}
        <button
          aria-label={actionLabel}
          className="voice-action"
          onClick={() => void (state.phase === 'speaking' ? window.octa.voice.interrupt() : window.octa.voice.toggle().then(setState))}
          type="button"
        >
          {state.phase === 'speaking' ? label('voiceInterrupt') : active ? label('voiceStop') : label('voiceStart')}
        </button>
      </div>
    </section>
  )
}

import { useEffect, useRef, useState } from 'react'
import type { VoiceState } from '../../electron/types'
import { currentVoiceLevel } from '../audio/voice-player'

type Phase = VoiceState['phase']

/**
 * Octa's face: an animated octopus that is present in the conversation.
 * - idle: slow breathing, occasional blink, eyes drift
 * - listening: eyes open wide and lean toward you, ears (tentacles) lift
 * - thinking: eyes look up, three dots pulse
 * - speaking: the mouth follows the live loudness of her voice
 * - error: eyes soften, small frown
 * Pure SVG + requestAnimationFrame; respects prefers-reduced-motion.
 */
export function OctaFace({ phase, size = 160, label, simulate = false }: { phase: Phase; size?: number; label?: string; simulate?: boolean }): React.JSX.Element {
  const [mouth, setMouth] = useState(0)
  const [blink, setBlink] = useState(false)
  const [look, setLook] = useState({ x: 0, y: 0 })
  const [t, setT] = useState(0)
  const frame = useRef<number>(0)
  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

  // Mouth follows her voice while speaking; a smoothed level keeps it natural.
  useEffect(() => {
    let smooth = 0
    const start = performance.now()
    const tick = (): void => {
      const now = performance.now()
      if (!reduced) setT((now - start) / 1000)
      // `simulate`: windows that do not play the audio themselves (the overlay) get a natural talk rhythm.
      const talk = simulate ? 0.35 + 0.3 * Math.sin(now / 90) * Math.sin(now / 237) : currentVoiceLevel()
      const target = phase === 'speaking' ? Math.max(0, talk) : 0
      smooth += (target - smooth) * (target > smooth ? 0.55 : 0.2)
      setMouth(smooth < 0.02 ? 0 : smooth)
      frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame.current)
  }, [phase, reduced, simulate])

  // Natural blinking (skipped while thinking with eyes up).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const schedule = (): void => {
      timer = setTimeout(() => {
        setBlink(true)
        setTimeout(() => setBlink(false), 130)
        schedule()
      }, 2200 + Math.random() * 3200)
    }
    schedule()
    return () => clearTimeout(timer)
  }, [])

  // Eyes drift when idle; fixed gaze for the other states.
  useEffect(() => {
    if (phase === 'thinking') { setLook({ x: 2, y: -5 }); return }
    if (phase === 'listening') { setLook({ x: 0, y: 1 }); return }
    if (phase === 'speaking') { setLook({ x: 0, y: 0 }); return }
    const timer = setInterval(() => setLook({ x: (Math.random() - 0.5) * 6, y: (Math.random() - 0.5) * 3 }), 2600)
    return () => clearInterval(timer)
  }, [phase])

  const breathe = reduced ? 0 : Math.sin(t * (phase === 'idle' ? 1.4 : 2.2)) * (phase === 'idle' ? 1.6 : 1)
  const eyeOpen = blink && phase !== 'thinking' ? 0.12 : phase === 'listening' ? 1.18 : phase === 'error' ? 0.7 : 1
  const mouthOpen = phase === 'speaking' ? 2 + mouth * 16 : 0
  const smile = phase === 'error' ? -4 : phase === 'listening' ? 6 : 4
  const lift = phase === 'listening' ? -5 : 0
  const tentacles = [0, 1, 2, 3, 4, 5].map((index) => {
    const x = 42 + index * 15.2
    const sway = reduced ? 0 : Math.sin(t * 1.8 + index * 0.9) * (phase === 'speaking' ? 4 + mouth * 6 : 3)
    const tipY = 150 + (index % 2) * 6 + lift * (index === 0 || index === 5 ? 1 : 0.3)
    return `M ${x} 112 C ${x - 6 + sway} 128, ${x + 8 + sway} 138, ${x + sway * 1.4} ${tipY}`
  })

  return (
    <div className={`octa-face octa-face-${phase}`} style={{ width: size, height: size }} role="img" aria-label={label ?? 'Octa'}>
      <svg viewBox="0 0 160 170" width={size} height={size} aria-hidden="true">
        <defs>
          <radialGradient id="octa-face-skin" cx="42%" cy="30%" r="75%">
            <stop offset="0%" stopColor="#e2d4fb" />
            <stop offset="55%" stopColor="#b59ae8" />
            <stop offset="100%" stopColor="#7a58b3" />
          </radialGradient>
          <radialGradient id="octa-face-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#c8b2f2" stopOpacity="0.45" />
            <stop offset="100%" stopColor="#c8b2f2" stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle className="octa-face-aura" cx="80" cy="82" r={70 + (phase === 'speaking' ? mouth * 8 : phase === 'listening' ? 4 : 0)} fill="url(#octa-face-glow)" />
        <g transform={`translate(0 ${breathe})`}>
          <g fill="none" stroke="#9a7ad6" strokeLinecap="round" strokeWidth="9">
            {tentacles.map((path, index) => <path d={path} key={index} />)}
          </g>
          <path d="M 80 20 C 124 20, 140 52, 138 84 C 136 112, 116 122, 80 122 C 44 122, 24 112, 22 84 C 20 52, 36 20, 80 20 Z" fill="url(#octa-face-skin)" />
          <ellipse cx="60" cy="42" rx="16" ry="8" fill="#ffffff" opacity="0.28" />
          {/* eyes */}
          {[58, 102].map((cx) => (
            <g key={cx} transform={`translate(${cx} 74) scale(1 ${eyeOpen})`}>
              <ellipse cx="0" cy="0" rx="13" ry="14" fill="#fbf9fe" />
              <circle cx={look.x} cy={look.y} r="7.5" fill="#21152f" />
              <circle cx={look.x + 2.5} cy={look.y - 3} r="2.4" fill="#ffffff" />
            </g>
          ))}
          {/* cheeks */}
          <ellipse cx="40" cy="92" rx="8" ry="4.5" fill="#f08bb4" opacity={phase === 'listening' || phase === 'speaking' ? 0.45 : 0.25} />
          <ellipse cx="120" cy="92" rx="8" ry="4.5" fill="#f08bb4" opacity={phase === 'listening' || phase === 'speaking' ? 0.45 : 0.25} />
          {/* mouth */}
          {mouthOpen > 0
            ? <ellipse cx="80" cy={100 + mouthOpen / 4} rx={9 + mouth * 3} ry={mouthOpen / 2} fill="#3a1f55" />
            : <path d={`M 69 98 Q 80 ${98 + smile} 91 98`} fill="none" stroke="#3a1f55" strokeLinecap="round" strokeWidth="3.2" />}
          {phase === 'thinking' && [0, 1, 2].map((index) => (
            <circle key={index} cx={122 + index * 9} cy={30 - index * 7} r={3 + index} fill="#c8b2f2" opacity={0.4 + 0.6 * Math.abs(Math.sin(t * 3 + index))} />
          ))}
        </g>
      </svg>
    </div>
  )
}

const EMPTY_VOICE: VoiceState = { phase: 'idle', source: null, transcript: '', language: null, model: null }

/** Live voice state from the main process (shared by the face and the voice bar). */
export function useVoiceState(): VoiceState {
  const [state, setState] = useState<VoiceState>(EMPTY_VOICE)
  useEffect(() => {
    void window.octa.voice.state().then(setState).catch(() => undefined)
    return window.octa.voice.onState(setState)
  }, [])
  return state
}

import { useCallback, useEffect, useState } from 'react'
import { GraduationCap, Plus, Puzzle, Trash2, UserRound, X } from 'lucide-react'
import type { LearningEntry, LearningLog } from '../../electron/core/octa/learning'
import type { LearningState } from '../../electron/preload'
import type { Locale, TranslationKey } from '../i18n'
import { t } from '../i18n'

/**
 * "What Octa learns" on the Brain page: what Octa remembers about the owner, the lessons agents
 * read before working, and the capability gaps the weekly retro turns into proposals.
 */

const MEMORY_KINDS = ['preference', 'decision', 'fact'] as const
const KIND_KEYS: Record<(typeof MEMORY_KINDS)[number], TranslationKey> = {
  preference: 'learnKindPreference',
  decision: 'learnKindDecision',
  fact: 'learnKindFact'
}

function errorText(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught)
}

const TAG_KEYS: Record<string, TranslationKey> = { ...KIND_KEYS, 'all agents': 'learnTagAllAgents', voice: 'learnTagVoice' }

/** Memory kinds and the fixed backend tags read in the UI language; agent names stay as they are. */
function tagLabel(tag: string, locale: Locale): string {
  const key = TAG_KEYS[tag.trim().toLowerCase()]
  return key ? t(key, locale) : tag
}

function EntryList({
  log,
  entries,
  locale,
  busy,
  onRemove
}: {
  log: LearningLog
  entries: LearningEntry[]
  locale: Locale
  busy: boolean
  onRemove: (log: LearningLog, id: string) => Promise<void>
}): React.JSX.Element {
  const label = (key: TranslationKey): string => t(key, locale)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  if (entries.length === 0) return <p className="learn-empty">{label('learnEmpty')}</p>
  return (
    <ul className="learn-list">
      {entries.map((entry) => (
        <li key={entry.id}>
          <div className="learn-entry-copy">
            <span className="learn-entry-meta">
              <span className="learn-tag" dir="auto">{tagLabel(entry.tag, locale)}</span>
              <time dir="ltr">{entry.date}</time>
            </span>
            <p dir="auto">{entry.text}</p>
          </div>
          {confirmId === entry.id ? (
            <span className="learn-confirm">
              <button className="danger-solid-button" disabled={busy} onClick={() => void onRemove(log, entry.id).then(() => setConfirmId(null))} type="button">
                <Trash2 size={13} aria-hidden="true" /> {label('learnDeleteYes')}
              </button>
              <button aria-label={label('learnCancel')} className="quiet-button" disabled={busy} onClick={() => setConfirmId(null)} title={label('learnCancel')} type="button">
                <X size={13} aria-hidden="true" />
              </button>
            </span>
          ) : (
            <button aria-label={label('learnDelete')} className="text-button danger" disabled={busy} onClick={() => setConfirmId(entry.id)} title={label('learnDelete')} type="button">
              <Trash2 size={14} aria-hidden="true" />
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}

export function LearningPanel({ locale }: { locale: Locale }): React.JSX.Element {
  const label = (key: TranslationKey): string => t(key, locale)
  const [state, setState] = useState<LearningState | null>(null)
  const [kind, setKind] = useState<(typeof MEMORY_KINDS)[number]>('preference')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async (): Promise<void> => {
    try {
      setState(await window.octa.learning.list())
    } catch (caught) {
      setError(errorText(caught))
    }
  }, [])

  useEffect(() => {
    void load()
    return window.octa.learning.onChanged((next) => setState(next))
  }, [load])

  const act = async (action: () => Promise<LearningState>): Promise<boolean> => {
    setBusy(true)
    setError('')
    try {
      setState(await action())
      return true
    } catch (caught) {
      setError(errorText(caught))
      return false
    } finally {
      setBusy(false)
    }
  }

  const remove = async (log: LearningLog, id: string): Promise<void> => {
    await act(() => window.octa.learning.remove(log, id))
  }

  const add = async (): Promise<void> => {
    if (!text.trim()) return
    if (await act(() => window.octa.learning.add('memory', kind, text.trim()))) setText('')
  }

  return (
    <section className="learn-panel" aria-labelledby="learn-title">
      <header className="learn-heading">
        <GraduationCap size={20} aria-hidden="true" />
        <div>
          <h2 id="learn-title">{label('learnTitle')}</h2>
          <p>{label('learnIntro')}</p>
        </div>
      </header>
      {error && <p className="octa-inline-error" role="alert" dir="auto">{error}</p>}

      <div className="learn-grid">
        <section className="learn-card learn-memory">
          <header>
            <UserRound size={17} aria-hidden="true" />
            <div>
              <h3>{label('learnMemoryTitle')} <span className="count-chip">{state?.memory.length ?? 0}</span></h3>
              <p>{label('learnMemoryHint')}</p>
            </div>
          </header>
          <div className="learn-add">
            <select aria-label={label('learnKind')} onChange={(event) => setKind(event.target.value as (typeof MEMORY_KINDS)[number])} value={kind}>
              {MEMORY_KINDS.map((value) => <option key={value} value={value}>{label(KIND_KEYS[value])}</option>)}
            </select>
            <input
              aria-label={label('learnMemoryPlaceholder')}
              dir="auto"
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') void add() }}
              placeholder={label('learnMemoryPlaceholder')}
              value={text}
            />
            <button className="accent-button" disabled={busy || !text.trim()} onClick={() => void add()} type="button">
              <Plus size={14} aria-hidden="true" /> {label('learnRemember')}
            </button>
          </div>
          <EntryList busy={busy} entries={state?.memory ?? []} locale={locale} log="memory" onRemove={remove} />
        </section>

        <section className="learn-card">
          <header>
            <GraduationCap size={17} aria-hidden="true" />
            <div>
              <h3>{label('learnLessonsTitle')} <span className="count-chip">{state?.lessons.length ?? 0}</span></h3>
              <p>{label('learnLessonsHint')}</p>
            </div>
          </header>
          <EntryList busy={busy} entries={state?.lessons ?? []} locale={locale} log="lessons" onRemove={remove} />
        </section>

        <section className="learn-card">
          <header>
            <Puzzle size={17} aria-hidden="true" />
            <div>
              <h3>{label('learnGapsTitle')} <span className="count-chip">{state?.gaps.length ?? 0}</span></h3>
              <p>{label('learnGapsHint')}</p>
            </div>
          </header>
          <EntryList busy={busy} entries={state?.gaps ?? []} locale={locale} log="gaps" onRemove={remove} />
        </section>
      </div>
    </section>
  )
}

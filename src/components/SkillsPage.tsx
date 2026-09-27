import { useEffect, useState } from 'react'
import { BookOpen, Filter, Library, Play, RefreshCw, Search, X } from 'lucide-react'
import type { Skill, SkillVerdict } from '../../electron/core/skills/registry'
import type { Locale, TranslationKey } from '../i18n'
import { t } from '../i18n'
import { departmentLabel } from './map'

function interpolate(value: string, values: Record<string, string | number>): string {
  return value.replace(/\{(\w+)\}/g, (_match, key: string) => String(values[key] ?? ''))
}

function verdictKey(verdict: SkillVerdict): TranslationKey {
  if (verdict === 'core') return 'skillVerdictCore'
  if (verdict === 'client') return 'skillVerdictClient'
  if (verdict === 'reference') return 'skillVerdictReference'
  return 'skillVerdictKeep'
}

function autonomyKey(autonomy: Skill['autonomy']): TranslationKey {
  if (autonomy === 'auto') return 'skillAutonomyAuto'
  if (autonomy === 'led') return 'skillAutonomyLed'
  return 'skillAutonomyAssisted'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function SkillsPage({ locale }: { locale: Locale }): React.JSX.Element {
  const [skills, setSkills] = useState<Skill[]>([])
  const [departments, setDepartments] = useState<string[]>([])
  const [department, setDepartment] = useState('')
  const [query, setQuery] = useState('')
  const [includeReference, setIncludeReference] = useState(false)
  const [activeSkill, setActiveSkill] = useState<Skill | null>(null)
  const [inputDraft, setInputDraft] = useState('{}')
  const [loading, setLoading] = useState(false)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')

  const label = (key: TranslationKey): string => t(key, locale)

  const refresh = async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const [filtered, catalog] = await Promise.all([
        window.octa.skills.list({
          department: department || undefined,
          query: query.trim() || undefined,
          includeReference
        }),
        window.octa.skills.list({ includeReference })
      ])
      setSkills(filtered)
      setDepartments([...new Set(catalog.map((skill) => skill.department))].sort())
    } catch (loadError) {
      setError(`${label('skillLoadError')} ${errorMessage(loadError)}`)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [department, query, includeReference])

  const openRunDialog = (skill: Skill): void => {
    if (skill.verdict === 'reference') return
    setActiveSkill(skill)
    setInputDraft('{}')
    setError('')
    setStatus('')
  }

  const closeRunDialog = (): void => {
    if (starting) return
    setActiveSkill(null)
  }

  const startSkill = async (): Promise<void> => {
    if (!activeSkill || starting) return
    let input: unknown
    try {
      input = inputDraft.trim() ? JSON.parse(inputDraft) as unknown : {}
    } catch {
      setError(label('skillInvalidJson'))
      return
    }

    setStarting(true)
    setError('')
    try {
      const started = await window.octa.jobs.start({
        runner: activeSkill.runner,
        skill: activeSkill.name,
        input,
        department: activeSkill.department,
        autonomy: activeSkill.autonomy,
        gate: 'none',
        language: locale
      })
      setStatus(interpolate(label('skillStarted'), { id: started.id }))
      setActiveSkill(null)
    } catch (startError) {
      setError(errorMessage(startError))
    } finally {
      setStarting(false)
    }
  }

  return (
    <main className="page skills-page">
      <header className="page-heading">
        <div>
          <span className="eyebrow">{label('skillsEyebrow')}</span>
          <h1>{label('skillsTitle')}</h1>
          <p>{label('skillsIntro')}</p>
        </div>
        <button className="language-chip" disabled={loading} onClick={() => void refresh()} type="button">
          <RefreshCw className={loading ? 'spin' : ''} size={15} />
          {label('refreshSkills')}
        </button>
      </header>

      {error && <p className="inline-status error skills-error">{error}</p>}
      {status && <p className="inline-status success skills-status">{status}</p>}

      <section className="skills-toolbar glass">
        <label className="skills-search">
          <Search size={16} />
          <span className="sr-only">{label('searchSkills')}</span>
          <input
            aria-label={label('searchSkills')}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={label('searchSkillsPlaceholder')}
            spellCheck={false}
            type="search"
            value={query}
          />
        </label>
        <label className="skills-filter">
          <Filter size={15} />
          <span className="sr-only">{label('allDepartments')}</span>
          <select aria-label={label('allDepartments')} onChange={(event) => setDepartment(event.target.value)} value={department}>
            <option value="">{label('allDepartments')}</option>
            {departments.map((item) => <option key={item} value={item}>{departmentLabel(item, locale)}</option>)}
          </select>
        </label>
        <label className="skills-reference-toggle">
          <input checked={includeReference} onChange={(event) => setIncludeReference(event.target.checked)} type="checkbox" />
          <span>{label('includeReference')}</span>
        </label>
        <span className="skills-count">{interpolate(label('skillsFound'), { count: skills.length })}</span>
      </section>

      <section className="skills-grid" aria-label={label('skillsTitle')}>
        {skills.length === 0 && <p className="empty-state">{label('noSkills')}</p>}
        {skills.map((skill, index) => (
          <article className={`skill-card glass verdict-${skill.verdict}`} key={`${skill.name}-${index}`}>
            <header className="skill-card-heading">
              <div className="skill-card-title">
                <span className="skill-number">{String(index + 1).padStart(2, '0')}</span>
                <div>
                  <h2>{skill.name}</h2>
                  <p>{departmentLabel(skill.department, locale)}</p>
                </div>
              </div>
              <BookOpen size={17} />
            </header>
            <div className="skill-badges">
              <span className={`skill-badge badge-${skill.verdict}`}>{label(verdictKey(skill.verdict))}</span>
              <span className="skill-badge badge-autonomy">{label(autonomyKey(skill.autonomy))}</span>
            </div>
            <p className="skill-description" dir="auto">{skill.description}</p>
            <p className="skill-use" dir="auto">{skill.use}</p>
            <footer className="skill-card-footer">
              <code dir="ltr">{skill.runner}</code>
              {skill.verdict === 'reference' ? (
                <button className="quiet-button" disabled type="button">
                  <BookOpen size={14} /> {label('skillReference')}
                </button>
              ) : (
                <button className="accent-button" onClick={() => openRunDialog(skill)} type="button">
                  <Play size={14} /> {label('skillRun')}
                </button>
              )}
            </footer>
          </article>
        ))}
      </section>

      {activeSkill && (
        <div className="skill-modal-backdrop" onMouseDown={closeRunDialog}>
          <section
            aria-labelledby="skill-input-title"
            aria-modal="true"
            className="skill-modal glass"
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
          >
            <header className="skill-modal-heading">
              <div>
                <span className="eyebrow">{label('skillInput')}</span>
                <h2 id="skill-input-title">{interpolate(label('skillInputTitle'), { name: activeSkill.name })}</h2>
                <p>{label('skillInputDetail')}</p>
              </div>
              <button aria-label={label('closeDialog')} className="icon-button" disabled={starting} onClick={closeRunDialog} type="button">
                <X size={17} />
              </button>
            </header>
            <textarea
              aria-label={label('skillInput')}
              className="skill-input"
              disabled={starting}
              onChange={(event) => setInputDraft(event.target.value)}
              placeholder={label('skillInputPlaceholder')}
              spellCheck={false}
              value={inputDraft}
            />
            <footer className="skill-modal-actions">
              <button className="quiet-button" disabled={starting} onClick={closeRunDialog} type="button">
                {label('cancelSkill')}
              </button>
              <button className="accent-button" disabled={starting} onClick={() => void startSkill()} type="button">
                <Play size={14} /> {starting ? label('startingSkill') : label('startSkill')}
              </button>
            </footer>
          </section>
        </div>
      )}

      {!activeSkill && loading && <Library className="skills-loading-icon spin" size={18} />}
    </main>
  )
}

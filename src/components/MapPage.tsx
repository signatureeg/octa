import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GitBranch, Play, RefreshCw, X } from 'lucide-react'
import type { JobOutput, JobRecord } from '../../electron/types'
import type { Skill } from '../../electron/core/skills/registry'
import type { Locale, TranslationKey } from '../i18n'
import { t } from '../i18n'
import {
  MAP_STATUS_COLORS,
  buildSkillRunForm,
  isVisibleSkill,
  lastOutputsForSkill,
  layoutMap,
  latestJobBySkill,
  mapJobStatus,
  statusColor
} from './map'
import type { MapDepartment, MapSkillStatus } from './map'
import { departmentLabel } from './map'

const MAP_STATUS_KEYS: Record<MapSkillStatus, TranslationKey> = {
  never: 'mapStatusNever',
  ok: 'jobStatusOk',
  failed: 'jobStatusFailed',
  needs_approval: 'jobStatusNeedsApproval',
  running: 'jobStatusRunning'
}


const AUTONOMY_KEYS: Record<Skill['autonomy'], TranslationKey> = {
  auto: 'skillAutonomyAuto',
  assisted: 'skillAutonomyAssisted',
  led: 'skillAutonomyLed'
}

export {
  MAP_DEPARTMENTS,
  MAP_STATUS_COLORS,
  buildSkillRunForm,
  colorForStatus,
  generateSkillRunForm,
  isVisibleSkill,
  lastOutputsForSkill,
  layoutMap,
  latestJobBySkill,
  mapJobStatus,
  skillStatus,
  statusColor
} from './map'
export type {
  MapDepartment,
  MapLayout,
  MapLayoutLink,
  MapLayoutNode,
  MapLayoutOptions,
  MapSkillStatus,
  SkillRunField,
  SkillRunForm
} from './map'

function interpolate(value: string, values: Record<string, string | number>): string {
  return value.replace(/\{(\w+)\}/g, (_match, key: string) => String(values[key] ?? ''))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}


function statusLabel(status: MapSkillStatus, locale: Locale): string {
  return t(MAP_STATUS_KEYS[status], locale)
}

function autonomyLabel(skill: Skill, locale: Locale): string {
  return t(AUTONOMY_KEYS[skill.autonomy], locale)
}

function clipped(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized
}

function eventJobRefresh(
  refresh: (quiet?: boolean) => Promise<void>,
  timerRef: { current: ReturnType<typeof setTimeout> | undefined }
): () => void {
  return () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = undefined
      void refresh(true)
    }, 100)
  }
}

export function MapPage({ locale }: { locale: Locale }): React.JSX.Element {
  const [skills, setSkills] = useState<Skill[]>([])
  const [jobs, setJobs] = useState<JobRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [statusMessage, setStatusMessage] = useState('')
  const [runError, setRunError] = useState('')
  const [hoveredSkill, setHoveredSkill] = useState<string | null>(null)
  const [activeSkill, setActiveSkill] = useState<Skill | null>(null)
  const [inputDraft, setInputDraft] = useState('')
  const [starting, setStarting] = useState(false)
  const eventTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const refresh = useCallback(async (quiet = false): Promise<void> => {
    if (!quiet) setLoading(true)
    try {
      const [nextSkills, nextJobs] = await Promise.all([
        window.octa.skills.list(),
        window.octa.jobs.list({ limit: 500 })
      ])
      setSkills(nextSkills.filter(isVisibleSkill))
      setJobs(nextJobs)
      setError('')
    } catch (loadError) {
      setError(`${t('mapLoadError', locale)} ${errorMessage(loadError)}`)
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [locale])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (typeof window === 'undefined' || !window.octa?.jobs) return undefined
    const scheduleRefresh = eventJobRefresh(refresh, eventTimer)
    const unsubscribe = window.octa.jobs.onEvent(scheduleRefresh)
    return () => {
      unsubscribe()
      if (eventTimer.current) clearTimeout(eventTimer.current)
      eventTimer.current = undefined
    }
  }, [refresh])

  const layout = useMemo(() => layoutMap(skills), [skills])
  const latest = useMemo(() => latestJobBySkill(jobs), [jobs])
  const outputsBySkill = useMemo(() => {
    const outputMap = new Map<string, JobOutput[]>()
    for (const node of layout.skills) {
      if (node.skill) outputMap.set(node.skill.name, lastOutputsForSkill(node.skill.name, jobs))
    }
    return outputMap
  }, [jobs, layout.skills])
  const nodesById = useMemo(() => new Map(layout.nodes.map((node) => [node.id, node])), [layout.nodes])
  const hoveredNode = hoveredSkill
    ? layout.skills.find((node) => node.skill?.name === hoveredSkill) ?? null
    : null
  const activeForm = activeSkill ? buildSkillRunForm(activeSkill) : null
  const label = (key: TranslationKey): string => t(key, locale)

  const openSkill = (skill: Skill): void => {
    setActiveSkill(skill)
    setInputDraft('')
    setRunError('')
    setHoveredSkill(null)
  }

  const closeSkill = (): void => {
    if (starting) return
    setActiveSkill(null)
    setRunError('')
  }

  const startSkill = async (): Promise<void> => {
    if (!activeSkill || starting) return
    setStarting(true)
    setRunError('')
    try {
      const input = inputDraft.trim() ? { text: inputDraft.trim() } : {}
      const started = await window.octa.jobs.start({
        runner: activeSkill.runner,
        skill: activeSkill.name,
        input,
        department: activeSkill.department,
        autonomy: activeSkill.autonomy,
        gate: 'none',
        language: locale
      })
      setStatusMessage(interpolate(label('mapJobStarted'), { id: started.id }))
      setActiveSkill(null)
      void refresh(true)
    } catch (startError) {
      setRunError(`${label('mapRunError')} ${errorMessage(startError)}`)
    } finally {
      setStarting(false)
    }
  }

  const renderTooltip = (): React.JSX.Element | null => {
    if (!hoveredNode?.skill) return null
    const outputs = outputsBySkill.get(hoveredNode.skill.name) ?? []
    const tooltipWidth = 226
    const tooltipHeight = 62 + Math.max(1, outputs.length) * 18
    const x = hoveredNode.x > layout.width * 0.72
      ? Math.max(8, hoveredNode.x - tooltipWidth - 18)
      : Math.min(layout.width - tooltipWidth - 8, hoveredNode.x + 18)
    const y = Math.max(8, Math.min(layout.height - tooltipHeight - 8, hoveredNode.y - tooltipHeight / 2))
    return (
      <g className="map-tooltip" pointerEvents="none" transform={`translate(${x}, ${y})`}>
        <rect height={tooltipHeight} rx="11" width={tooltipWidth} />
        <text className="map-tooltip-title" x="13" y="21">{clipped(hoveredNode.skill.name, 31)}</text>
        {outputs.length === 0 ? (
          <text className="map-tooltip-empty" x="13" y="43">{label('mapNoOutputs')}</text>
        ) : (
          outputs.map((output, index) => (
            <text className="map-tooltip-output" key={`${output.path}-${index}`} x="13" y={43 + index * 18}>
              {`${index + 1}. ${clipped(output.title || output.path, 30)}`}
              <title>{output.title || output.path}</title>
            </text>
          ))
        )}
      </g>
    )
  }

  return (
    <main className="page map-page">
      <header className="page-heading">
        <div>
          <span className="eyebrow">{label('mapEyebrow')}</span>
          <h1>{label('mapTitle')}</h1>
          <p>{label('mapIntro')}</p>
        </div>
        <button className="language-chip" disabled={loading} onClick={() => void refresh()} type="button">
          <RefreshCw className={loading ? 'spin' : ''} size={15} />
          {label('refreshMap')}
        </button>
      </header>

      {error && <p className="inline-status error map-message">{error}</p>}
      {statusMessage && <p aria-live="polite" className="inline-status success map-message">{statusMessage}</p>}

      <section className="map-toolbar glass" aria-label={label('mapTitle')}>
        <div className="map-stat-block">
          <GitBranch size={17} />
          <div>
            <strong>{interpolate(label('mapSkillCount'), { count: layout.skills.length })}</strong>
            <span>{interpolate(label('mapDepartmentCount'), { count: layout.departments.length })}</span>
          </div>
        </div>
        <div className="map-legend">
          <span className="map-legend-title">{label('mapLegend')}</span>
          {(Object.keys(MAP_STATUS_COLORS) as MapSkillStatus[]).map((status) => (
            <span className="map-legend-item" key={status}>
              <i style={{ backgroundColor: statusColor(status) }} />
              {statusLabel(status, locale)}
            </span>
          ))}
        </div>
      </section>

      <section className="map-card glass" aria-busy={loading}>
        <div className="map-stage">
          <svg
            aria-label={label('mapTitle')}
            className="map-svg"
            role="img"
            viewBox={`0 0 ${layout.width} ${layout.height}`}
          >
            <defs>
              <radialGradient id="map-center-gradient" cx="50%" cy="35%" r="70%">
                <stop offset="0%" stopColor="#c8b2f2" />
                <stop offset="100%" stopColor="#7049a6" />
              </radialGradient>
            </defs>

            <g className="map-links" aria-hidden="true">
              {layout.links.map((link) => {
                const source = nodesById.get(link.source)
                const target = nodesById.get(link.target)
                if (!source || !target) return null
                return (
                  <line
                    className={`map-link map-link-${link.type}`}
                    key={`${link.source}-${link.target}`}
                    x1={source.x}
                    x2={target.x}
                    y1={source.y}
                    y2={target.y}
                  />
                )
              })}
            </g>

            {layout.departments.map((node) => (
              <g className="map-department" key={node.id}>
                <circle cx={node.x} cy={node.y} r={node.radius} />
                <text dominantBaseline="middle" textAnchor="middle" x={node.x} y={node.y}>
                  {departmentLabel(node.department ?? node.label, locale)}
                </text>
                <title>{departmentLabel(node.department ?? node.label, locale)}</title>
              </g>
            ))}

            {layout.skills.map((node) => {
              if (!node.skill) return null
              const status = mapJobStatus(latest.get(node.skill.name)?.status)
              const color = statusColor(status)
              const autonomy = autonomyLabel(node.skill, locale)
              // Labels point outward along the node's ray; on the left half they are flipped so they read left-to-right.
              const angle = node.angle ?? 0
              const leftHalf = Math.cos(angle) < 0
              const degrees = (angle * 180) / Math.PI + (leftHalf ? 180 : 0)
              const labelX = node.x + Math.cos(angle) * (node.radius + 7)
              const labelY = node.y + Math.sin(angle) * (node.radius + 7)
              const onKeyDown = (event: React.KeyboardEvent<SVGGElement>): void => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                openSkill(node.skill!)
              }
              return (
                <g
                  aria-label={`${node.skill.name} · ${statusLabel(status, locale)} · ${autonomyLabel(node.skill, locale)}`}
                  className={`map-skill map-skill-${status}`}
                  key={node.id}
                  onBlur={() => setHoveredSkill(null)}
                  onClick={() => openSkill(node.skill!)}
                  onFocus={() => setHoveredSkill(node.skill!.name)}
                  onKeyDown={onKeyDown}
                  onMouseEnter={() => setHoveredSkill(node.skill!.name)}
                  onMouseLeave={() => setHoveredSkill(null)}
                  role="button"
                  tabIndex={0}
                >
                  <circle className="map-skill-halo" cx={node.x} cy={node.y} r={node.radius + 5} stroke={color} />
                  <circle className="map-skill-dot" cx={node.x} cy={node.y} fill={color} r={node.radius} />
                  <text
                    className="map-skill-label"
                    dominantBaseline="central"
                    textAnchor={leftHalf ? 'end' : 'start'}
                    transform={`rotate(${degrees.toFixed(2)} ${labelX.toFixed(1)} ${labelY.toFixed(1)})`}
                    x={labelX}
                    y={labelY}
                  >
                    {leftHalf && <tspan className="map-autonomy-label">{`${autonomy}  `}</tspan>}
                    {clipped(node.skill.name, 24)}
                    {!leftHalf && <tspan className="map-autonomy-label">{`  ${autonomy}`}</tspan>}
                  </text>
                  <title>{`${node.skill.name} · ${statusLabel(status, locale)} · ${autonomyLabel(node.skill, locale)}`}</title>
                </g>
              )
            })}

            <g className="map-center-node">
              <circle cx={layout.center.x} cy={layout.center.y} fill="url(#map-center-gradient)" r={layout.center.radius} />
              <text dominantBaseline="middle" textAnchor="middle" x={layout.center.x} y={layout.center.y - 2}>{label('mapCenterTitle')}</text>
              <text className="map-center-subtitle" dominantBaseline="middle" textAnchor="middle" x={layout.center.x} y={layout.center.y + 15}>{label('mapCenterSubtitle')}</text>
            </g>

            {renderTooltip()}
          </svg>
          {!loading && layout.skills.length === 0 && <p className="empty-state map-empty">{label('noSkills')}</p>}
          {loading && <RefreshCw className="map-loading spin" size={18} />}
        </div>
      </section>

      {activeSkill && activeForm && (
        <div className="skill-modal-backdrop" onMouseDown={closeSkill}>
          <section
            aria-labelledby="map-run-title"
            aria-modal="true"
            className="skill-modal glass map-run-modal"
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
          >
            <header className="skill-modal-heading">
              <div>
                <span className="eyebrow">{label('mapRunEyebrow')}</span>
                <h2 id="map-run-title">{interpolate(label('mapRunTitle'), { name: activeForm.skill })}</h2>
                <p>{label('mapRunDescription')}</p>
              </div>
              <button aria-label={label('closeDialog')} className="icon-button" disabled={starting} onClick={closeSkill} type="button">
                <X size={17} />
              </button>
            </header>
            <div className="map-form-context">
              <span>{label('mapSkillDescription')}</span>
              <p>{activeForm.description}</p>
            </div>
            <label className="map-form-field" htmlFor="map-skill-input">
              <span>{label('mapArgumentLabel')}</span>
              {activeForm.argumentHint && <small>{activeForm.argumentHint}</small>}
              <textarea
                aria-label={label('mapArgumentLabel')}
                className="skill-input"
                disabled={starting}
                id="map-skill-input"
                onChange={(event) => setInputDraft(event.target.value)}
                placeholder={activeForm.argumentHint || label('mapInputPlaceholder')}
                spellCheck={false}
                value={inputDraft}
              />
            </label>
            {runError && <p className="inline-status error map-run-error">{runError}</p>}
            <footer className="skill-modal-actions">
              <button className="quiet-button" disabled={starting} onClick={closeSkill} type="button">
                {label('cancelSkill')}
              </button>
              <button className="accent-button" disabled={starting} onClick={() => void startSkill()} type="button">
                <Play size={14} /> {starting ? label('startingSkill') : label('mapStartSkill')}
              </button>
            </footer>
          </section>
        </div>
      )}
    </main>
  )
}

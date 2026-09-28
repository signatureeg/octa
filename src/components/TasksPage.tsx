import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Bot,
  ArrowLeft,
  Check,
  ChevronDown,
  CircleDashed,
  Flame,
  Pause,
  Play,
  Plus,
  Search,
  Trash2,
  X
} from 'lucide-react'
import type { AgentRecord, NewTask, TaskRecord, TaskStatus } from '../../electron/types'
import type { Locale, TranslationKey } from '../i18n'
import { t } from '../i18n'

const COLUMNS: Array<{ status: TaskStatus; label: TranslationKey }> = [
  { status: 'doing', label: 'tasksDoing' },
  { status: 'todo', label: 'tasksTodo' },
  { status: 'inbox', label: 'tasksInbox' },
  { status: 'done', label: 'tasksDone' }
]

const PRIORITY_KEYS: readonly TranslationKey[] = [
  'taskPriorityNormal',
  'taskPriorityHigh',
  'taskPriorityUrgent'
]

function intlLocale(locale: Locale): string {
  return locale === 'ar' ? 'ar-EG' : 'en-US'
}

function interpolate(value: string, replacements: Record<string, string | number>): string {
  return Object.entries(replacements).reduce(
    (result, [key, replacement]) => result.replaceAll(`{${key}}`, String(replacement)),
    value
  )
}

function label(key: TranslationKey, locale: Locale): string {
  return t(key, locale)
}

function elapsed(task: TaskRecord, now: number): number {
  const open = task.runningSince ? Math.max(0, Math.floor((now - task.runningSince) / 1000)) : 0
  return task.trackedSeconds + open
}

export function formatDuration(seconds: number, locale: Locale = 'en'): string {
  const number = (value: number): string =>
    new Intl.NumberFormat(intlLocale(locale), { useGrouping: false }).format(value)
  if (seconds <= 0) return label('durationZero', locale)
  if (seconds < 60) {
    return interpolate(label('durationSeconds', locale), { count: number(seconds) })
  }
  const total = Math.round(seconds / 60)
  const hours = Math.floor(total / 60)
  if (hours) {
    return interpolate(label('durationHours', locale), {
      hours: number(hours),
      minutes: number(total % 60)
    })
  }
  return interpolate(label('durationMinutes', locale), { count: number(total) })
}

function dueLabel(dueAt: number | null, now: number, locale: Locale): { text: string; tone: string } | undefined {
  if (!dueAt) return undefined
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  const days = Math.round((dueAt - start.getTime()) / 86_400_000)
  if (days < 0) {
    return {
      text: interpolate(label('taskOverdue', locale), {
        count: new Intl.NumberFormat(intlLocale(locale), { useGrouping: false }).format(Math.abs(days))
      }),
      tone: 'overdue'
    }
  }
  if (days === 0) return { text: label('taskToday', locale), tone: 'today' }
  if (days === 1) return { text: label('taskTomorrow', locale), tone: 'soon' }
  return {
    text: new Date(dueAt).toLocaleDateString(intlLocale(locale), { month: 'short', day: 'numeric' }),
    tone: ''
  }
}

function TaskComposer({
  projects,
  locale,
  onCreate
}: {
  projects: string[]
  locale: Locale
  onCreate: (input: NewTask) => void
}): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [open, setOpen] = useState(false)
  const [project, setProject] = useState('')
  const [priority, setPriority] = useState(0)
  const [due, setDue] = useState('')
  const [estimate, setEstimate] = useState('')

  const submit = (): void => {
    const trimmed = title.trim()
    if (!trimmed) return
    onCreate({
      title: trimmed,
      project,
      priority,
      // Noon avoids the date landing on the previous day in negative-offset zones.
      dueAt: due ? new Date(`${due}T12:00:00`).getTime() : null,
      estimateMinutes: estimate ? Number(estimate) : null,
      status: 'todo'
    })
    setTitle('')
    setDue('')
    setEstimate('')
    setPriority(0)
  }

  return (
    <section className="task-composer glass">
      <div className="task-composer-main">
        <Plus size={17} aria-hidden="true" />
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && submit()}
          placeholder={label('taskComposerPlaceholder', locale)}
          dir="auto"
          aria-label={label('taskNewTitleAria', locale)}
        />
        <button
          className="text-button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-controls="task-composer-details"
          type="button"
        >
          {label('taskDetails', locale)} <ChevronDown size={14} className={open ? 'flipped' : ''} aria-hidden="true" />
        </button>
        <button className="primary-button compact" onClick={submit} disabled={!title.trim()} type="button">
          {label('taskAdd', locale)}
        </button>
      </div>
      {open && (
        <div className="task-composer-details" id="task-composer-details">
          <label>
            <span>{label('taskProject', locale)}</span>
            <input
              value={project}
              onChange={(event) => setProject(event.target.value)}
              list="task-projects"
              placeholder={label('taskProjectPlaceholder', locale)}
              dir="auto"
            />
            <datalist id="task-projects">
              {projects.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </label>
          <label>
            <span>{label('taskPriority', locale)}</span>
            <select value={priority} onChange={(event) => setPriority(Number(event.target.value))}>
              {PRIORITY_KEYS.map((key, index) => (
                <option key={key} value={index}>
                  {label(key, locale)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{label('taskDue', locale)}</span>
            <input type="date" value={due} onChange={(event) => setDue(event.target.value)} />
          </label>
          <label>
            <span>{label('taskEstimate', locale)}</span>
            <input
              type="number"
              min={1}
              value={estimate}
              onChange={(event) => setEstimate(event.target.value)}
              placeholder={label('taskMinutesPlaceholder', locale)}
            />
          </label>
        </div>
      )}
    </section>
  )
}

function TaskCard({
  task,
  now,
  locale,
  onToggleTimer,
  onComplete,
  onDelete,
  onEdit,
  agents,
  onDelegate
}: {
  task: TaskRecord
  now: number
  locale: Locale
  onToggleTimer: () => void
  onComplete: () => void
  onDelete: () => void
  onEdit: (patch: Partial<NewTask>) => void
  agents: AgentRecord[]
  onDelegate: (agentId: string) => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [delegating, setDelegating] = useState(false)
  const [draft, setDraft] = useState(task.title)
  const due = dueLabel(task.dueAt, now, locale)
  const running = task.runningSince !== null
  const tracked = elapsed(task, now)
  const overBudget =
    task.estimateMinutes !== null && tracked > task.estimateMinutes * 60
  const priorityKey = PRIORITY_KEYS[task.priority]

  return (
    <article className={`task-card${running ? ' running' : ''}`}>
      <button
        className="task-check"
        onClick={onComplete}
        aria-label={label(task.status === 'done' ? 'taskReopen' : 'taskComplete', locale)}
        title={label(task.status === 'done' ? 'taskReopen' : 'taskComplete', locale)}
        type="button"
      >
        {task.status === 'done' ? <Check size={14} /> : <CircleDashed size={15} />}
      </button>

      <div className="task-body">
        {editing ? (
          <input
            className="task-title-input"
            value={draft}
            autoFocus
            dir="auto"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => {
              setEditing(false)
              if (draft.trim() && draft !== task.title) onEdit({ title: draft.trim() })
              else setDraft(task.title)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
              if (event.key === 'Escape') {
                setDraft(task.title)
                setEditing(false)
              }
            }}
          />
        ) : (
          <p className="task-title" dir="auto" onDoubleClick={() => setEditing(true)}>
            {task.title}
          </p>
        )}

        <div className="task-meta">
          {task.priority > 0 && (
            <span className={`task-flag p${task.priority}`}>
              <Flame size={11} aria-hidden="true" /> {priorityKey ? label(priorityKey, locale) : ''}
            </span>
          )}
          {task.project && <span className="task-chip">{task.project}</span>}
          {due && <span className={`task-due ${due.tone}`}>{due.text}</span>}
          {(tracked > 0 || running) && (
            <span className={`task-time${overBudget ? ' over' : ''}${running ? ' live' : ''}`}>
              {formatDuration(tracked, locale)}
              {task.estimateMinutes ? ` / ${formatDuration(task.estimateMinutes * 60, locale)}` : ''}
            </span>
          )}
          {task.source === 'voice' && <span className="task-chip subtle">{label('taskSourceVoice', locale)}</span>}
        </div>
      </div>

      <div className="task-actions">
        {task.status !== 'done' && (
          <button
            className={`task-timer${running ? ' running' : ''}`}
            onClick={onToggleTimer}
            aria-label={label(running ? 'taskStopTiming' : 'taskStartTiming', locale)}
            title={label(running ? 'taskStopTiming' : 'taskStartTiming', locale)}
            type="button"
          >
            {running ? <Pause size={14} /> : <Play size={14} />}
          </button>
        )}
        {task.status !== 'done' && agents.length > 0 && (
          <button
            aria-expanded={delegating}
            aria-label={label('taskDelegate', locale)}
            onClick={() => setDelegating((value) => !value)}
            title={label('taskDelegate', locale)}
            type="button"
          >
            <Bot size={14} aria-hidden="true" />
          </button>
        )}
        <button onClick={onDelete} aria-label={label('taskDelete', locale)} title={label('taskDelete', locale)} type="button">
          <Trash2 size={14} aria-hidden="true" />
        </button>
      </div>
      {delegating && (
        <select
          aria-label={label('taskDelegate', locale)}
          autoFocus
          className="task-delegate"
          defaultValue=""
          onChange={(event) => {
            if (!event.target.value) return
            setDelegating(false)
            onDelegate(event.target.value)
          }}
        >
          <option value="">{label('taskDelegatePick', locale)}</option>
          {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
        </select>
      )}
    </article>
  )
}

export function TasksPage({ onBack, locale }: { onBack: () => void; locale: Locale }): React.JSX.Element {
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [projects, setProjects] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [project, setProject] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const [error, setError] = useState('')
  const timer = useRef<ReturnType<typeof setInterval>>(undefined)

  const load = useCallback(async () => {
    const [nextTasks, nextProjects] = await Promise.all([
      window.octa.tasks.list({ query, project: project || undefined }),
      window.octa.tasks.projects()
    ])
    setTasks(nextTasks)
    setProjects(nextProjects)
  }, [query, project])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => window.octa.onTasksChanged(() => void load()), [load])

  // Only tick while something is actually being timed; a second-by-second
  // re-render of a static board is pure waste.
  const hasRunning = tasks.some((task) => task.runningSince !== null)
  useEffect(() => {
    if (!hasRunning) return
    timer.current = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer.current)
  }, [hasRunning])

  const [agents, setAgents] = useState<AgentRecord[]>([])
  useEffect(() => {
    if (!window.octa?.agents) return
    void window.octa.agents.list().then((list) => setAgents(list.filter((agent) => agent.status === 'active'))).catch(() => setAgents([]))
  }, [])

  const run = async (action: Promise<unknown>): Promise<void> => {
    try {
      setError('')
      await action
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const grouped = useMemo(
    () =>
      COLUMNS.map((column) => ({
        ...column,
        items: tasks.filter((task) => task.status === column.status)
      })),
    [tasks]
  )

  const totalToday = useMemo(
    () => tasks.reduce((sum, task) => sum + elapsed(task, now), 0),
    [tasks, now]
  )

  return (
    <div className="page" dir={locale === 'ar' ? 'rtl' : 'ltr'}>
      <header className="compact-heading">
        <div>
          <span className="eyebrow">{label('tasksEyebrow', locale)}</span>
          <h1>{label('tasksTitle', locale)}</h1>
        </div>
        <div className="heading-actions">
          <span className="task-total">
            {interpolate(label('tasksTracked', locale), { duration: formatDuration(totalToday, locale) })}
          </span>
          <button className="text-button" onClick={onBack} type="button">
            <ArrowLeft size={15} aria-hidden="true" /> {label('tasksBackHome', locale)}
          </button>
        </div>
      </header>

      <TaskComposer
        projects={projects}
        locale={locale}
        onCreate={(input) => void run(window.octa.tasks.create(input))}
      />

      {error && <p className="inline-error">{error}</p>}

      <div className="task-toolbar">
        <label className="search-box glass">
          <Search size={17} aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={label('taskSearchPlaceholder', locale)}
            dir="auto"
            aria-label={label('taskSearchPlaceholder', locale)}
          />
        </label>
        <select value={project} onChange={(event) => setProject(event.target.value)} aria-label={label('taskFilterProject', locale)}>
          <option value="">{label('taskAllProjects', locale)}</option>
          {projects.map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
        {(query || project) && (
          <button
            className="text-button"
            onClick={() => {
              setQuery('')
              setProject('')
            }}
            type="button"
          >
            <X size={14} aria-hidden="true" /> {label('taskClearFilters', locale)}
          </button>
        )}
      </div>

      <div className="task-board">
        {grouped.map((column) => (
          <section className="task-column" key={column.status}>
            <header>
              <h3>{label(column.label, locale)}</h3>
              <span>{column.items.length}</span>
            </header>
            <div className="task-column-list">
              {column.items.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  now={now}
                  locale={locale}
                  onToggleTimer={() =>
                    void run(
                      task.runningSince
                        ? window.octa.tasks.stop(task.id)
                        : window.octa.tasks.start(task.id)
                    )
                  }
                  onComplete={() =>
                    void run(
                      window.octa.tasks.update(task.id, {
                        status: task.status === 'done' ? 'todo' : 'done'
                      })
                    )
                  }
                  onDelete={() => void run(window.octa.tasks.remove(task.id))}
                  onEdit={(patch) => void run(window.octa.tasks.update(task.id, patch))}
                  agents={agents}
                  onDelegate={(agentId) => void run(window.octa.agents.run(agentId, '', task.id))}
                />
              ))}
              {column.items.length === 0 && <p className="task-column-empty">{label('taskNothingHere', locale)}</p>}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}

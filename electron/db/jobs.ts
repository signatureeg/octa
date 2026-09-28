import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DATABASE_BUSY_TIMEOUT_MS } from './busy-timeout'
import type {
  JobAutonomy,
  JobGate,
  JobRecord,
  JobRunnerName,
  JobStatus
} from '../types'

interface JobRow {
  id: string
  workflow_run_id: string | null
  plan_id: string | null
  workflow: string | null
  step_id: string | null
  skill: string | null
  runner: string
  department: string | null
  status: string
  autonomy: string | null
  gate: string | null
  input_json: string | null
  result_json: string | null
  review_json: string | null
  source_count: number
  cost_json: string | null
  started_at: string | null
  finished_at: string | null
  approved_by: string | null
  approved_at: string | null
  error: string | null
  state_json: string | null
  gate_payload_json: string | null
  gate_created_at: string | null
  gate_expires_at: string | null
  gate_decision: string | null
  gate_comments: string | null
  attempt: number
}

interface PlanRow {
  id: string
  conversation_id: string | null
  brief_md: string
  plan_json: string
  round: number
  question_round: number
  status: string
  created_at: string
}

interface WorkflowRow {
  id: string
  name: string
  version: number
  definition_json: string
  created_at: string
  updated_at: string
}

interface WorkflowStatsRow {
  workflow_id: string
  clean_runs: number
  rejection_count: number
  autonomy: string
  promoted_at: string | null
  demoted_at: string | null
  updated_at: string
}

interface RecurringJobRow {
  id: string
  name: string
  workflow: string
  every: string
  next_run_at: string | null
  last_run_at: string | null
  autonomy: string
  enabled: number
  input_json: string | null
  created_at: string
  updated_at: string
}

export interface CreateJobInput {
  id?: string
  workflowRunId?: string | null
  planId?: string | null
  workflow?: string | null
  stepId?: string | null
  skill?: string | null
  runner: JobRunnerName | string
  department?: string | null
  status?: JobStatus
  autonomy?: JobAutonomy | null
  gate?: JobGate | null
  input?: unknown
  result?: unknown
  review?: unknown
  sourceCount?: number
  cost?: unknown
  startedAt?: string | null
  finishedAt?: string | null
  approvedBy?: string | null
  approvedAt?: string | null
  error?: string | null
  state?: unknown
  gatePayload?: unknown
  gateCreatedAt?: string | null
  gateExpiresAt?: string | null
  gateDecision?: string | null
  gateComments?: string | null
  attempt?: number
}

export interface UpdateJobInput {
  workflowRunId?: string | null
  planId?: string | null
  workflow?: string | null
  stepId?: string | null
  skill?: string | null
  runner?: JobRunnerName | string
  department?: string | null
  status?: JobStatus
  autonomy?: JobAutonomy | null
  gate?: JobGate | null
  input?: unknown
  result?: unknown
  review?: unknown
  sourceCount?: number
  cost?: unknown
  startedAt?: string | null
  finishedAt?: string | null
  approvedBy?: string | null
  approvedAt?: string | null
  error?: string | null
  state?: unknown
  gatePayload?: unknown
  gateCreatedAt?: string | null
  gateExpiresAt?: string | null
  gateDecision?: string | null
  gateComments?: string | null
  attempt?: number
}

export interface ListJobsOptions {
  status?: JobStatus | string
  limit?: number
}

export type PlanStatus = 'draft' | 'needs_input' | 'needs_approval' | 'approved'

export interface PlanRecord {
  id: string
  conversationId: string | null
  briefMd: string
  plan: unknown
  round: number
  questionRound: number
  status: PlanStatus
  createdAt: string
}

export interface CreatePlanInput {
  id: string
  conversationId?: string | null
  briefMd: string
  plan: unknown
  round?: number
  questionRound?: number
  status?: PlanStatus
  createdAt?: string
}

export interface UpdatePlanInput {
  conversationId?: string | null
  briefMd?: string
  plan?: unknown
  round?: number
  questionRound?: number
  status?: PlanStatus
}

export interface WorkflowRecord {
  id: string
  name: string
  version: number
  definition: unknown
  createdAt: string
  updatedAt: string
}

export interface SaveWorkflowInput {
  id: string
  name: string
  version?: number
  definition: unknown
  createdAt?: string
  updatedAt?: string
}

export interface WorkflowStatsRecord {
  workflowId: string
  cleanRuns: number
  rejectionCount: number
  autonomy: JobAutonomy
  promotedAt: string | null
  demotedAt: string | null
  updatedAt: string
}

export interface RecurringJobRecord {
  id: string
  name: string
  workflow: string
  every: string
  nextRunAt: string | null
  lastRunAt: string | null
  autonomy: JobAutonomy
  enabled: boolean
  input: unknown
  createdAt: string
  updatedAt: string
}

export interface SaveRecurringJobInput {
  id: string
  name: string
  workflow: string
  every: string
  nextRunAt?: string | null
  lastRunAt?: string | null
  autonomy?: JobAutonomy
  enabled?: boolean
  input?: unknown
  createdAt?: string
  updatedAt?: string
}

export interface UpdateRecurringJobInput {
  name?: string
  workflow?: string
  every?: string
  nextRunAt?: string | null
  lastRunAt?: string | null
  autonomy?: JobAutonomy
  enabled?: boolean
  input?: unknown
  updatedAt?: string
}

function jsonValue(value: unknown): string | null {
  if (value === undefined) return null
  const encoded = JSON.stringify(value)
  return encoded === undefined ? null : encoded
}

function parseJson(value: string | null): unknown {
  if (value === null) return null
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function isoNow(): string {
  return new Date().toISOString()
}

function validStatus(value: string): JobStatus {
  const statuses: JobStatus[] = [
    'running',
    'ok',
    'failed',
    'needs_approval',
    'needs_input',
    'cancelled',
    'stale'
  ]
  return statuses.includes(value as JobStatus) ? (value as JobStatus) : 'failed'
}

function validAutonomy(value: string | null): JobAutonomy | null {
  return value === 'led' || value === 'assisted' || value === 'auto' ? value : null
}

function validGate(value: string | null): JobGate | null {
  return value === 'none' || value === 'review' || value === 'approve' ? value : null
}

function mapJob(row: JobRow): JobRecord {
  return {
    id: row.id,
    workflowRunId: row.workflow_run_id ?? null,
    planId: row.plan_id,
    workflow: row.workflow,
    stepId: row.step_id,
    skill: row.skill,
    runner: row.runner,
    department: row.department,
    status: validStatus(row.status),
    autonomy: validAutonomy(row.autonomy),
    gate: validGate(row.gate),
    input: parseJson(row.input_json),
    result: parseJson(row.result_json),
    review: parseJson(row.review_json),
    sourceCount: row.source_count,
    cost: parseJson(row.cost_json),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    error: row.error,
    state: parseJson(row.state_json),
    gatePayload: parseJson(row.gate_payload_json),
    gateCreatedAt: row.gate_created_at,
    gateExpiresAt: row.gate_expires_at,
    gateDecision: row.gate_decision,
    gateComments: row.gate_comments,
    attempt: Number.isFinite(row.attempt) ? Math.max(0, Math.trunc(row.attempt)) : 0
  }
}

function mapWorkflow(row: WorkflowRow): WorkflowRecord {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    definition: parseJson(row.definition_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function validAutonomyOrDefault(value: string, fallback: JobAutonomy = 'assisted'): JobAutonomy {
  return value === 'led' || value === 'assisted' || value === 'auto' ? value : fallback
}

function mapWorkflowStats(row: WorkflowStatsRow): WorkflowStatsRecord {
  return {
    workflowId: row.workflow_id,
    cleanRuns: Math.max(0, Math.trunc(row.clean_runs)),
    rejectionCount: Math.max(0, Math.trunc(row.rejection_count)),
    autonomy: validAutonomyOrDefault(row.autonomy),
    promotedAt: row.promoted_at,
    demotedAt: row.demoted_at,
    updatedAt: row.updated_at
  }
}

function mapRecurringJob(row: RecurringJobRow): RecurringJobRecord {
  return {
    id: row.id,
    name: row.name,
    workflow: row.workflow,
    every: row.every,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    autonomy: validAutonomyOrDefault(row.autonomy),
    enabled: row.enabled === 1,
    input: parseJson(row.input_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function validPlanStatus(value: string): PlanStatus {
  const statuses: PlanStatus[] = ['draft', 'needs_input', 'needs_approval', 'approved']
  return statuses.includes(value as PlanStatus) ? (value as PlanStatus) : 'draft'
}

function mapPlan(row: PlanRow): PlanRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    briefMd: row.brief_md,
    plan: parseJson(row.plan_json),
    round: row.round,
    questionRound: row.question_round,
    status: validPlanStatus(row.status),
    createdAt: row.created_at
  }
}

/** SQLite persistence for the job spine. One row is written for every run. */
export class JobsRepository {
  private readonly database: Database.Database

  constructor(readonly databasePath: string) {
    if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true })
    this.database = new Database(databasePath, { timeout: DATABASE_BUSY_TIMEOUT_MS })
    try {
      this.initialize()
    } catch (error) {
      this.database.close()
      throw error
    }
  }

  private initialize(): void {
    this.database.pragma('journal_mode = WAL')
    this.database.pragma(`busy_timeout = ${DATABASE_BUSY_TIMEOUT_MS}`)
    this.database.pragma('synchronous = FULL')
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS job_runs (
        id TEXT PRIMARY KEY,
        workflow_run_id TEXT,
        plan_id TEXT,
        workflow TEXT,
        step_id TEXT,
        skill TEXT,
        runner TEXT NOT NULL,
        department TEXT,
        status TEXT NOT NULL,
        autonomy TEXT,
        gate TEXT,
        input_json TEXT,
        result_json TEXT,
        review_json TEXT,
        source_count INTEGER NOT NULL DEFAULT 0,
        cost_json TEXT,
        started_at TEXT,
        finished_at TEXT,
        approved_by TEXT,
        approved_at TEXT,
        error TEXT,
        state_json TEXT,
        gate_payload_json TEXT,
        gate_created_at TEXT,
        gate_expires_at TEXT,
        gate_decision TEXT,
        gate_comments TEXT,
        attempt INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_job_runs_started_at ON job_runs(started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_job_runs_status ON job_runs(status);

      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        definition_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY,
        conversation_id TEXT,
        brief_md TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        round INTEGER NOT NULL DEFAULT 0,
        question_round INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'draft',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workflow_stats (
        workflow_id TEXT PRIMARY KEY,
        clean_runs INTEGER NOT NULL DEFAULT 0,
        rejection_count INTEGER NOT NULL DEFAULT 0,
        autonomy TEXT NOT NULL DEFAULT 'assisted',
        promoted_at TEXT,
        demoted_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS recurring_jobs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        workflow TEXT NOT NULL,
        every TEXT NOT NULL,
        next_run_at TEXT,
        last_run_at TEXT,
        autonomy TEXT NOT NULL DEFAULT 'assisted',
        enabled INTEGER NOT NULL DEFAULT 0,
        input_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_recurring_jobs_next_run ON recurring_jobs(next_run_at);
    `)
    this.applyMigrations()
  }

  /** Apply additive schema changes to databases created by older specs. */
  private applyMigrations(): void {
    const columns = this.database.prepare('PRAGMA table_info(job_runs)').all() as Array<{ name?: unknown }>
    if (!columns.some((column) => column.name === 'review_json')) {
      this.database.exec('ALTER TABLE job_runs ADD COLUMN review_json TEXT')
    }
    const jobColumnDefinitions: Record<string, string> = {
      workflow_run_id: 'TEXT',
      state_json: 'TEXT',
      gate_payload_json: 'TEXT',
      gate_created_at: 'TEXT',
      gate_expires_at: 'TEXT',
      gate_decision: 'TEXT',
      gate_comments: 'TEXT',
      attempt: 'INTEGER NOT NULL DEFAULT 0'
    }
    const jobColumnNames = new Set(columns.map((column) => String(column.name)))
    for (const [name, definition] of Object.entries(jobColumnDefinitions)) {
      if (!jobColumnNames.has(name)) this.database.exec(`ALTER TABLE job_runs ADD COLUMN ${name} ${definition}`)
    }
    this.database.exec('CREATE INDEX IF NOT EXISTS idx_job_runs_workflow_run ON job_runs(workflow_run_id)')
    const planColumns = this.database
      .prepare('PRAGMA table_info(plans)')
      .all() as Array<{ name: string }>
    const names = new Set(planColumns.map((column) => column.name))
    if (!names.has('question_round')) this.database.exec('ALTER TABLE plans ADD COLUMN question_round INTEGER NOT NULL DEFAULT 0')
    if (!names.has('status')) this.database.exec("ALTER TABLE plans ADD COLUMN status TEXT NOT NULL DEFAULT 'draft'")
  }

  createJob(input: CreateJobInput): JobRecord {
    const id = input.id?.trim() || randomUUID()
    const startedAt = input.startedAt === undefined ? isoNow() : input.startedAt
    this.database
      .prepare(
        `INSERT INTO job_runs
          (id, workflow_run_id, plan_id, workflow, step_id, skill, runner, department, status, autonomy, gate,
           input_json, result_json, review_json, source_count, cost_json, started_at, finished_at,
           approved_by, approved_at, error, state_json, gate_payload_json, gate_created_at,
           gate_expires_at, gate_decision, gate_comments, attempt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.workflowRunId ?? null,
        input.planId ?? null,
        input.workflow ?? null,
        input.stepId ?? null,
        input.skill ?? null,
        input.runner,
        input.department ?? null,
        input.status ?? 'running',
        input.autonomy ?? 'assisted',
        input.gate ?? 'none',
        jsonValue(input.input),
        jsonValue(input.result),
        jsonValue(input.review),
        Number.isFinite(input.sourceCount) ? Math.max(0, Math.trunc(input.sourceCount!)) : 0,
        jsonValue(input.cost),
        startedAt,
        input.finishedAt ?? null,
        input.approvedBy ?? null,
        input.approvedAt ?? null,
        input.error ?? null,
        jsonValue(input.state),
        jsonValue(input.gatePayload),
        input.gateCreatedAt ?? null,
        input.gateExpiresAt ?? null,
        input.gateDecision ?? null,
        input.gateComments ?? null,
        Number.isFinite(input.attempt) ? Math.max(0, Math.trunc(input.attempt!)) : 0
      )
    const job = this.getJob(id)
    if (!job) throw new Error(`Job ${id} was not created.`)
    return job
  }

  updateJob(id: string, update: UpdateJobInput): JobRecord | undefined {
    const columns: Array<[string, unknown]> = []
    const values: Array<keyof UpdateJobInput> = [
      'workflowRunId',
      'planId',
      'workflow',
      'stepId',
      'skill',
      'runner',
      'department',
      'status',
      'autonomy',
      'gate',
      'input',
      'result',
      'review',
      'sourceCount',
      'cost',
      'startedAt',
      'finishedAt',
      'approvedBy',
      'approvedAt',
      'error',
      'state',
      'gatePayload',
      'gateCreatedAt',
      'gateExpiresAt',
      'gateDecision',
      'gateComments',
      'attempt'
    ]
    const columnNames: Record<keyof UpdateJobInput, string> = {
      workflowRunId: 'workflow_run_id',
      planId: 'plan_id',
      workflow: 'workflow',
      stepId: 'step_id',
      skill: 'skill',
      runner: 'runner',
      department: 'department',
      status: 'status',
      autonomy: 'autonomy',
      gate: 'gate',
      input: 'input_json',
      result: 'result_json',
      review: 'review_json',
      sourceCount: 'source_count',
      cost: 'cost_json',
      startedAt: 'started_at',
      finishedAt: 'finished_at',
      approvedBy: 'approved_by',
      approvedAt: 'approved_at',
      error: 'error',
      state: 'state_json',
      gatePayload: 'gate_payload_json',
      gateCreatedAt: 'gate_created_at',
      gateExpiresAt: 'gate_expires_at',
      gateDecision: 'gate_decision',
      gateComments: 'gate_comments',
      attempt: 'attempt'
    }
    for (const key of values) {
      if (update[key] === undefined) continue
      let value: unknown = update[key]
      if (key === 'input' || key === 'result' || key === 'review' || key === 'cost' || key === 'state' || key === 'gatePayload') value = jsonValue(value)
      if (key === 'sourceCount') value = Math.max(0, Math.trunc(Number(value) || 0))
      if (key === 'attempt') value = Math.max(0, Math.trunc(Number(value) || 0))
      columns.push([columnNames[key], value])
    }
    if (columns.length === 0) return this.getJob(id)
    const setClause = columns.map(([column]) => `${column} = ?`).join(', ')
    const result = this.database
      .prepare(`UPDATE job_runs SET ${setClause} WHERE id = ?`)
      .run(...columns.map(([, value]) => value), id)
    return result.changes === 0 ? undefined : this.getJob(id)
  }

  listJobs(options: ListJobsOptions = {}): JobRecord[] {
    const clauses: string[] = []
    const parameters: unknown[] = []
    if (options.status) {
      clauses.push('status = ?')
      parameters.push(options.status)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const limit = Math.max(1, Math.min(500, Math.trunc(options.limit ?? 100)))
    const rows = this.database
      .prepare(`SELECT * FROM job_runs ${where} ORDER BY COALESCE(started_at, '') DESC LIMIT ?`)
      .all(...parameters, limit) as JobRow[]
    return rows.map(mapJob)
  }

  getJob(id: string): JobRecord | undefined {
    const row = this.database.prepare('SELECT * FROM job_runs WHERE id = ?').get(id) as
      | JobRow
      | undefined
    return row ? mapJob(row) : undefined
  }

  listJobsForWorkflowRun(workflowRunId: string): JobRecord[] {
    const rows = this.database
      .prepare('SELECT * FROM job_runs WHERE workflow_run_id = ? ORDER BY COALESCE(started_at, \"\") ASC, id ASC')
      .all(workflowRunId) as JobRow[]
    return rows.map(mapJob)
  }

  listWorkflowRuns(limit = 100): JobRecord[] {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)))
    const rows = this.database
      .prepare("SELECT * FROM job_runs WHERE runner = 'workflow' ORDER BY COALESCE(started_at, '') DESC LIMIT ?")
      .all(safeLimit) as JobRow[]
    return rows.map(mapJob)
  }

  saveWorkflow(input: SaveWorkflowInput): WorkflowRecord {
    const id = input.id.trim()
    const name = input.name.trim()
    if (!id) throw new Error('Workflow id is required.')
    if (!name) throw new Error('Workflow name is required.')
    const now = input.updatedAt ?? isoNow()
    const createdAt = input.createdAt ?? now
    this.database
      .prepare(
        `INSERT INTO workflows (id, name, version, definition_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           version = excluded.version,
           definition_json = excluded.definition_json,
           updated_at = excluded.updated_at`
      )
      .run(id, name, Math.max(1, Math.trunc(input.version ?? 1)), JSON.stringify(input.definition), createdAt, now)
    const workflow = this.getWorkflow(id)
    if (!workflow) throw new Error(`Workflow ${id} was not saved.`)
    return workflow
  }

  upsertWorkflow(input: SaveWorkflowInput): WorkflowRecord {
    return this.saveWorkflow(input)
  }

  getWorkflow(idOrName: string): WorkflowRecord | undefined {
    const value = idOrName.trim()
    if (!value) return undefined
    const row = this.database
      .prepare(
        `SELECT id, name, version, definition_json, created_at, updated_at
         FROM workflows WHERE id = ? OR name = ?
         ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END LIMIT 1`
      )
      .get(value, value, value) as WorkflowRow | undefined
    return row ? mapWorkflow(row) : undefined
  }

  listWorkflows(): WorkflowRecord[] {
    const rows = this.database
      .prepare('SELECT id, name, version, definition_json, created_at, updated_at FROM workflows ORDER BY name ASC, id ASC')
      .all() as WorkflowRow[]
    return rows.map(mapWorkflow)
  }

  getWorkflowStats(workflowId: string): WorkflowStatsRecord | undefined {
    const row = this.database
      .prepare('SELECT workflow_id, clean_runs, rejection_count, autonomy, promoted_at, demoted_at, updated_at FROM workflow_stats WHERE workflow_id = ?')
      .get(workflowId) as WorkflowStatsRow | undefined
    return row ? mapWorkflowStats(row) : undefined
  }

  ensureWorkflowStats(workflowId: string, autonomy: JobAutonomy = 'assisted'): WorkflowStatsRecord {
    const id = workflowId.trim()
    if (!id) throw new Error('Workflow id is required for stats.')
    const now = isoNow()
    this.database
      .prepare(
        `INSERT INTO workflow_stats (workflow_id, clean_runs, rejection_count, autonomy, updated_at)
         VALUES (?, 0, 0, ?, ?)
         ON CONFLICT(workflow_id) DO NOTHING`
      )
      .run(id, autonomy, now)
    const stats = this.getWorkflowStats(id)
    if (!stats) throw new Error(`Workflow stats for ${id} were not created.`)
    return stats
  }

  recordWorkflowCleanRun(workflowId: string): WorkflowStatsRecord {
    const existing = this.ensureWorkflowStats(workflowId)
    const cleanRuns = existing.cleanRuns + 1
    const promoted = cleanRuns >= 10 || existing.autonomy === 'auto'
    const now = isoNow()
    this.database
      .prepare(
        `UPDATE workflow_stats
         SET clean_runs = ?, autonomy = ?, promoted_at = CASE WHEN ? = 1 AND promoted_at IS NULL THEN ? ELSE promoted_at END,
             updated_at = ?
         WHERE workflow_id = ?`
      )
      .run(cleanRuns, promoted ? 'auto' : existing.autonomy, promoted ? 1 : 0, now, now, workflowId)
    const stats = this.getWorkflowStats(workflowId)
    if (!stats) throw new Error(`Workflow stats for ${workflowId} were not found.`)
    return stats
  }

  recordWorkflowRejection(workflowId: string): WorkflowStatsRecord {
    const existing = this.ensureWorkflowStats(workflowId)
    const now = isoNow()
    this.database
      .prepare(
        `UPDATE workflow_stats
         SET clean_runs = 0, rejection_count = ?, autonomy = 'assisted', demoted_at = ?, updated_at = ?
         WHERE workflow_id = ?`
      )
      .run(existing.rejectionCount + 1, now, now, workflowId)
    const stats = this.getWorkflowStats(workflowId)
    if (!stats) throw new Error(`Workflow stats for ${workflowId} were not found.`)
    return stats
  }

  listWorkflowStats(): WorkflowStatsRecord[] {
    const rows = this.database
      .prepare('SELECT workflow_id, clean_runs, rejection_count, autonomy, promoted_at, demoted_at, updated_at FROM workflow_stats ORDER BY workflow_id ASC')
      .all() as WorkflowStatsRow[]
    return rows.map(mapWorkflowStats)
  }

  deleteRecurringJob(id: string): boolean {
    return this.database.prepare('DELETE FROM recurring_jobs WHERE id = ?').run(id).changes > 0
  }

  saveRecurringJob(input: SaveRecurringJobInput): RecurringJobRecord {
    const id = input.id.trim()
    if (!id) throw new Error('Recurring job id is required.')
    const now = input.updatedAt ?? isoNow()
    this.database
      .prepare(
        `INSERT INTO recurring_jobs
          (id, name, workflow, every, next_run_at, last_run_at, autonomy, enabled, input_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, workflow = excluded.workflow, every = excluded.every,
           next_run_at = excluded.next_run_at, last_run_at = excluded.last_run_at,
           autonomy = excluded.autonomy, enabled = excluded.enabled, input_json = excluded.input_json,
           updated_at = excluded.updated_at`
      )
      .run(
        id,
        input.name.trim(),
        input.workflow.trim(),
        input.every.trim(),
        input.nextRunAt ?? null,
        input.lastRunAt ?? null,
        input.autonomy ?? 'assisted',
        input.enabled ? 1 : 0,
        jsonValue(input.input),
        input.createdAt ?? now,
        now
      )
    const recurring = this.getRecurringJob(id)
    if (!recurring) throw new Error(`Recurring job ${id} was not saved.`)
    return recurring
  }

  getRecurringJob(id: string): RecurringJobRecord | undefined {
    const row = this.database
      .prepare('SELECT id, name, workflow, every, next_run_at, last_run_at, autonomy, enabled, input_json, created_at, updated_at FROM recurring_jobs WHERE id = ?')
      .get(id) as RecurringJobRow | undefined
    return row ? mapRecurringJob(row) : undefined
  }

  listRecurringJobs(): RecurringJobRecord[] {
    const rows = this.database
      .prepare('SELECT id, name, workflow, every, next_run_at, last_run_at, autonomy, enabled, input_json, created_at, updated_at FROM recurring_jobs ORDER BY name ASC, id ASC')
      .all() as RecurringJobRow[]
    return rows.map(mapRecurringJob)
  }

  updateRecurringJob(id: string, update: UpdateRecurringJobInput): RecurringJobRecord | undefined {
    const values: Array<keyof UpdateRecurringJobInput> = [
      'name', 'workflow', 'every', 'nextRunAt', 'lastRunAt', 'autonomy', 'enabled', 'input', 'updatedAt'
    ]
    const columns: Record<keyof UpdateRecurringJobInput, string> = {
      name: 'name',
      workflow: 'workflow',
      every: 'every',
      nextRunAt: 'next_run_at',
      lastRunAt: 'last_run_at',
      autonomy: 'autonomy',
      enabled: 'enabled',
      input: 'input_json',
      updatedAt: 'updated_at'
    }
    const assignments: string[] = []
    const parameters: unknown[] = []
    for (const key of values) {
      if (update[key] === undefined) continue
      assignments.push(`${columns[key]} = ?`)
      parameters.push(key === 'input' ? jsonValue(update[key]) : key === 'enabled' ? (update[key] ? 1 : 0) : update[key])
    }
    if (assignments.length === 0) return this.getRecurringJob(id)
    parameters.push(id)
    const result = this.database
      .prepare(`UPDATE recurring_jobs SET ${assignments.join(', ')} WHERE id = ?`)
      .run(...parameters)
    return result.changes === 0 ? undefined : this.getRecurringJob(id)
  }

  recordRecurringRun(id: string, lastRunAt: string, nextRunAt: string | null): RecurringJobRecord | undefined {
    return this.updateRecurringJob(id, { lastRunAt, nextRunAt, updatedAt: isoNow() })
  }

  createPlan(input: CreatePlanInput): PlanRecord {
    const id = input.id.trim()
    if (!id) throw new Error('Plan id is required.')
    const briefMd = input.briefMd
    if (!briefMd.trim()) throw new Error('Plan brief is required.')
    this.database
      .prepare(
        `INSERT INTO plans
          (id, conversation_id, brief_md, plan_json, round, question_round, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.conversationId ?? null,
        briefMd,
        JSON.stringify(input.plan),
        Math.max(0, Math.trunc(input.round ?? 0)),
        Math.max(0, Math.trunc(input.questionRound ?? 0)),
        input.status ?? 'draft',
        input.createdAt ?? isoNow()
      )
    const plan = this.getPlan(id)
    if (!plan) throw new Error(`Plan ${id} was not created.`)
    return plan
  }

  updatePlan(id: string, update: UpdatePlanInput): PlanRecord | undefined {
    const columns: Array<[string, unknown]> = []
    const values: Array<keyof UpdatePlanInput> = [
      'conversationId',
      'briefMd',
      'plan',
      'round',
      'questionRound',
      'status'
    ]
    const columnNames: Record<keyof UpdatePlanInput, string> = {
      conversationId: 'conversation_id',
      briefMd: 'brief_md',
      plan: 'plan_json',
      round: 'round',
      questionRound: 'question_round',
      status: 'status'
    }
    for (const key of values) {
      if (update[key] === undefined) continue
      let value: unknown = update[key]
      if (key === 'plan') value = JSON.stringify(value)
      if (key === 'round' || key === 'questionRound') value = Math.max(0, Math.trunc(Number(value) || 0))
      columns.push([columnNames[key], value])
    }
    if (columns.length === 0) return this.getPlan(id)
    const setClause = columns.map(([column]) => `${column} = ?`).join(', ')
    const result = this.database
      .prepare(`UPDATE plans SET ${setClause} WHERE id = ?`)
      .run(...columns.map(([, value]) => value), id)
    return result.changes === 0 ? undefined : this.getPlan(id)
  }

  getPlan(id: string): PlanRecord | undefined {
    const row = this.database
      .prepare('SELECT id, conversation_id, brief_md, plan_json, round, question_round, status, created_at FROM plans WHERE id = ?')
      .get(id) as PlanRow | undefined
    return row ? mapPlan(row) : undefined
  }

  listPlans(limit = 100): PlanRecord[] {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)))
    const rows = this.database
      .prepare('SELECT id, conversation_id, brief_md, plan_json, round, question_round, status, created_at FROM plans ORDER BY created_at DESC LIMIT ?')
      .all(safeLimit) as PlanRow[]
    return rows.map(mapPlan)
  }

  approveJob(id: string, approvedBy = 'owner'): JobRecord | undefined {
    const job = this.getJob(id)
    if (!job) return undefined
    const approvedAt = isoNow()
    this.database
      .prepare(
        `UPDATE job_runs
         SET approved_by = ?, approved_at = ?,
             status = CASE WHEN status = 'needs_approval' THEN 'ok' ELSE status END
         WHERE id = ?`
      )
      .run(approvedBy.trim() || 'owner', approvedAt, id)
    return this.getJob(id)
  }

  checkpoint(): void {
    this.database.pragma('wal_checkpoint(TRUNCATE)')
  }

  close(): void {
    this.database.close()
  }
}

export { mapJob }

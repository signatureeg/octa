import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { DATABASE_BUSY_TIMEOUT_MS } from './busy-timeout'

/**
 * Workflow-first (owner rule, 2026-09-28): no request executes directly. Every ask — the Run
 * button, voice, a delegated task — becomes a request that shows the workflow, its steps, gates,
 * agent, model tier and company. It starts only when the owner approves it.
 */

export type RequestStatus = 'proposed' | 'started' | 'cancelled'
export type RequestSource = 'app' | 'voice' | 'task' | 'schedule'

export interface RequestStepPreview {
  id: string
  name: string
  who: string
  gate: 'none' | 'review' | 'approve'
}

export interface WorkRequest {
  id: string
  title: string
  company: string
  workflowId: string
  agentId: string | null
  agentName: string | null
  tier: string | null
  task: string
  taskId: string | null
  source: RequestSource
  steps: RequestStepPreview[]
  status: RequestStatus
  runId: string | null
  createdAt: string
  updatedAt: string
}

export interface NewWorkRequest {
  title: string
  company: string
  workflowId: string
  agentId?: string | null
  agentName?: string | null
  tier?: string | null
  task?: string
  taskId?: string | null
  source: RequestSource
  steps: RequestStepPreview[]
}

interface RequestRow {
  id: string
  title: string
  company: string
  workflow_id: string
  agent_id: string | null
  agent_name: string | null
  tier: string | null
  task: string
  task_id: string | null
  source: string
  steps_json: string
  status: string
  run_id: string | null
  created_at: string
  updated_at: string
}

export class RequestsRepository {
  private readonly database: Database.Database

  constructor(pathOrDatabase: string | Database.Database) {
    this.database = typeof pathOrDatabase === 'string' ? new Database(pathOrDatabase, { timeout: DATABASE_BUSY_TIMEOUT_MS }) : pathOrDatabase
    if (typeof pathOrDatabase === 'string') this.database.pragma('journal_mode = WAL')
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS work_requests (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        company TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        agent_id TEXT,
        agent_name TEXT,
        tier TEXT,
        task TEXT NOT NULL DEFAULT '',
        task_id TEXT,
        source TEXT NOT NULL,
        steps_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'proposed',
        run_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS work_requests_by_status ON work_requests (status, created_at);
    `)
  }

  close(): void {
    this.database.close()
  }

  private toRecord(row: RequestRow): WorkRequest {
    let steps: RequestStepPreview[] = []
    try {
      steps = JSON.parse(row.steps_json) as RequestStepPreview[]
    } catch {
      steps = []
    }
    return {
      id: row.id,
      title: row.title,
      company: row.company,
      workflowId: row.workflow_id,
      agentId: row.agent_id,
      agentName: row.agent_name,
      tier: row.tier,
      task: row.task,
      taskId: row.task_id,
      source: (['app', 'voice', 'task', 'schedule'] as const).includes(row.source as RequestSource) ? row.source as RequestSource : 'app',
      steps,
      status: row.status === 'started' || row.status === 'cancelled' ? row.status : 'proposed',
      runId: row.run_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }

  create(input: NewWorkRequest, now = new Date()): WorkRequest {
    const title = input.title.trim().slice(0, 300)
    if (!title) throw new Error('A request needs a title.')
    if (!input.steps.length) throw new Error('A request needs at least one workflow step.')
    const id = `req-${randomUUID()}`
    const stamp = now.toISOString()
    this.database.prepare(`
      INSERT INTO work_requests (id, title, company, workflow_id, agent_id, agent_name, tier, task, task_id, source, steps_json, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?)
    `).run(id, title, input.company, input.workflowId, input.agentId ?? null, input.agentName ?? null, input.tier ?? null, (input.task ?? '').slice(0, 8000), input.taskId ?? null, input.source, JSON.stringify(input.steps), stamp, stamp)
    return this.get(id)!
  }

  get(id: string): WorkRequest | null {
    const row = this.database.prepare('SELECT * FROM work_requests WHERE id = ?').get(id) as RequestRow | undefined
    return row ? this.toRecord(row) : null
  }

  list(status?: RequestStatus, limit = 50): WorkRequest[] {
    const rows = status
      ? this.database.prepare('SELECT * FROM work_requests WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit)
      : this.database.prepare('SELECT * FROM work_requests ORDER BY created_at DESC LIMIT ?').all(limit)
    return (rows as RequestRow[]).map((row) => this.toRecord(row))
  }

  /** Marks a proposed request as started; refuses anything else so a request can never start twice. */
  markStarted(id: string, runId: string, now = new Date()): WorkRequest {
    const result = this.database.prepare("UPDATE work_requests SET status = 'started', run_id = ?, updated_at = ? WHERE id = ? AND status = 'proposed'").run(runId, now.toISOString(), id)
    if (result.changes === 0) throw new Error(this.get(id) ? 'This request was already started or cancelled.' : 'Request not found.')
    return this.get(id)!
  }

  cancel(id: string, now = new Date()): WorkRequest {
    const result = this.database.prepare("UPDATE work_requests SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'proposed'").run(now.toISOString(), id)
    if (result.changes === 0) throw new Error(this.get(id) ? 'Only a proposed request can be cancelled.' : 'Request not found.')
    return this.get(id)!
  }
}

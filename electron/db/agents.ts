import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { DATABASE_BUSY_TIMEOUT_MS } from './busy-timeout'
import type { AgentOutcome, AgentRecord, AgentRunRecord, AgentSpec, AgentTrustStage, JobRecord, SubAgentSpec } from '../types'
import { applyOutcome, isTrustStage, stageAbove, validateAgentSpec, validateTeam } from '../core/octa/agents'
import { isModelTier } from '../core/octa/models'

interface AgentRow {
  id: string
  name: string
  identity: string
  scope: string
  definition_of_done: string
  skills_json: string
  tier: string
  trust_stage: string
  schedule: string | null
  status: string
  created_from: string | null
  created_at: string
  updated_at: string
  clean_streak: number
  runs: number
  clean_runs: number
  pending_promotion: string | null
  last_demotion_json: string | null
  department: string | null
  team_json: string | null
}

interface AgentRunRow {
  agent_id: string
  job_id: string
  started_at: string
  result: string
  reason: string | null
  task_id: string | null
}

export interface AgentUpdate {
  identity?: string
  scope?: string
  definitionOfDone?: string
  skills?: string[]
  tier?: AgentSpec['tier']
  schedule?: AgentSpec['schedule'] | null
  status?: AgentRecord['status']
  department?: string
  /** Replaces the whole team; an empty list removes it. */
  team?: SubAgentSpec[]
}

export type AgentRunSettled = (run: AgentRunRecord, outcome: AgentOutcome, agent: AgentRecord) => void

/** Stored teams are re-validated on read so a hand-edited row can never mount a broken specialist. */
function teamOf(row: AgentRow): SubAgentSpec[] {
  const parsed = parseJson<unknown>(row.team_json, [])
  return Array.isArray(parsed) && parsed.length ? validateTeam(parsed, []) : []
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

/** Maps a finished (or not yet finished) job to its effect on the trust ladder. */
export function outcomeForJob(job: Pick<JobRecord, 'status' | 'gate' | 'gateDecision' | 'gateComments' | 'error'> | null | undefined): AgentOutcome {
  if (!job) return { result: 'failed', reason: 'The run record is missing.' }
  const decision = (job.gateDecision ?? '').toLowerCase()
  if (decision === 'rejected' || decision === 'reject') return { result: 'rejected', reason: job.gateComments || 'Output rejected at the gate.' }
  if (job.status === 'failed' || job.status === 'cancelled' || job.status === 'stale') return { result: 'failed', reason: job.error || `Run ${job.status}.` }
  if (job.status === 'ok') {
    if (job.gate === 'approve' && decision !== 'approved' && decision !== 'approve') return { result: 'pending' }
    return { result: 'clean' }
  }
  return { result: 'pending' }
}

export class AgentsRepository {
  private readonly database: Database.Database

  constructor(pathOrDatabase: string | Database.Database) {
    this.database = typeof pathOrDatabase === 'string'
      ? new Database(pathOrDatabase, { timeout: DATABASE_BUSY_TIMEOUT_MS })
      : pathOrDatabase
    if (typeof pathOrDatabase === 'string') {
      this.database.pragma('journal_mode = WAL')
      this.database.pragma('synchronous = FULL')
    }
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        identity TEXT NOT NULL,
        scope TEXT NOT NULL,
        definition_of_done TEXT NOT NULL,
        skills_json TEXT NOT NULL DEFAULT '[]',
        tier TEXT NOT NULL DEFAULT 'executor',
        trust_stage TEXT NOT NULL DEFAULT 'draft-only',
        schedule TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_from TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        clean_streak INTEGER NOT NULL DEFAULT 0,
        runs INTEGER NOT NULL DEFAULT 0,
        clean_runs INTEGER NOT NULL DEFAULT 0,
        pending_promotion TEXT,
        last_demotion_json TEXT
      );
      CREATE TABLE IF NOT EXISTS agent_runs (
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        job_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        result TEXT NOT NULL DEFAULT 'pending',
        reason TEXT,
        PRIMARY KEY (agent_id, job_id)
      );
      CREATE INDEX IF NOT EXISTS agent_runs_by_agent ON agent_runs (agent_id, started_at);
    `)
    // Columns added after the first release of this table.
    const agentColumns = new Set((this.database.prepare('PRAGMA table_info(agents)').all() as Array<{ name: string }>).map((column) => column.name))
    if (!agentColumns.has('department')) this.database.exec("ALTER TABLE agents ADD COLUMN department TEXT NOT NULL DEFAULT 'general'")
    if (!agentColumns.has('team_json')) this.database.exec("ALTER TABLE agents ADD COLUMN team_json TEXT NOT NULL DEFAULT '[]'")
    const runColumns = new Set((this.database.prepare('PRAGMA table_info(agent_runs)').all() as Array<{ name: string }>).map((column) => column.name))
    if (!runColumns.has('task_id')) this.database.exec('ALTER TABLE agent_runs ADD COLUMN task_id TEXT')
  }

  close(): void {
    this.database.close()
  }

  private toRecord(row: AgentRow): AgentRecord {
    const pending = row.pending_promotion
    return {
      id: row.id,
      name: row.name,
      department: row.department || 'general',
      identity: row.identity,
      scope: row.scope,
      definitionOfDone: row.definition_of_done,
      skills: parseJson<string[]>(row.skills_json, []),
      tier: isModelTier(row.tier) ? row.tier : 'executor',
      trustStage: isTrustStage(row.trust_stage) ? row.trust_stage : 'draft-only',
      ...(row.schedule === 'daily' || row.schedule === 'weekly' || row.schedule === 'monthly' ? { schedule: row.schedule } : {}),
      status: row.status === 'paused' ? 'paused' : 'active',
      createdFrom: row.created_from,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      cleanStreak: row.clean_streak,
      runs: row.runs,
      cleanRuns: row.clean_runs,
      ...(teamOf(row).length ? { team: teamOf(row) } : {}),
      ...(pending && isTrustStage(pending) ? { pendingPromotion: pending } : {}),
      ...(row.last_demotion_json ? { lastDemotion: parseJson(row.last_demotion_json, undefined) } : {})
    }
  }

  list(): AgentRecord[] {
    return (this.database.prepare('SELECT * FROM agents ORDER BY created_at').all() as AgentRow[]).map((row) => this.toRecord(row))
  }

  get(id: string): AgentRecord | null {
    const row = this.database.prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow | undefined
    return row ? this.toRecord(row) : null
  }

  /** Creates an agent from a spec; throws with every validation error, or when the name is taken. */
  create(value: unknown, createdFrom: string | null = null, now = new Date()): AgentRecord {
    const checked = validateAgentSpec(value)
    if (!checked.valid || !checked.spec) throw new Error(`Invalid agent spec: ${checked.errors.join(' ')}`)
    const spec = checked.spec
    const existing = this.database.prepare('SELECT id FROM agents WHERE name = ? COLLATE NOCASE').get(spec.name) as { id: string } | undefined
    if (existing) throw new Error(`An agent named "${spec.name}" already exists.`)
    const id = `agent-${randomUUID()}`
    const stamp = now.toISOString()
    this.database.prepare(`
      INSERT INTO agents (id, name, identity, scope, definition_of_done, skills_json, tier, trust_stage, schedule, status, created_from, created_at, updated_at, department, team_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
    `).run(id, spec.name, spec.identity, spec.scope, spec.definitionOfDone, JSON.stringify(spec.skills), spec.tier, spec.trustStage, spec.schedule ?? null, createdFrom, stamp, stamp, spec.department ?? 'general', JSON.stringify(spec.team ?? []))
    return this.get(id)!
  }

  update(id: string, update: AgentUpdate, now = new Date()): AgentRecord {
    const current = this.get(id)
    if (!current) throw new Error(`Agent "${id}" was not found.`)
    const merged = {
      name: current.name,
      identity: update.identity ?? current.identity,
      scope: update.scope ?? current.scope,
      definitionOfDone: update.definitionOfDone ?? current.definitionOfDone,
      skills: update.skills ?? current.skills,
      tier: update.tier ?? current.tier,
      trustStage: current.trustStage,
      department: update.department ?? current.department,
      team: update.team ?? current.team ?? [],
      ...(update.schedule === null ? {} : update.schedule ?? current.schedule ? { schedule: update.schedule ?? current.schedule } : {})
    }
    const checked = validateAgentSpec(merged)
    if (!checked.valid || !checked.spec) throw new Error(`Invalid agent update: ${checked.errors.join(' ')}`)
    const spec = checked.spec
    const status = update.status === 'paused' || update.status === 'active' ? update.status : current.status
    this.database.prepare(`
      UPDATE agents SET identity = ?, scope = ?, definition_of_done = ?, skills_json = ?, tier = ?, schedule = ?, status = ?, department = ?, team_json = ?, updated_at = ? WHERE id = ?
    `).run(spec.identity, spec.scope, spec.definitionOfDone, JSON.stringify(spec.skills), spec.tier, spec.schedule ?? null, status, spec.department ?? 'general', JSON.stringify(spec.team ?? []), now.toISOString(), id)
    return this.get(id)!
  }

  /** The owner sets a stage directly (always allowed, including moving down). */
  setTrustStage(id: string, stage: AgentTrustStage, now = new Date()): AgentRecord {
    if (!isTrustStage(stage)) throw new Error('Unknown trust stage.')
    const result = this.database.prepare('UPDATE agents SET trust_stage = ?, pending_promotion = NULL, clean_streak = 0, updated_at = ? WHERE id = ?').run(stage, now.toISOString(), id)
    if (result.changes === 0) throw new Error(`Agent "${id}" was not found.`)
    return this.get(id)!
  }

  /** Removes an agent and its run history (the owner's request). Returns false when it did not exist. */
  remove(id: string): boolean {
    const removed = this.database.transaction(() => {
      this.database.prepare('DELETE FROM agent_runs WHERE agent_id = ?').run(id)
      return this.database.prepare('DELETE FROM agents WHERE id = ?').run(id).changes > 0
    })
    return removed()
  }

  approvePromotion(id: string, now = new Date()): AgentRecord {
    const agent = this.get(id)
    if (!agent) throw new Error(`Agent "${id}" was not found.`)
    if (!agent.pendingPromotion) throw new Error('There is no promotion waiting for approval.')
    return this.setTrustStage(id, agent.pendingPromotion, now)
  }

  dismissPromotion(id: string, now = new Date()): AgentRecord {
    // Dismissing restarts the streak so Octa does not ask again on the very next clean run.
    this.database.prepare('UPDATE agents SET pending_promotion = NULL, clean_streak = 0, updated_at = ? WHERE id = ?').run(now.toISOString(), id)
    const agent = this.get(id)
    if (!agent) throw new Error(`Agent "${id}" was not found.`)
    return agent
  }

  recordRun(agentId: string, jobId: string, now = new Date(), taskId?: string): void {
    this.database.prepare('INSERT OR IGNORE INTO agent_runs (agent_id, job_id, started_at, task_id) VALUES (?, ?, ?, ?)').run(agentId, jobId, now.toISOString(), taskId ?? null)
    this.database.prepare('UPDATE agents SET runs = runs + 1, updated_at = ? WHERE id = ?').run(now.toISOString(), agentId)
  }

  runs(agentId: string, limit = 20): AgentRunRecord[] {
    return (this.database.prepare('SELECT * FROM agent_runs WHERE agent_id = ? ORDER BY started_at DESC LIMIT ?').all(agentId, limit) as AgentRunRow[])
      .map((row) => this.toRun(row))
  }

  private toRun(row: AgentRunRow): AgentRunRecord {
    return { agentId: row.agent_id, jobId: row.job_id, startedAt: row.started_at, result: row.result as AgentRunRecord['result'], ...(row.reason ? { reason: row.reason } : {}), ...(row.task_id ? { taskId: row.task_id } : {}) }
  }

  /**
   * Settles pending runs against their job records, oldest first, and moves each agent on the
   * trust ladder. Pull-based on purpose: it runs whenever agents are listed, so it also catches
   * runs that finished while the app was closed.
   */
  syncOutcomes(lookup: (jobId: string) => Pick<JobRecord, 'status' | 'gate' | 'gateDecision' | 'gateComments' | 'error'> | null | undefined, now = new Date(), onSettled?: AgentRunSettled): void {
    const pending = this.database.prepare("SELECT * FROM agent_runs WHERE result = 'pending' ORDER BY started_at").all() as AgentRunRow[]
    const settle = this.database.transaction(() => {
      for (const run of pending) {
        const outcome = outcomeForJob(lookup(run.job_id))
        if (outcome.result === 'pending') continue
        const agent = this.get(run.agent_id)
        if (!agent) continue
        const decision = applyOutcome(agent, outcome)
        const stamp = now.toISOString()
        this.database.prepare('UPDATE agent_runs SET result = ?, reason = ? WHERE agent_id = ? AND job_id = ?').run(outcome.result, outcome.reason ?? null, run.agent_id, run.job_id)
        const demotion = decision.demotedBecause && decision.trustStage !== agent.trustStage
          ? JSON.stringify({ at: stamp, from: agent.trustStage, to: decision.trustStage, reason: decision.demotedBecause })
          : null
        this.database.prepare(`
          UPDATE agents SET trust_stage = ?, clean_streak = ?, pending_promotion = ?, clean_runs = clean_runs + ?,
            last_demotion_json = COALESCE(?, last_demotion_json), updated_at = ? WHERE id = ?
        `).run(
          decision.trustStage,
          decision.cleanStreak,
          decision.demotedBecause ? null : decision.pendingPromotion ?? null,
          outcome.result === 'clean' ? 1 : 0,
          demotion,
          stamp,
          agent.id
        )
        settled.push([this.toRun({ ...run, result: outcome.result, reason: outcome.reason ?? null }), outcome, this.get(agent.id) ?? agent])
      }
    })
    const settled: Array<[AgentRunRecord, AgentOutcome, AgentRecord]> = []
    settle()
    // Callbacks run after the transaction so they can touch other tables (tasks) safely.
    for (const [run, outcome, agent] of settled) onSettled?.(run, outcome, agent)
  }

  /** Next stage up, for UI copy ("promote to …"). */
  nextStage(stage: AgentTrustStage): AgentTrustStage | undefined {
    return stageAbove(stage)
  }
}

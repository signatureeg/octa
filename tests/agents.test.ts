import { afterEach, describe, expect, it } from 'vitest'
import { AgentsRepository, outcomeForJob } from '../electron/db/agents'
import { agentPrompt, applyOutcome, PROMOTION_STREAK, runPolicy, validateAgentSpec } from '../electron/core/octa/agents'
import type { JobRecord } from '../electron/types'

let repository: AgentsRepository | undefined

afterEach(() => {
  repository?.close()
  repository = undefined
})

const spec = {
  name: 'Lead replier',
  identity: 'You draft first replies to new real-estate leads in Egyptian Arabic.',
  scope: 'Draft a first reply for each new lead. Nothing else.',
  definitionOfDone: 'One draft per lead in out/replies.md, under 80 words, with one question.',
  skills: ['copywriting', 'copywriting', ' '],
  tier: 'executor-fast',
  trustStage: 'approve-each'
}

function job(overrides: Partial<JobRecord>): JobRecord {
  return { status: 'ok', gate: 'none', gateDecision: null, gateComments: null, error: null, ...overrides } as JobRecord
}

describe('agent spec', () => {
  it('validates and cleans a spec', () => {
    const checked = validateAgentSpec(spec)
    expect(checked.valid).toBe(true)
    expect(checked.spec).toMatchObject({ name: 'Lead replier', skills: ['copywriting'], tier: 'executor-fast', trustStage: 'approve-each' })
  })

  it('reports every missing field', () => {
    const checked = validateAgentSpec({ name: '', tier: 'genius', trustStage: 'god-mode', schedule: 'hourly' })
    expect(checked.valid).toBe(false)
    expect(checked.errors.join(' ')).toMatch(/name.*identity.*scope.*definitionOfDone.*tier.*trustStage.*schedule/s)
  })

  it('never lets a new agent start at auto', () => {
    expect(validateAgentSpec({ ...spec, trustStage: 'auto' }).spec?.trustStage).toBe('approve-each')
    expect(validateAgentSpec({ ...spec, trustStage: undefined }).spec?.trustStage).toBe('draft-only')
  })

  it('maps trust stages to gates, keeping a gate below auto', () => {
    expect(runPolicy('draft-only')).toEqual({ gate: 'review', autonomy: 'led' })
    expect(runPolicy('approve-each')).toEqual({ gate: 'approve', autonomy: 'assisted' })
    expect(runPolicy('auto')).toEqual({ gate: 'none', autonomy: 'auto' })
  })

  it('builds a scoped prompt that forbids outward actions', () => {
    const prompt = agentPrompt({ name: 'A', identity: 'I', scope: 'S', definitionOfDone: 'D' }, 'Do X', 'signature')
    expect(prompt.indexOf('## Role')).toBeLessThan(prompt.indexOf('## Context'))
    expect(prompt.indexOf('## Context')).toBeLessThan(prompt.indexOf('## Command'))
    expect(prompt.indexOf('## Command')).toBeLessThan(prompt.indexOf('## Format'))
    expect(prompt).toContain('Company: signature')
    expect(prompt).toContain('Your standing job (stay inside it): S')
    expect(prompt).toContain('never send, publish, pay or delete anything')
    expect(prompt).toContain('give 3 options')
    expect(prompt).toContain('3-point QA')
  })
})

describe('trust ladder', () => {
  it('proposes a promotion after the clean streak but does not apply it', () => {
    let agent = { trustStage: 'draft-only' as const, cleanStreak: 0, pendingPromotion: undefined as undefined | 'approve-each' | 'auto' }
    for (let run = 1; run < PROMOTION_STREAK; run++) {
      const decision = applyOutcome(agent, { result: 'clean' })
      expect(decision.pendingPromotion).toBeUndefined()
      agent = { ...agent, cleanStreak: decision.cleanStreak }
    }
    const tenth = applyOutcome(agent, { result: 'clean' })
    expect(tenth).toEqual({ trustStage: 'draft-only', cleanStreak: PROMOTION_STREAK, pendingPromotion: 'approve-each' })
  })

  it('demotes one stage on a rejection and resets the streak', () => {
    expect(applyOutcome({ trustStage: 'auto', cleanStreak: 7 }, { result: 'rejected', reason: 'Wrong tone' }))
      .toEqual({ trustStage: 'approve-each', cleanStreak: 0, demotedBecause: 'Wrong tone' })
    expect(applyOutcome({ trustStage: 'draft-only', cleanStreak: 3 }, { result: 'failed' }).trustStage).toBe('draft-only')
  })

  it('maps job records to outcomes', () => {
    expect(outcomeForJob(job({ status: 'ok' })).result).toBe('clean')
    expect(outcomeForJob(job({ status: 'ok', gate: 'approve' })).result).toBe('pending')
    expect(outcomeForJob(job({ status: 'ok', gate: 'approve', gateDecision: 'approved' })).result).toBe('clean')
    expect(outcomeForJob(job({ status: 'needs_approval', gate: 'approve', gateDecision: 'rejected', gateComments: 'Too long' }))).toEqual({ result: 'rejected', reason: 'Too long' })
    expect(outcomeForJob(job({ status: 'failed', error: 'API Error: 401' }))).toEqual({ result: 'failed', reason: 'API Error: 401' })
    expect(outcomeForJob(job({ status: 'running' })).result).toBe('pending')
  })
})

describe('agents repository', () => {
  it('creates agents, refuses duplicates, and settles runs onto the ladder', () => {
    repository = new AgentsRepository(':memory:')
    const agent = repository.create({ ...spec, trustStage: 'draft-only' }, 'W7-run-1')
    expect(agent).toMatchObject({ name: 'Lead replier', trustStage: 'draft-only', createdFrom: 'W7-run-1', status: 'active', runs: 0 })
    expect(() => repository!.create(spec)).toThrow(/already exists/)
    expect(() => repository!.create({ name: 'x' })).toThrow(/Invalid agent spec/)

    const jobs = new Map<string, JobRecord>()
    for (let run = 0; run < PROMOTION_STREAK; run++) {
      repository.recordRun(agent.id, `job-${run}`, new Date(Date.UTC(2026, 8, 28, 10, run)))
      jobs.set(`job-${run}`, job({ status: 'ok' }))
    }
    repository.syncOutcomes((id) => jobs.get(id))
    const promoted = repository.get(agent.id)!
    expect(promoted).toMatchObject({ trustStage: 'draft-only', cleanStreak: PROMOTION_STREAK, pendingPromotion: 'approve-each', runs: PROMOTION_STREAK, cleanRuns: PROMOTION_STREAK })

    expect(repository.approvePromotion(agent.id)).toMatchObject({ trustStage: 'approve-each', cleanStreak: 0 })
    expect(repository.get(agent.id)?.pendingPromotion).toBeUndefined()

    repository.recordRun(agent.id, 'job-bad', new Date(Date.UTC(2026, 8, 28, 11)))
    jobs.set('job-bad', job({ status: 'needs_approval', gate: 'approve', gateDecision: 'rejected', gateComments: 'Too pushy' }))
    repository.syncOutcomes((id) => jobs.get(id))
    const demoted = repository.get(agent.id)!
    expect(demoted.trustStage).toBe('draft-only')
    expect(demoted.lastDemotion).toMatchObject({ from: 'approve-each', to: 'draft-only', reason: 'Too pushy' })
    expect(repository.runs(agent.id, 1)[0]).toMatchObject({ jobId: 'job-bad', result: 'rejected' })
  })

  it('leaves still-running runs pending and lets the owner pause and edit', () => {
    repository = new AgentsRepository(':memory:')
    const agent = repository.create(spec)
    repository.recordRun(agent.id, 'job-live')
    repository.syncOutcomes(() => job({ status: 'running' }))
    expect(repository.runs(agent.id)[0].result).toBe('pending')
    const edited = repository.update(agent.id, { status: 'paused', scope: 'Only Facebook leads.' })
    expect(edited).toMatchObject({ status: 'paused', scope: 'Only Facebook leads.' })
    expect(() => repository!.update(agent.id, { tier: 'genius' as never })).toThrow(/Invalid agent update/)
  })
})

describe('departments, delegation and scheduling', () => {
  it('adds the new columns to an existing agents table without losing rows', async () => {
    const Database = (await import('better-sqlite3')).default
    const database = new Database(':memory:')
    database.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, identity TEXT NOT NULL, scope TEXT NOT NULL,
      definition_of_done TEXT NOT NULL, skills_json TEXT NOT NULL DEFAULT '[]', tier TEXT NOT NULL DEFAULT 'executor', trust_stage TEXT NOT NULL DEFAULT 'draft-only',
      schedule TEXT, status TEXT NOT NULL DEFAULT 'active', created_from TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, clean_streak INTEGER NOT NULL DEFAULT 0,
      runs INTEGER NOT NULL DEFAULT 0, clean_runs INTEGER NOT NULL DEFAULT 0, pending_promotion TEXT, last_demotion_json TEXT);
      CREATE TABLE agent_runs (agent_id TEXT NOT NULL, job_id TEXT NOT NULL, started_at TEXT NOT NULL, result TEXT NOT NULL DEFAULT 'pending', reason TEXT, PRIMARY KEY (agent_id, job_id));
      INSERT INTO agents (id, name, identity, scope, definition_of_done, created_at, updated_at) VALUES ('a-old', 'Old agent', 'i', 's', 'd', '2026-09-28', '2026-09-28');`)
    repository = new AgentsRepository(database)
    expect(repository.get('a-old')).toMatchObject({ name: 'Old agent', department: 'general' })
    repository.recordRun('a-old', 'j1', new Date(), 'task-1')
    expect(repository.runs('a-old')[0]).toMatchObject({ jobId: 'j1', taskId: 'task-1' })
  })

  it('keeps the department and reports settled delegated runs', () => {
    repository = new AgentsRepository(':memory:')
    const agent = repository.create({ ...spec, department: 'Marketing Team' })
    expect(agent.department).toBe('marketing-team')
    repository.recordRun(agent.id, 'job-t', new Date(), 'task-9')
    const settled: Array<[string | undefined, string]> = []
    repository.syncOutcomes(() => job({ status: 'ok' }), new Date(), (run, outcome) => settled.push([run.taskId, outcome.result]))
    expect(settled).toEqual([['task-9', 'clean']])
    // already settled runs are not reported twice
    repository.syncOutcomes(() => job({ status: 'ok' }), new Date(), (run, outcome) => settled.push([run.taskId, outcome.result]))
    expect(settled).toHaveLength(1)
  })

  it('the recurring scheduler starts scheduled agents directly', async () => {
    const { JobsRepository } = await import('../electron/db/jobs')
    const { RecurringScheduler } = await import('../electron/core/octa/workflows')
    const jobs = new JobsRepository(':memory:')
    jobs.saveRecurringJob({ id: 'agent-a1', name: 'Agent: A', workflow: 'agent:a1', every: 'daily', nextRunAt: '2026-09-28T00:00:00.000Z', lastRunAt: null, autonomy: 'assisted', enabled: true, input: {} })
    const started: string[] = []
    const scheduler = new RecurringScheduler({ jobs, workflows: {} as never, runAgent: (id) => started.push(id), now: () => new Date('2026-09-28T09:00:00.000Z') })
    await scheduler.tick()
    expect(started).toEqual(['a1'])
    expect(Date.parse(jobs.getRecurringJob('agent-a1')!.nextRunAt!)).toBeGreaterThan(Date.parse('2026-09-28T09:00:00.000Z'))
    jobs.close()
  })
})

describe('agent names', () => {
  it('accepts Arabic names with tashkeel and parentheses', () => {
    for (const name of ['مسوّق الأداء', 'مدير البراند الشخصي (بيدو)', 'مراجع SEO والبحث بالذكاء الاصطناعي']) {
      expect(validateAgentSpec({ ...spec, name }).valid, name).toBe(true)
    }
    expect(validateAgentSpec({ ...spec, name: '<script>' }).valid).toBe(false)
  })
})

describe('owner pause switch', () => {
  it('starts nothing while paused and runs the due job once resumed', async () => {
    const { JobsRepository } = await import('../electron/db/jobs')
    const { RecurringScheduler } = await import('../electron/core/octa/workflows')
    const jobs = new JobsRepository(':memory:')
    jobs.saveRecurringJob({ id: 'agent-a1', name: 'Agent: A', workflow: 'agent:a1', every: 'daily', nextRunAt: '2026-09-28T00:00:00.000Z', lastRunAt: null, autonomy: 'assisted', enabled: true, input: {} })
    let paused = true
    const started: string[] = []
    const scheduler = new RecurringScheduler({ jobs, workflows: {} as never, runAgent: (id) => started.push(id), isPaused: () => paused, now: () => new Date('2026-09-28T09:00:00.000Z') })
    expect(await scheduler.tick()).toEqual([])
    expect(started).toEqual([])
    paused = false
    await scheduler.tick()
    expect(started).toEqual(['a1'])
    jobs.close()
  })
})

describe('removing an agent', () => {
  it('deletes the agent and its runs', () => {
    repository = new AgentsRepository(':memory:')
    const agent = repository.create(spec)
    repository.recordRun(agent.id, 'run-1')
    expect(repository.remove(agent.id)).toBe(true)
    expect(repository.get(agent.id)).toBeNull()
    expect(repository.runs(agent.id)).toEqual([])
    expect(repository.remove(agent.id)).toBe(false)
  })
})

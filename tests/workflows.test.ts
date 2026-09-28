import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  DEFAULT_RECURRING_JOBS,
  LAUNCH_WORKFLOWS,
  WorkflowRunner,
  interpolateTemplate,
  seedRecurringJobs,
  validateWorkflow,
  type WorkflowDefinition,
  type WorkflowStepRunRequest
} from '../electron/core/octa/workflows'
import { JobsRepository } from '../electron/db/jobs'

let repository: JobsRepository | undefined
let temporaryDirectory: string | undefined
let runners: WorkflowRunner[] = []

afterEach(async () => {
  await Promise.all(runners.map((runner) => runner.close()))
  runners = []
  repository?.close()
  repository = undefined
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = undefined
})

function workspace(): string {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'octa-workflows-'))
  return temporaryDirectory
}

function definition(name: string, steps: WorkflowDefinition['steps']): WorkflowDefinition {
  return { id: name, name, version: 1, acceptance: ['The workflow completes.'], steps }
}

function step(id: string, needs: string[] = [], gate: 'none' | 'review' | 'approve' = 'none'): WorkflowDefinition['steps'][number] {
  return {
    id,
    name: id,
    needs,
    runner: 'codex-exec',
    prompt: `Produce ${id}`,
    gate,
    autonomy: 'assisted',
    acceptance: [`${id} is complete.`]
  }
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 1_500): Promise<T> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = read()
    if (value !== undefined) return value
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Timed out waiting for workflow state.')
}

function fakeWorkflowRunner(
  callback: (request: WorkflowStepRunRequest) => Promise<unknown> | unknown,
  review: (request: unknown) => Promise<unknown> | unknown = async () => ({ verdict: 'pass', issues: [] })
): WorkflowRunner {
  repository ??= new JobsRepository(':memory:')
  const runner = new WorkflowRunner({
    jobs: repository,
    homePath: workspace(),
    stepRunner: callback,
    reviewStep: review as never
  })
  runners.push(runner)
  return runner
}

describe('workflow definitions and interpolation', () => {
  it('validates all launch seeds (W1-W9) and persists the recurring defaults', () => {
    expect(LAUNCH_WORKFLOWS.map((workflow) => workflow.id)).toEqual(['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'W9'])
    for (const workflow of LAUNCH_WORKFLOWS) {
      const result = validateWorkflow(workflow)
      expect(result.valid, `${workflow.id}: ${result.errors.join(' ')}`).toBe(true)
      expect(result.definition?.steps.length).toBeGreaterThan(0)
    }

    repository = new JobsRepository(':memory:')
    const jobs = seedRecurringJobs(repository, () => new Date('2026-09-08T07:00:00.000Z'))
    expect(jobs).toHaveLength(DEFAULT_RECURRING_JOBS.length)
    expect(jobs.every((job) => job.autonomy === 'assisted')).toBe(true)
    expect(jobs.find((job) => job.id === 'daily-brief')?.enabled).toBe(true)
    expect(jobs.every((job) => job.enabled)).toBe(true)
  })

  it('interpolates brief and prior step output while preserving exact values', () => {
    const context = { brief: { topic: 'workflow runner', count: 2 }, steps: { s1: { answer: 'done' } } }
    expect(interpolateTemplate({
      text: 'Research {{brief.topic}}',
      count: '{{brief.count}}',
      prior: '{{steps.s1.answer}}'
    }, context)).toEqual({ text: 'Research workflow runner', count: 2, prior: 'done' })
    expect(interpolateTemplate({
      exact: '{{steps.s1.out}}',
      nested: '{{steps.s1.out.answer}}'
    }, context)).toEqual({ exact: { answer: 'done' }, nested: 'done' })
  })
})

describe('workflow DAG execution', () => {
  it('runs independent steps in parallel and respects needs with a three-worker ceiling', async () => {
    const started: string[] = []
    let active = 0
    let maximumActive = 0
    const inputs: Record<string, unknown> = {}
    const workflow = definition('dag-test', [
      { ...step('s1'), input: { value: 'one' } },
      { ...step('s2'), input: { value: 'two' } },
      { ...step('s3', ['s1', 's2']), input: { from: '{{steps.s1}}', topic: '{{brief.topic}}' } },
      { ...step('s4', ['s1']), input: { from: '{{steps.s1}}' } }
    ])
    const runner = fakeWorkflowRunner(async (request) => {
      started.push(request.step.id)
      inputs[request.step.id] = request.input
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await new Promise<void>((resolve) => setTimeout(resolve, 25))
      active -= 1
      return { output: request.step.id === 's1' ? { answer: 'one' } : request.step.id }
    })
    runner.saveAsWorkflow(workflow.name, workflow)

    const result = await runner.start('dag-test', { topic: 'DAGs' }).promise
    expect(result.status).toBe('ok')
    expect(maximumActive).toBeGreaterThan(1)
    expect(maximumActive).toBeLessThanOrEqual(3)
    expect(started.indexOf('s3')).toBeGreaterThan(started.indexOf('s1'))
    expect(started.indexOf('s3')).toBeGreaterThan(started.indexOf('s2'))
    expect(inputs.s3).toEqual({ from: { answer: 'one' }, topic: 'DAGs' })
    expect(inputs.s4).toEqual({ from: { answer: 'one' } })
  })
})

describe('workflow gates and recovery', () => {
  it('blocks on an approve gate and requires the exact payload', async () => {
    const runner = fakeWorkflowRunner(async () => ({ output: { decision: 'ship' } }))
    const workflow = definition('approve-test', [{ ...step('s1', [], 'approve'), gatePayload: { decision: 'ship' } }])
    runner.saveAsWorkflow(workflow.name, workflow)
    const handle = runner.start('approve-test', { text: 'Approve this' })
    const pending = await waitFor(() => runner.getRun(handle.runId)?.currentGate)
    expect(pending.payload).toBe(JSON.stringify({ decision: 'ship' }, null, 2))
    expect(runner.getRun(handle.runId)?.status).toBe('waiting_gate')
    await expect(runner.approveGate({ runId: handle.runId, payload: '{}', stepId: 's1' })).rejects.toThrow('exact pending payload')
    await runner.approveGate({ runId: handle.runId, payload: pending.payload, stepId: 's1' })
    expect((await handle.promise).status).toBe('ok')
  })

  it('marks an unattended gate stale after 24 hours', async () => {
    let current = new Date('2026-09-08T08:00:00.000Z')
    repository = new JobsRepository(':memory:')
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'octa-expiry-'))
    const runner = new WorkflowRunner({
      jobs: repository,
      homePath: temporaryDirectory,
      now: () => new Date(current),
      stepRunner: async () => ({ output: 'payload' }),
      reviewStep: async () => ({ verdict: 'pass', issues: [] }) as never
    })
    runners.push(runner)
    const workflow = definition('expiry-test', [{ ...step('s1', [], 'approve') }])
    runner.saveAsWorkflow(workflow.name, workflow)
    const handle = runner.start('expiry-test', { text: 'Expire this' })
    await waitFor(() => runner.getRun(handle.runId)?.currentGate)
    current = new Date(current.getTime() + 25 * 60 * 60 * 1_000)
    expect(runner.getRun(handle.runId)?.status).toBe('stale')
    expect((await handle.promise).status).toBe('stale')
  })

  it('resumes a persisted run from the last unfinished step after a crash', async () => {
    repository = new JobsRepository(':memory:')
    const homePath = workspace()
    const folder = join(homePath, 'jobs', 'crashed-run')
    mkdirSync(folder, { recursive: true })
    const workflow = definition('resume-test', [step('s1'), step('s2', ['s1'])])
    const now = new Date().toISOString()
    repository.createJob({
      id: 'crashed-run',
      workflowRunId: 'crashed-run',
      workflow: workflow.name,
      runner: 'workflow',
      status: 'running',
      input: { text: 'resume' },
      state: {
        version: 1,
        workflowId: workflow.id,
        workflow: workflow.name,
        folder,
        brief: { text: 'resume' },
        status: 'running',
        steps: {
          s1: { id: 's1', status: 'completed', attempt: 1, reviewAttempts: 1, reviewRetries: 0, output: 'finished' },
          s2: { id: 's2', status: 'running', attempt: 1, reviewAttempts: 0, reviewRetries: 0 }
        },
        createdAt: now,
        updatedAt: now,
        hadRejection: false,
        hadReviewComments: false,
        statsRecorded: false
      }
    })
    const executed: string[] = []
    const runner = new WorkflowRunner({
      jobs: repository,
      homePath,
      stepRunner: async (request: WorkflowStepRunRequest) => {
        executed.push(request.step.id)
        return { output: `${request.step.id}-resumed` }
      },
      reviewStep: async () => ({ verdict: 'pass', issues: [] }) as never
    })
    runners.push(runner)
    runner.saveAsWorkflow(workflow.name, workflow)
    const result = await runner.resume('crashed-run').promise
    expect(result.status).toBe('ok')
    expect(executed).toEqual(['s2'])
    expect(result.steps.find((item) => item.id === 's1')?.output).toBe('finished')
  })
})

describe('workflow autonomy counters', () => {
  it('promotes after ten clean runs and demotes on rejection', async () => {
    repository = new JobsRepository(':memory:')
    const runner = fakeWorkflowRunner(async () => ({ output: 'clean' }))
    const workflow = definition('stats-test', [{ ...step('s1', [], 'approve') }])
    runner.saveAsWorkflow(workflow.name, workflow)
    for (let index = 0; index < 10; index += 1) {
      const handle = runner.start('stats-test', { index })
      const gate = await waitFor(() => runner.getRun(handle.runId)?.currentGate)
      await runner.approveGate({ runId: handle.runId, stepId: 's1', payload: gate.payload })
      await handle.promise
    }
    expect(runner.getStats('stats-test')).toMatchObject({ cleanRuns: 10, autonomy: 'auto' })

    const rejected = runner.start('stats-test', { index: 11 })
    const gate = await waitFor(() => runner.getRun(rejected.runId)?.currentGate)
    await runner.rejectGate({ runId: rejected.runId, stepId: 's1', payload: gate.payload, reason: 'Needs another pass.' })
    await rejected.promise
    expect(runner.getStats('stats-test')).toMatchObject({ cleanRuns: 0, rejectionCount: 1, autonomy: 'assisted' })
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import { spawn as nodeSpawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  classifyCliFailure,
  DEFAULT_PHASE_MODELS,
  modelsInUse,
  resolveTier,
  setPhaseModels,
  tierForRunner
} from '../electron/core/octa/models'
import { buildClaudePlanArgv, buildCodexExecArgv, JobRunner } from '../electron/core/jobs/runner'
import { validatePlan } from '../electron/core/octa/planner'
import { validateWorkflow } from '../electron/core/octa/workflows'
import { JobsRepository } from '../electron/db/jobs'
import { DEFAULT_SETTINGS, type AppSettings } from '../electron/types'

let temporaryDirectory: string | undefined
let repository: JobsRepository | undefined

afterEach(() => {
  setPhaseModels(DEFAULT_PHASE_MODELS)
  repository?.close()
  repository = undefined
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = undefined
})

describe('tiers on top of the phase table (Settings → Models)', () => {
  it('maps each tier to its phase, with the manager falling back to Sonnet', () => {
    expect(resolveTier('manager')).toMatchObject({ cli: 'claude', model: 'claude-fable-5-1', effort: 'medium', fallbackModel: 'claude-sonnet-5' })
    expect(resolveTier('executor')).toMatchObject({ cli: 'codex', model: 'gpt-5.6-luna', effort: 'max' })
    expect(resolveTier('executor-fast')).toMatchObject({ cli: 'codex', model: 'gpt-5.6-luna', effort: 'low' })
    expect(resolveTier('critic').model).toBe('gpt-6-astra')
    expect(resolveTier('reviewer').model).toBe('gpt-5.6-sol')
    expect(resolveTier('claude-tools').model).toBe('claude-sonnet-5')
  })

  it('follows the phase table when the owner changes a model, and a job can still carry its own', () => {
    setPhaseModels({ ...DEFAULT_PHASE_MODELS, code: { model: 'gpt-5.5', effort: 'high' }, plan: { model: 'claude-opus-5-5', effort: 'high' } })
    expect(resolveTier('executor')).toMatchObject({ model: 'gpt-5.5', effort: 'high' })
    expect(buildClaudePlanArgv({ workspace: 'C:\w' })).toEqual(expect.arrayContaining(['--model', 'claude-opus-5-5', '--effort', 'high']))
    const argv = buildCodexExecArgv({ workspace: 'C:\w', model: { model: 'gpt-mini', effort: 'low' } })
    expect(argv.slice(argv.indexOf('-m'), argv.indexOf('-m') + 4)).toEqual(['-m', 'gpt-mini', '-c', 'model_reasoning_effort="low"'])
  })

  it('only honours a requested tier on the same CLI as the runner', () => {
    expect(tierForRunner('codex-exec')).toBe('executor')
    expect(tierForRunner('codex-exec', 'executor-fast')).toBe('executor-fast')
    expect(tierForRunner('codex-exec', 'manager')).toBe('executor')
    expect(tierForRunner('claude-plan', 'claude-tools')).toBe('claude-tools')
    expect(tierForRunner('gemini-inline', 'manager')).toBeUndefined()
  })

  it('lists each distinct model once for the health check', () => {
    const inUse = modelsInUse()
    expect(inUse.find((entry) => entry.model === 'gpt-5.6-luna')?.phases).toEqual(['code', 'analysis'])
    expect(inUse).toHaveLength(5)
  })

  it('no runner source file hard-codes a model id', () => {
    const sources = ['electron/core/jobs/runner.ts', 'electron/core/octa/review.ts', 'electron/core/octa/build/analysis.ts']
      .map((path) => readFileSync(join(process.cwd(), path), 'utf8'))
    for (const source of sources) expect(source).not.toMatch(/claude-fable|claude-sonnet|gpt-5\.6|gpt-6-/)
  })
})

describe('CLI failure classification', () => {
  it('recognises the real failures seen on 24 Sep', () => {
    expect(classifyCliFailure('Failed to authenticate. API Error: 401 OAuth access token is invalid.')?.kind).toBe('auth')
    expect(classifyCliFailure("API Error: 400 Claude Code 2.1.149 does not support this model; version 2.1.251 or newer is required. Run 'claude update'")?.kind).toBe('cli_outdated')
    expect(classifyCliFailure('error: model gpt-9 does not exist')?.kind).toBe('model_unavailable')
    expect(classifyCliFailure('429 Too Many Requests: rate limit reached')?.kind).toBe('rate_limit')
    expect(classifyCliFailure('Process exited with code 1.')).toBeUndefined()
  })
})

function fakeCli(script: string): (command: string, args: readonly string[], options: object) => ReturnType<typeof nodeSpawn> {
  // Runs `script` under node with the real argv in process.env.FAKE_ARGV, so the test sees which model was asked for.
  return (_command, args, options) => nodeSpawn(process.execPath, ['-e', script], {
    ...(options as Record<string, unknown>),
    shell: false,
    env: { ...process.env, FAKE_ARGV: JSON.stringify(args) }
  })
}

const REJECT_OLD_MODEL = `
const argv = JSON.parse(process.env.FAKE_ARGV)
const model = argv[argv.indexOf('-m') + 1]
if (model === 'gpt-old') {
  process.stderr.write('API Error: 400 Codex 0.1 does not support this model; version 0.2 or newer is required\\n')
  process.exit(1)
}
process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done on ' + model } }) + '\\n')
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n')
`

describe('honest failures and fallback', () => {
  function runnerWith(settings: Partial<AppSettings>, script: string, calls: string[][], tierFallbacks = {}): JobRunner {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'octa-models-'))
    repository = new JobsRepository(':memory:')
    const spawn = fakeCli(script)
    return new JobRunner({
      homePath: temporaryDirectory,
      jobs: repository,
      codexBinary: process.execPath,
      getSettings: () => ({ ...DEFAULT_SETTINGS, ...settings }),
      tierFallbacks,
      spawn: ((command: string, args: readonly string[], options: object) => {
        calls.push([...args])
        return spawn(command, args, options)
      }) as never
    })
  }

  it('retries once on the fallback model when the CLI rejects the tier model', async () => {
    const calls: string[][] = []
    const runner = runnerWith({ phaseModels: { ...DEFAULT_PHASE_MODELS, code: { model: 'gpt-old', effort: 'max' } } }, REJECT_OLD_MODEL, calls, { executor: 'gpt-new' })
    const handle = runner.startJob({ runner: 'codex-exec', input: { text: 'hi' }, maxRetries: 0, skipReview: true })
    const result = await handle.promise

    expect(result.status).toBe('ok')
    expect(calls.map((args) => args[args.indexOf('-m') + 1])).toEqual(['gpt-old', 'gpt-new'])
    const log = readFileSync(join(handle.folder, 'log.jsonl'), 'utf8')
    expect(log).toContain('Model gpt-old unavailable (cli_outdated); retrying on gpt-new')
  })

  it('records the CLI reason instead of a bare exit code when there is no fallback', async () => {
    const calls: string[][] = []
    const runner = runnerWith({ phaseModels: { ...DEFAULT_PHASE_MODELS, code: { model: 'gpt-old', effort: 'max' } } }, REJECT_OLD_MODEL, calls)
    const handle = runner.startJob({ runner: 'codex-exec', input: { text: 'hi' }, maxRetries: 1, skipReview: true })
    const result = await handle.promise

    expect(result.status).toBe('failed')
    expect(calls).toHaveLength(1)
    const stored = repository?.getJob(handle.id)
    expect(stored?.error).toMatch(/does not support this model.*\(exit code 1\)/)
    expect(stored?.error).not.toBe('Process exited with code 1.')
  })
})

describe('per-step routing by the manager', () => {
  const plan = (tier: unknown) => ({
    plan_id: 'p1', language: 'en', summary: 'Rewrite the intro.', questions: [], assumptions: [], workflow: 'custom',
    steps: [{ id: 's1', runner: 'codex-exec', prompt: 'Rewrite the intro in plain words.', needs: [], gate: 'none', autonomy: 'assisted', acceptance: ['Intro rewritten'], tier }],
    deliverables: ['intro.md'], estimated_minutes: 2
  })

  it('accepts a known tier on a plan step and rejects an unknown one', () => {
    expect(validatePlan(plan('executor-fast'))).toEqual({ valid: true, errors: [] })
    const invalid = validatePlan(plan('genius'))
    expect(invalid.valid).toBe(false)
    expect(invalid.errors.join(' ')).toMatch(/steps\[0\]\.tier must be one of manager, critic, executor/)
  })

  it('keeps the tier when a plan is saved as a workflow', () => {
    const checked = validateWorkflow({ id: 'W9', name: 'rewrite', version: 1, acceptance: [], steps: plan('executor-fast').steps })
    expect(checked.valid).toBe(true)
    expect(checked.definition?.steps[0].tier).toBe('executor-fast')
    expect(validateWorkflow({ id: 'W9', name: 'rewrite', version: 1, acceptance: [], steps: plan('genius').steps }).valid).toBe(false)
  })

  it('runs a step on the model of the tier the plan named', async () => {
    const calls: string[][] = []
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'octa-tier-'))
    repository = new JobsRepository(':memory:')
    const spawn = fakeCli(REJECT_OLD_MODEL)
    const runner = new JobRunner({
      homePath: temporaryDirectory,
      jobs: repository,
      codexBinary: process.execPath,
      getSettings: () => ({ ...DEFAULT_SETTINGS, phaseModels: { ...DEFAULT_PHASE_MODELS, code: { model: 'gpt-mini', effort: 'max' } } }),
      spawn: ((command: string, args: readonly string[], options: object) => {
        calls.push([...args])
        return spawn(command, args, options)
      }) as never
    })
    const result = await runner.startJob({ runner: 'codex-exec', tier: 'executor-fast', input: { text: 'hi' }, maxRetries: 0, skipReview: true }).promise
    expect(result.status).toBe('ok')
    expect(calls[0]).toEqual(expect.arrayContaining(['-m', 'gpt-mini', 'model_reasoning_effort="low"']))
  })
})

describe('company brain reaches every job', () => {
  it('injects knowledge/company.md from Octa home without the caller passing a path', async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'octa-brain-'))
    repository = new JobsRepository(':memory:')
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(temporaryDirectory, 'knowledge'), { recursive: true })
    writeFileSync(join(temporaryDirectory, 'knowledge', 'company.md'), '# Signature\nTraining for working brokers.')
    const echoBrain = `
let input = ''
process.stdin.on('data', (chunk) => { input += chunk })
process.stdin.on('end', () => {
  const seen = input.includes('### company.md') && input.includes('Training for working brokers.')
  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: seen ? 'brain-seen' : 'brain-missing' } }) + '\n')
  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\n')
})`
    const runner = new JobRunner({ homePath: temporaryDirectory, jobs: repository, codexBinary: process.execPath, spawn: fakeCli(echoBrain) as never })
    const handle = runner.startJob({ runner: 'codex-exec', input: { text: 'hi' }, maxRetries: 0, skipReview: true })
    await handle.promise
    expect(readFileSync(join(handle.folder, 'log.jsonl'), 'utf8')).toContain('brain-seen')
  })
})

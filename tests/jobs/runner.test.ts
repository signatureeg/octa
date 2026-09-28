import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  buildClaudePlanArgv,
  buildClaudeSkillArgv,
  HEADLESS_BLOCKED_TOOLS,
  buildCodexCriticArgv,
  buildCodexExecArgv,
  buildCodexReviewArgv,
  JobRunner,
  parseClaudeStreamJson,
  parseCodexJsonLines,
  resolveSkill
} from '../../electron/core/jobs/runner'
import { JobsRepository } from '../../electron/db/jobs'

let temporaryDirectory: string | undefined
let repository: JobsRepository | undefined

afterEach(() => {
  repository?.close()
  repository = undefined
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = undefined
})

describe('recorded CLI stream parsers', () => {
  it('normalizes Claude stream-json into text, usage, error, and done events', () => {
    const fixture = readFileSync(join(process.cwd(), 'tests', 'fixtures', 'claude-stream.jsonl'), 'utf8')
    const events = parseClaudeStreamJson(fixture)

    expect(events.some((item) => item.type === 'text' && item.text.includes('Failed to authenticate'))).toBe(true)
    expect(events.some((item) => item.type === 'usage')).toBe(true)
    expect(events.some((item) => item.type === 'done' && item.status === 'failed')).toBe(true)
  })

  it('normalizes Codex JSONL agent text and usage', () => {
    const fixture = readFileSync(join(process.cwd(), 'tests', 'fixtures', 'codex-jsonl.jsonl'), 'utf8')
    const events = parseCodexJsonLines(fixture)

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: 'fixture ok' }),
      expect.objectContaining({ type: 'error' }),
      expect.objectContaining({ type: 'usage', inputTokens: 18_955, outputTokens: 6 }),
      expect.objectContaining({ type: 'done', status: 'ok' })
    ]))
  })

  it('normalizes tool calls from both providers', () => {
    const claude = parseClaudeStreamJson(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read', input: { file: 'brief.md' } }] }
    }))
    const codex = parseCodexJsonLines(JSON.stringify({
      type: 'item.started',
      item: { type: 'command_execution', command: 'node -v' }
    }))

    expect(claude).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'tool', name: 'Read', phase: 'start' })]))
    expect(codex).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'tool', name: 'Bash', phase: 'start' })]))
  })
})

describe('runner argv contracts', () => {
  const workspace = 'C:\\Octa\\jobs\\job-1'
  const skill = 'C:\\Octa\\jobs\\job-1\\skill'

  it('builds the documented Claude planner argv', () => {
    expect(buildClaudePlanArgv({ workspace, systemPromptFile: 'planner.md' })).toEqual([
      '-p', '--model', 'claude-fable-5-1', '--effort', 'medium', '--output-format', 'json',
      '--add-dir', workspace, '--append-system-prompt-file', 'planner.md'
    ])
  })

  it('builds the documented Claude skill argv', () => {
    expect(buildClaudeSkillArgv({ workspace, skillPath: skill, allowedTools: ['Read'] }, 'led')).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--add-dir', skill, '--add-dir', workspace,
      '--append-system-prompt-file', join(skill, 'SKILL.md'), '--allowedTools', 'Read', '--disallowedTools', ...HEADLESS_BLOCKED_TOOLS, '--model', 'claude-sonnet-5'
    ])
  })

  it('builds the documented Codex executor, critic, and reviewer argv', () => {
    expect(buildCodexExecArgv({ workspace, skillPath: skill, outputSchema: 'result.schema.json' })).toEqual([
      'exec', '--json', '-m', 'gpt-5.6-luna', '-c', 'model_reasoning_effort="max"', '-c', 'service_tier="priority"',
      '-c', 'features.fast_mode=true', '-s', 'workspace-write', '-C', workspace, '--add-dir', skill,
      '--skip-git-repo-check', '--output-schema', 'result.schema.json'
    ])
    expect(buildCodexCriticArgv({ workspace, outputSchema: 'critique.schema.json' })).toEqual([
      'exec', '--json', '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort="xhigh"', '-s', 'read-only', '-C', workspace,
      '--skip-git-repo-check', '--output-schema', 'critique.schema.json'
    ])
    expect(buildCodexReviewArgv({ workspace, outputSchema: 'review.schema.json' })).toEqual([
      'exec', '--json', '-m', 'gpt-5.6-sol', '-c', 'model_reasoning_effort="high"', '-s', 'read-only', '-C', workspace,
      '--skip-git-repo-check', '--output-schema', 'review.schema.json'
    ])
  })

  it('dispatches every runner, including the in-process Gemini stub', () => {
    expect(buildClaudePlanArgv({ workspace })).toHaveLength(11)
    expect(buildClaudeSkillArgv({ workspace, skillPath: skill }, 'assisted')).toContain('--allowedTools')
    expect(buildCodexExecArgv({ workspace })).toContain('gpt-5.6-luna')
    expect(buildCodexCriticArgv({ workspace })).toContain('gpt-6-astra')
    expect(buildCodexReviewArgv({ workspace })).toContain('gpt-5.6-sol')
  })
})

describe('job lifecycle', () => {
  it('creates the contract folders, streams a result, and persists result.json', async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'octa-jobs-'))
    repository = new JobsRepository(':memory:')
    const runner = new JobRunner({ homePath: temporaryDirectory, jobs: repository })
    const output = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'fixture result' } })
    const done = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 4, output_tokens: 2 } })
    const handle = runner.startJob({
      runner: 'codex-exec',
      input: { text: 'hello' },
      executable: process.execPath,
      argsOverride: ['-e', `process.stdout.write(${JSON.stringify(`${output}\n${done}\n`)})`],
      maxRetries: 0
    })
    const result = await handle.promise

    expect(result.status).toBe('ok')
    expect(result.job_id).toBe(handle.id)
    expect(existsSync(join(handle.folder, 'brief.md'))).toBe(true)
    expect(existsSync(join(handle.folder, 'inputs'))).toBe(true)
    expect(existsSync(join(handle.folder, 'out'))).toBe(true)
    expect(existsSync(join(handle.folder, 'evidence'))).toBe(true)
    expect(existsSync(join(handle.folder, 'contract.json'))).toBe(true)
    expect(JSON.parse(readFileSync(join(handle.folder, 'result.json'), 'utf8'))).toMatchObject({ job_id: handle.id, status: 'ok' })
    expect(repository.getJob(handle.id)?.status).toBe('ok')
  })

  it('ends a job that exceeds its budget as needs_input with a partial summary', async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'octa-timeout-'))
    repository = new JobsRepository(':memory:')
    const runner = new JobRunner({ homePath: temporaryDirectory, jobs: repository })
    const handle = runner.startJob({
      runner: 'codex-exec',
      input: { text: 'wait' },
      executable: process.execPath,
      argsOverride: ['-e', 'setInterval(() => {}, 1000)'],
      timeBudgetMs: 120,
      maxRetries: 0
    })
    const result = await handle.promise

    expect(result.status).toBe('needs_input')
    expect(result.notes).toMatch(/Time budget exceeded|Partial output|budget/i)
  })

  it('cancels a long-running process tree within two seconds', async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'octa-cancel-'))
    repository = new JobsRepository(':memory:')
    const runner = new JobRunner({ homePath: temporaryDirectory, jobs: repository })
    const handle = runner.startJob({
      runner: 'codex-exec',
      input: { text: 'wait' },
      executable: process.execPath,
      argsOverride: ['-e', 'setInterval(() => {}, 1000)'],
      timeBudgetMs: 10_000,
      maxRetries: 0
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const started = Date.now()
    await handle.cancel()
    const result = await handle.promise

    expect(Date.now() - started).toBeLessThan(2_000)
    expect(result.status).toBe('cancelled')
    expect(repository.getJob(handle.id)?.status).toBe('cancelled')
  })

  it('supports the gemini-inline ChatProvider stub', async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'octa-gemini-inline-'))
    repository = new JobsRepository(':memory:')
    const runner = new JobRunner({
      homePath: temporaryDirectory,
      jobs: repository,
      chatProvider: {
        send: async () => ({ text: 'inline response', calls: [] })
      }
    })
    const handle = runner.startJob({ runner: 'gemini-inline', input: { text: 'hello' } })
    const result = await handle.promise

    expect(result.status).toBe('ok')
    expect(readFileSync(join(handle.folder, 'result.json'), 'utf8')).toContain('inline response')
  })
})

describe('skill resolution', () => {
  it('reads MANIFEST.json and resolves the local stop-slop folder', () => {
    const resolution = resolveSkill('stop-slop', { skillsLibraryPath: join(process.cwd(), 'skills-library') })
    expect(resolution.skillPath).toContain(join('skills-library', 'skills', 'stop-slop'))
    expect(resolution.skillMarkdown).toContain('Stop Slop')
  })
})

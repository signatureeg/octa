import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { codexModelArgs } from './models'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, delimiter, dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { JobOutput, JobResult } from '../../types'

export const REVIEW_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Octa reviewer result',
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['pass', 'revise'] },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          criterion: { type: 'string' },
          detail: { type: 'string' },
          severity: { type: 'string' }
        },
        required: ['criterion', 'detail', 'severity']
      }
    },
    fixed_output_path: { type: ['string', 'null'] }
  },
  required: ['verdict', 'issues', 'fixed_output_path']
} as const

export type ReviewVerdict = 'pass' | 'revise'

export interface ReviewIssue {
  /** The exact acceptance criterion that failed. */
  criterion: string
  detail: string
  severity: string
}

export interface ReviewCost {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  costUsd?: number
  seconds?: number
}

export interface ReviewResult {
  verdict: ReviewVerdict
  issues: ReviewIssue[]
  fixed_output_path?: string
}

/** A review decision plus the usage reported by the Sol subprocess. */
export type ReviewRunResult = ReviewResult & { cost?: ReviewCost }

export interface ReviewJob {
  id?: string
  jobId?: string
  folder?: string
  workspace?: string
  jobFolder?: string
  path?: string
  jobPath?: string
  resultPath?: string
  resultJsonPath?: string
  resultJson?: JobResult | Record<string, unknown> | null
  result?: JobResult | Record<string, unknown> | null
  outputs?: JobOutput[] | readonly string[]
  outputPaths?: readonly string[]
  [key: string]: unknown
}

export interface ReviewStep {
  id?: string
  stepId?: string
  runner?: string
  acceptance?: readonly string[]
  acceptanceCriteria?: readonly string[]
  acceptance_criteria?: readonly string[]
  criteria?: readonly string[]
  outputs?: JobOutput[] | readonly string[]
  outputPaths?: readonly string[]
  input?: unknown
  [key: string]: unknown
}

export interface ReviewRequest {
  runner: 'codex-review'
  job: ReviewJob
  step: ReviewStep
  workspace: string
  resultPath: string
  outputPaths: string[]
  acceptance: string[]
  result: unknown
  prompt: string
  reviewerPrompt: string
  outputSchema: string
  argv: string[]
}

export interface ReviewExecution {
  review?: ReviewResult
  result?: ReviewResult
  cost?: ReviewCost
  usage?: ReviewCost
  rawOutput?: string
}

export type ReviewRunner = (request: ReviewRequest) => Promise<ReviewExecution | ReviewResult>
export type ReviewStepRunner = (job: ReviewJob, step: ReviewStep) => Promise<ReviewRunResult | ReviewResult>
type ReviewCallback = ReviewRunner | ReviewStepRunner

export interface ReviewStepOptions {
  /** Low-level fake or adapter that receives the assembled Codex request. */
  runner?: ReviewCallback
  run?: ReviewCallback
  runStep?: ReviewCallback
  /** High-level fake that receives the same job and step passed to reviewStep. */
  stepRunner?: ReviewStepRunner
  reviewRunner?: ReviewCallback
  spawn?: SpawnFunction
  codexBinary?: string
  environment?: Record<string, string | undefined>
  platform?: NodeJS.Platform
  timeoutMs?: number
  now?: () => Date
}

export type SpawnFunction = (
  command: string,
  args?: string[],
  options?: SpawnOptions
) => ChildProcess

const DEFAULT_REVIEW_TIMEOUT_MS = 30 * 60_000
const DEFAULT_REVIEWER_PROMPT = `# Octa reviewer (Sol)

You are Sol, Octa Assistant's read-only reviewer. Review the executor's deliverable against every acceptance criterion supplied in the review request. Inspect ./result.json and every listed output file before deciding.

For each failed criterion, return an issue whose criterion field is an exact verbatim quote of that acceptance criterion. Use verdict "revise" when any criterion is not met; use "pass" only when every criterion is met. Never rewrite a deliverable unless the correction is trivial and unambiguous. If you make such a correction, write the corrected file and set fixed_output_path to its path.

Return only JSON matching review.schema.json.`

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function acceptanceFor(step: ReviewStep): string[] {
  const values = step.acceptance ?? step.acceptanceCriteria ?? step.acceptance_criteria ?? step.criteria ?? []
  return values
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean)
}

function jobWorkspace(job: ReviewJob): string {
  const value = job.workspace ?? job.folder ?? job.jobFolder ?? job.jobPath ?? job.path
  if (!value || typeof value !== 'string') throw new Error('reviewStep requires a job workspace or folder.')
  return resolve(value)
}

function jobId(job: ReviewJob): string {
  const value = job.id ?? job.jobId
  return typeof value === 'string' && value.trim() ? value : 'unknown-job'
}

function stepId(step: ReviewStep): string {
  const value = step.id ?? step.stepId
  return typeof value === 'string' ? value : ''
}

function resultPathFor(job: ReviewJob, workspace: string): string {
  return resolve(job.resultPath ?? job.resultJsonPath ?? join(workspace, 'result.json'))
}

function resultFor(job: ReviewJob, resultPath: string): unknown {
  if (existsSync(resultPath)) return readJson(resultPath)
  return job.result ?? job.resultJson ?? null
}

function outputRecords(job: ReviewJob, step: ReviewStep, result: unknown): JobOutput[] {
  const fromStep = Array.isArray(step.outputs) && step.outputs.length > 0 ? step.outputs : undefined
  const fromJob = Array.isArray(job.outputs) && job.outputs.length > 0 ? job.outputs : undefined
  const resultOutputs = asRecord(result)?.outputs
  const fromResult = Array.isArray(resultOutputs) ? resultOutputs : undefined
  const fromStepPaths = step.outputPaths?.map((path) => ({ path, type: 'file', title: basename(path) }))
  const fromJobPaths = job.outputPaths?.map((path) => ({ path, type: 'file', title: basename(path) }))
  const values = fromStep ?? fromJob ?? fromResult ?? fromStepPaths ?? fromJobPaths ?? []
  return values.flatMap((value): JobOutput[] => {
    if (typeof value === 'string') {
      return [{ path: value, type: 'file', title: basename(value) }]
    }
    const record = asRecord(value)
    return typeof record?.path === 'string'
      && typeof record.type === 'string'
      && typeof record.title === 'string'
      ? [{ path: record.path, type: record.type, title: record.title }]
      : []
  })
}

function safeOutputPath(workspace: string, outputPath: string): string | undefined {
  const candidate = resolve(workspace, outputPath)
  const rel = relative(workspace, candidate)
  if (rel === '' || rel === '..' || rel.startsWith(`..${'\\'}`) || rel.startsWith(`..${'/'}`)) return undefined
  return candidate
}

function outputPreview(workspace: string, output: JobOutput): string {
  const path = safeOutputPath(workspace, output.path)
  if (!path || !existsSync(path)) return `(file unavailable at ${output.path})`
  const extension = extname(path).toLowerCase()
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.psd', '.xlsx', '.docx'].includes(extension)) {
    return `(binary output; inspect the file at ${output.path})`
  }
  try {
    return readFileSync(path, 'utf8').slice(0, 100_000)
  } catch {
    return `(file could not be read at ${output.path})`
  }
}

function quoteCriterion(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function reviewerPrompt(): string {
  try {
    const path = join(dirname(fileURLToPath(import.meta.url)), 'prompts', 'reviewer.md')
    if (existsSync(path)) return readFileSync(path, 'utf8').trim()
  } catch {
    // The bundled build may not retain the source-side prompt file.
  }
  return DEFAULT_REVIEWER_PROMPT
}

function assemblePrompt(
  workspace: string,
  resultPath: string,
  result: unknown,
  outputs: JobOutput[],
  acceptance: string[]
): string {
  const criteria = acceptance.length > 0
    ? acceptance.map((criterion, index) => `${index + 1}. ${quoteCriterion(criterion)}`).join('\n')
    : '(No acceptance criteria were supplied.)'
  const outputText = outputs.length > 0
    ? outputs.map((output) => `### ${output.path}\n${outputPreview(workspace, output)}`).join('\n\n')
    : '(No output entries were declared; inspect ./out for deliverables.)'
  return `${reviewerPrompt()}\n\n## Review request\n\nRead the executor result at ${resultPath} and inspect every output listed below. The working directory is ${workspace}.\n\n### Acceptance criteria (quote each failed criterion exactly)\n${criteria}\n\n### result.json\n\n\`\`\`json\n${JSON.stringify(result ?? null, null, 2)}\n\`\`\`\n\n### Outputs\n\n${outputText}\n\nReturn only the review JSON. Do not omit an issue for a failed criterion.`
}

function reviewWithoutCost(review: ReviewRunResult): ReviewResult {
  return {
    verdict: review.verdict,
    issues: review.issues,
    ...(review.fixed_output_path ? { fixed_output_path: review.fixed_output_path } : {})
  }
}

function costFrom(value: unknown): ReviewCost | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const inputTokens = numberValue(record.inputTokens ?? record.input_tokens ?? record.tokens_in)
  const outputTokens = numberValue(record.outputTokens ?? record.output_tokens ?? record.tokens_out)
  const cachedInputTokens = numberValue(record.cachedInputTokens ?? record.cached_input_tokens)
  const costUsd = numberValue(record.costUsd ?? record.cost_usd ?? record.cost)
  const seconds = numberValue(record.seconds)
  if ([inputTokens, outputTokens, cachedInputTokens, costUsd, seconds].every((item) => item === undefined)) return undefined
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(seconds === undefined ? {} : { seconds })
  }
}

function mergeCost(previous: ReviewCost | undefined, next: ReviewCost | undefined): ReviewCost | undefined {
  if (!previous) return next
  if (!next) return previous
  return {
    ...previous,
    ...Object.fromEntries(
      Object.entries(next).filter(([, value]) => value !== undefined)
    )
  }
}

function normalizeReview(value: unknown, acceptance: string[]): ReviewRunResult {
  const record = asRecord(value)
  const nested = asRecord(record?.review) ?? asRecord(record?.result) ?? record
  if (!nested) throw new Error('codex-review returned a non-object result.')
  const verdict = nested.verdict
  if (verdict !== 'pass' && verdict !== 'revise') {
    throw new Error('codex-review returned an invalid verdict.')
  }
  const issues = Array.isArray(nested.issues)
    ? nested.issues.flatMap((value): ReviewIssue[] => {
        if (typeof value === 'string') {
          return [{ criterion: acceptance[0] ?? '', detail: value, severity: 'high' }]
        }
        const issue = asRecord(value)
        if (!issue) return []
        const criterion = textValue(issue.criterion) ?? acceptance[0] ?? ''
        const detail = textValue(issue.detail) ?? textValue(issue.message) ?? JSON.stringify(issue)
        const severity = textValue(issue.severity) ?? 'medium'
        return [{ criterion, detail, severity }]
      })
    : []
  const fixed = textValue(nested.fixed_output_path)
  const cost = costFrom(record?.cost) ?? costFrom(record?.usage) ?? costFrom(nested.cost)
  return {
    verdict,
    issues,
    ...(fixed ? { fixed_output_path: fixed } : {}),
    ...(cost ? { cost } : {})
  }
}

export function normalizeReviewRunResult(value: unknown, acceptance: readonly string[] = []): ReviewRunResult {
  return normalizeReview(value, [...acceptance])
}

function extractText(value: unknown): string | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  if (typeof record.text === 'string') return record.text
  const content = record.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const text = content
      .map((item) => asRecord(item)?.text)
      .filter((item): item is string => typeof item === 'string')
      .join('')
    return text || undefined
  }
  return undefined
}

function structuredFromText(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  const candidates = [trimmed]
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  if (fenced) candidates.unshift(fenced[1])
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate) as unknown
      const record = asRecord(value)
      if (record) return record
    } catch {
      // Continue; Codex can emit progress JSON around the final agent message.
    }
  }
  return undefined
}

function reviewCandidate(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  if (record.verdict === 'pass' || record.verdict === 'revise') return record
  const nested = asRecord(record.review) ?? asRecord(record.result)
  if (nested?.verdict === 'pass' || nested?.verdict === 'revise') return nested
  const item = asRecord(record.item)
  if (item?.verdict === 'pass' || item?.verdict === 'revise') return item
  const text = extractText(item) ?? extractText(record)
  return text ? structuredFromText(text) : undefined
}

function usageFromEvent(value: unknown): ReviewCost | undefined {
  const record = asRecord(value)
  const usage = asRecord(record?.usage) ?? record
  return costFrom(usage)
}

function findNativeCodex(root: string, depth: number): string | undefined {
  if (depth < 0 || !existsSync(root)) return undefined
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of entries) {
    const candidate = join(root, entry.name)
    if (entry.isFile() && entry.name.toLowerCase() === 'codex.exe') return candidate
    if (entry.isDirectory()) {
      const nested = findNativeCodex(candidate, depth - 1)
      if (nested) return nested
    }
  }
  return undefined
}

function resolveCodexBinary(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = environment.CODEX_BINARY?.trim()
  if (explicit) return explicit
  const pathValue = environment.PATH ?? environment.Path ?? ''
  const names = process.platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex'] : ['codex']
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(directory, name)
      if (!existsSync(candidate)) continue
      if (process.platform !== 'win32' || extname(candidate).toLowerCase() === '.exe') return candidate
      const native = findNativeCodex(join(directory, 'node_modules', '@openai', 'codex'), 6)
      if (native) return native
    }
  }
  return undefined
}

export function buildReviewArgv(workspace: string, outputSchema = 'review.schema.json'): string[] {
  return [
    'exec',
    '--json',
    ...codexModelArgs('review'),
    '-s',
    'read-only',
    '-C',
    workspace,
    '--skip-git-repo-check',
    '--output-schema',
    outputSchema
  ]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function runCodexReview(request: ReviewRequest, options: ReviewStepOptions): Promise<ReviewExecution> {
  const codexBinary = options.codexBinary ?? resolveCodexBinary(options.environment ?? process.env)
  if (!codexBinary) throw new Error('Codex CLI was not found. Install it and sign in before reviewing a job.')
  const spawn = options.spawn ?? (nodeSpawn as unknown as SpawnFunction)
  const startedAt = Date.now()
  let child: ChildProcess
  try {
    child = spawn(codexBinary, request.argv, {
      cwd: request.workspace,
      env: { ...process.env, ...options.environment },
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
  } catch (error) {
    throw new Error(`codex-review could not start: ${errorMessage(error)}`)
  }
  return new Promise<ReviewExecution>((resolveExecution, rejectExecution) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let hardKillTimer: ReturnType<typeof setTimeout> | undefined
    let cost: ReviewCost | undefined
    const settle = (callback: () => void): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (hardKillTimer) clearTimeout(hardKillTimer)
      callback()
    }
    const kill = (): void => {
      try {
        child.kill()
      } catch {
        // The process may already have exited.
      }
      hardKillTimer = setTimeout(() => settle(() => rejectExecution(new Error('codex-review exceeded its time budget.'))), 1_900)
    }
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.once('error', (error) => settle(() => rejectExecution(error)))
    child.once('close', (code, signal) => {
      settle(() => {
        if (code !== 0) {
          rejectExecution(new Error(stderr.trim() || `codex-review exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}.`))
          return
        }
        let candidate: Record<string, unknown> | undefined
        for (const line of stdout.split(/\r?\n/).filter((item) => item.trim())) {
          try {
            const parsed = JSON.parse(line) as unknown
            cost = mergeCost(cost, usageFromEvent(parsed))
            candidate = reviewCandidate(parsed) ?? candidate
          } catch {
            candidate = structuredFromText(line) ?? candidate
          }
        }
        candidate = candidate ?? structuredFromText(stdout)
        if (!candidate) {
          rejectExecution(new Error('codex-review did not return review JSON.'))
          return
        }
        const elapsedSeconds = (Date.now() - startedAt) / 1_000
        resolveExecution({
          review: normalizeReview(candidate, request.acceptance),
          cost: {
            ...(cost ?? {}),
            seconds: cost?.seconds ?? elapsedSeconds
          },
          rawOutput: stdout
        })
      })
    })
    const timeout = options.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS
    timer = setTimeout(kill, Math.max(1, timeout))
    try {
      child.stdin?.end(request.prompt, 'utf8')
    } catch (error) {
      kill()
      rejectExecution(error)
    }
  })
}

function callbackResult(
  callback: ReviewCallback,
  request: ReviewRequest,
  job: ReviewJob,
  step: ReviewStep
): Promise<ReviewExecution | ReviewResult> {
  // A two-argument callback is the convenient high-level fake used by the
  // workflow runner; a one-argument callback sees the fully assembled request.
  return callback.length >= 2
    ? (callback as ReviewStepRunner)(job, step)
    : (callback as ReviewRunner)(request)
}

/**
 * Run Sol against one executor step. The optional callback is deliberately
 * injectable so unit tests and future workflow runners do not need a live CLI.
 */
export async function reviewStep(
  job: ReviewJob,
  step: ReviewStep,
  optionsOrRunner?: ReviewStepOptions | ReviewCallback
): Promise<ReviewRunResult> {
  const options: ReviewStepOptions = typeof optionsOrRunner === 'function'
    ? { runner: optionsOrRunner }
    : optionsOrRunner ?? {}
  const workspace = jobWorkspace(job)
  mkdirSync(workspace, { recursive: true })
  const resultPath = resultPathFor(job, workspace)
  const result = resultFor(job, resultPath)
  if (!existsSync(resultPath) && result !== null && result !== undefined) writeJson(resultPath, result)
  const acceptance = acceptanceFor(step)
  const outputs = outputRecords(job, step, result)
  const prompt = assemblePrompt(workspace, resultPath, result, outputs, acceptance)
  const input = {
    job_id: jobId(job),
    step_id: stepId(step),
    acceptance,
    result_path: resultPath,
    result,
    outputs
  }
  writeJson(join(workspace, 'review-input.json'), input)
  writeJson(join(workspace, 'review.schema.json'), REVIEW_SCHEMA)
  writeFileSync(join(workspace, 'reviewer.md'), `${reviewerPrompt()}\n`, 'utf8')
  const request: ReviewRequest = {
    runner: 'codex-review',
    job,
    step,
    workspace,
    resultPath,
    outputPaths: outputs.map((output) => output.path),
    acceptance,
    result,
    prompt,
    reviewerPrompt: reviewerPrompt(),
    outputSchema: 'review.schema.json',
    argv: buildReviewArgv(workspace)
  }
  const callback = options.stepRunner ?? options.reviewRunner ?? options.runner ?? options.run ?? options.runStep
  const execution = callback
    ? await callbackResult(callback, request, job, step)
    : await runCodexReview(request, options)
  const normalized = normalizeReview(execution, acceptance)
  writeJson(join(workspace, 'review.json'), reviewWithoutCost(normalized))
  return normalized
}

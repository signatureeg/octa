import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, type Dirent } from 'node:fs'
import { codexModelArgs } from '../models'
import { join, relative, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { resolveCliBinary } from '../../jobs/runner'
import type { ResearchManager } from '../research'

export type IdeationPass = 'code-quality' | 'security' | 'performance' | 'ux' | 'documentation'
export type AnalysisKind = 'roadmap' | 'competitor-roadmap' | 'ideation'

export interface AnalysisOptions {
  projectPath: string
  outputDir: string
  brief?: string
  competitorBrief?: string
  research?: ResearchManager
  ideationPasses?: IdeationPass[]
  analysisAgent?: (prompt: string, kind: AnalysisKind) => Promise<string>
  gapMapper?: (input: { brief: string; codebase: string; research: string }) => Promise<string>
  onProgress?: (message: string) => void
}

export interface AnalysisResult {
  outputDir: string
  files: string[]
  roadmapPath?: string
  competitorRoadmapPath?: string
  ideationPaths: string[]
  researchReportPath?: string
}

export interface IndexedFile {
  path: string
  bytes: number
}

const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage', '.astro', '.venv', '__pycache__'])

function walk(root: string, current = root, depth = 0, output: IndexedFile[] = []): IndexedFile[] {
  if (depth > 5 || !existsSync(current)) return output
  let entries: Dirent<string>[] = []
  try { entries = readdirSync(current, { withFileTypes: true, encoding: 'utf8' }) } catch { return output }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.env.example') continue
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) walk(root, join(current, entry.name), depth + 1, output)
      continue
    }
    if (!entry.isFile()) continue
    const path = join(current, entry.name)
    try { output.push({ path: relative(root, path).replaceAll('\\', '/'), bytes: statSync(path).size }) } catch { /* ignore a file removed during indexing */ }
  }
  return output.sort((a, b) => a.path.localeCompare(b.path))
}

export function indexCodebase(projectPath: string): { files: IndexedFile[]; highlights: string[] } {
  const root = resolve(projectPath)
  const files = walk(root)
  const highlights = files.map((item) => item.path).filter((path) => /(^|\/)(readme|package\.json|pyproject\.toml|src|app|pages|routes|components|electron)(\/|\.|$)/i.test(path)).slice(0, 120)
  return { files, highlights }
}

function codebaseMarkdown(projectPath: string, brief: string): string {
  const index = indexCodebase(projectPath)
  const groups = new Map<string, number>()
  for (const file of index.files) {
    const root = file.path.split('/')[0] || file.path
    groups.set(root, (groups.get(root) ?? 0) + 1)
  }
  return [
    `Project root: ${resolve(projectPath)}`,
    `Brief: ${brief || 'No brief supplied.'}`,
    '',
    `Files indexed: ${index.files.length}`,
    '',
    'Top-level areas:',
    ...[...groups.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([name, count]) => `- ${name}: ${count} file(s)`),
    '',
    'Representative files:',
    ...index.highlights.map((path) => `- ${path}`)
  ].join('\n')
}

function rankedMarkdown(title: string, items: string[], context: string): string {
  const unique = [...new Set(items.filter((item) => item.trim()))]
  return [
    `# ${title}`,
    '',
    'Read-only analysis. Suggestions are ranked by expected user impact and implementation leverage.',
    '',
    '## Context',
    '',
    context.slice(0, 8_000),
    '',
    '## Ranked opportunities',
    '',
    ...(unique.length > 0 ? unique : ['No material opportunity was identified from the available codebase.']).map((item, index) => `${index + 1}. **P${index + 1}** — ${item}`),
    ''
  ].join('\n')
}

function defaultRoadmapItems(brief: string, projectPath: string): string[] {
  const index = indexCodebase(projectPath)
  const items = [
    brief ? `Deliver the requested outcome: ${brief}` : 'Clarify the highest-value user outcome and make it the first milestone.',
    index.files.some((item) => /test|spec/i.test(item.path)) ? 'Keep the existing verification surface green as each feature ships.' : 'Add a focused automated test path before expanding the feature surface.',
    index.files.some((item) => /docs|readme/i.test(item.path)) ? 'Keep the user-facing documentation synchronized with each milestone.' : 'Document setup, verification, and the first successful user workflow.'
  ]
  return items
}

async function defaultAnalysisAgent(prompt: string, kind: AnalysisKind): Promise<string> {
  const executable = resolveCliBinary('codex')
  if (!executable) return ''
  const root = process.cwd()
  const args = [
    'exec', '--json', ...codexModelArgs('analysis'),
    '-s', 'read-only', '-C', root, '--skip-git-repo-check'
  ]
  const child = spawn(executable, args, { cwd: root, env: process.env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  return new Promise<string>((resolvePromise) => {
    child.stdout?.on('data', (chunk: Buffer | string) => { stdout += String(chunk) })
    child.once('error', () => resolvePromise(''))
    child.once('close', (code) => {
      if (code !== 0) return resolvePromise('')
      resolvePromise(stdout.trim())
    })
    child.stdin?.end(`${prompt}\n\nAnalysis kind: ${kind}\nReturn concise ranked markdown or plain text.`, 'utf8')
  })
}

export async function runAnalysis(options: AnalysisOptions): Promise<AnalysisResult> {
  const outputDir = resolve(options.outputDir)
  mkdirSync(outputDir, { recursive: true })
  const brief = options.brief?.trim() ?? ''
  const files: string[] = []
  const roadmapPath = join(outputDir, 'roadmap.md')
  const codebase = codebaseMarkdown(options.projectPath, brief)
  const agent = options.analysisAgent ?? defaultAnalysisAgent
  const roadmapAgent = await agent([
    'Create a read-only product roadmap from this codebase and Bedo brief.',
    'Rank concrete features, dependencies, and verification milestones. Do not edit files.',
    '',
    codebase
  ].join('\n'), 'roadmap')
  writeFileSync(roadmapPath, roadmapAgent.trim() || rankedMarkdown('Roadmap', defaultRoadmapItems(brief, options.projectPath), codebase), 'utf8')
  files.push(roadmapPath)
  options.onProgress?.('Roadmap analysis completed.')

  let competitorRoadmapPath: string | undefined
  let researchReportPath: string | undefined
  if (options.competitorBrief?.trim()) {
    let researchText = 'No competitor research result was available.'
    if (options.research) {
      try {
        const handle = options.research.start(options.competitorBrief.trim(), { preset: 'competitor' })
        const result = await handle.promise
        researchReportPath = result.reportPath
        researchText = result.reportPath && existsSync(result.reportPath) ? readFileSync(result.reportPath, 'utf8') : JSON.stringify(result, null, 2)
      } catch (error) {
        researchText = `Competitor research failed gracefully: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    const mapped = options.gapMapper
      ? await options.gapMapper({ brief: options.competitorBrief, codebase, research: researchText })
      : await agent([
        'You are Luna mapping competitor research gaps to concrete product features.',
        'Return a ranked markdown list of opportunities grounded in the supplied research and codebase. Keep this read-only.',
        '',
        '# Competitor brief',
        options.competitorBrief,
        '',
        '# Codebase',
        codebase,
        '',
        '# Research',
        researchText.slice(0, 24_000)
      ].join('\n'), 'competitor-roadmap')
    competitorRoadmapPath = join(outputDir, 'competitor-roadmap.md')
    writeFileSync(competitorRoadmapPath, mapped.trim() || rankedMarkdown('Competitor roadmap', [
      'Close the most visible competitor capability gap described in the brief.',
      'Make the gap measurable with one acceptance criterion and one verification command.',
      'Document the differentiation so it survives future roadmap reviews.'
    ], researchText), 'utf8')
    files.push(competitorRoadmapPath)
    options.onProgress?.('Competitor roadmap analysis completed.')
  }

  const passes = options.ideationPasses ?? ['code-quality', 'security', 'performance', 'ux', 'documentation']
  const passItems: Record<IdeationPass, string[]> = {
    'code-quality': ['Make the highest-churn module easier to test and keep public contracts typed.', 'Remove duplicated orchestration paths and document the ownership boundary.'],
    security: ['Review secret handling, filesystem boundaries, and subprocess arguments before adding outward actions.', 'Add negative tests for untrusted paths and malformed agent output.'],
    performance: ['Measure the slowest build or analysis phase before optimizing it.', 'Keep large context packs bounded and reuse indexed project metadata.'],
    ux: ['Make the first successful workflow visible with progress, status, and recovery affordances.', 'Pair every failure with a next action a user can understand.'],
    documentation: ['Document the preview/start command and the generated artifacts.', 'Keep the build spec, acceptance criteria, and registry entry discoverable.']
  }
  const ideationPaths: string[] = []
  for (const pass of passes) {
    const path = join(outputDir, `${pass}.md`)
    const agentOutput = await agent(`Run a ${pass} ideation pass over this codebase. Return a ranked markdown list and stay read-only.\n\n${codebase}`, 'ideation')
    writeFileSync(path, agentOutput.trim() || rankedMarkdown(pass, passItems[pass], codebase), 'utf8')
    ideationPaths.push(path)
    files.push(path)
  }
  return { outputDir, files, roadmapPath, competitorRoadmapPath, ideationPaths, researchReportPath }
}

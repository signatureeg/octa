import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * How Octa learns (owner request, 2026-09-28). Everything lives as plain Markdown in the brain so the
 * owner can read and edit it, and every agent reads it before working:
 *
 * - knowledge/companies/<slug>/lessons.md  lessons from the owner's rejections, comments and revisions
 * - knowledge/companies/<slug>/gaps.md     work the owner asked for that no agent covers yet
 * - knowledge/owner.md                     what Octa remembers about the owner (preferences, decisions)
 *
 * Each entry is one bullet: `- YYYY-MM-DD · <tag> · <text>`. The weekly retro reads them to propose
 * improvements; nothing changes on its own.
 */

export type LearningLog = 'lessons' | 'gaps' | 'memory'
export type MemoryKind = 'preference' | 'decision' | 'fact'

export interface LearningEntry {
  id: string
  date: string
  tag: string
  text: string
}

const HEADERS: Record<LearningLog, string> = {
  lessons: '# Lessons learned\n\nFrom the owner\'s rejections, comments and revisions. Every agent reads this before working: do not repeat these mistakes.\n',
  gaps: '# Capability gaps\n\nWork the owner asked for that no agent covers yet. The weekly retro turns repeated gaps into proposals for new agents or skills.\n',
  memory: '# What Octa remembers about the owner\n\nPreferences, decisions and facts the owner asked Octa to remember. Follow them unless the owner says otherwise.\n'
}

/** Keep the newest entries so the file stays short enough to sit in every prompt. */
const LIMITS: Record<LearningLog, number> = { lessons: 60, gaps: 40, memory: 80 }
const MAX_TEXT = 500
const ENTRY = /^- (\d{4}-\d{2}-\d{2}) · ([^·]+?) · (.+)$/

export function learningPath(knowledgeRoot: string, log: LearningLog, company?: string): string {
  if (log === 'memory') return join(knowledgeRoot, 'owner.md')
  if (!company) throw new Error(`The ${log} log belongs to a company.`)
  return join(knowledgeRoot, 'companies', company, `${log}.md`)
}

function entryId(line: string): string {
  return createHash('sha1').update(line).digest('hex').slice(0, 12)
}

function clean(value: string, max: number): string {
  return value.replace(/\s+/g, ' ').replace(/·/g, '-').trim().slice(0, max)
}

export function readLearning(path: string): LearningEntry[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split(/\r?\n/).flatMap((line) => {
    const match = ENTRY.exec(line.trim())
    return match ? [{ id: entryId(line.trim()), date: match[1], tag: match[2].trim(), text: match[3].trim() }] : []
  })
}

function write(path: string, log: LearningLog, entries: readonly LearningEntry[]): void {
  mkdirSync(dirname(path), { recursive: true })
  const body = entries.map((entry) => `- ${entry.date} · ${entry.tag} · ${entry.text}`).join('\n')
  writeFileSync(path, `${HEADERS[log]}\n${body}${body ? '\n' : ''}`, 'utf8')
}

/** Adds an entry (skipping an exact repeat of an existing text) and returns it. */
export function appendLearning(path: string, log: LearningLog, tag: string, text: string, now = new Date()): LearningEntry | undefined {
  const cleanText = clean(text, MAX_TEXT)
  if (!cleanText) return undefined
  const entries = readLearning(path)
  const repeat = entries.find((entry) => entry.text.toLowerCase() === cleanText.toLowerCase())
  if (repeat) return repeat
  const line = `- ${now.toISOString().slice(0, 10)} · ${clean(tag, 60) || 'note'} · ${cleanText}`
  const entry: LearningEntry = { id: entryId(line), date: now.toISOString().slice(0, 10), tag: clean(tag, 60) || 'note', text: cleanText }
  write(path, log, [...entries, entry].slice(-LIMITS[log]))
  return entry
}

export function removeLearning(path: string, log: LearningLog, id: string): boolean {
  const entries = readLearning(path)
  const next = entries.filter((entry) => entry.id !== id)
  if (next.length === entries.length) return false
  write(path, log, next)
  return true
}

/** The lesson written when the owner turns work down or asks for changes. */
export function lessonFromFeedback(input: { who?: string | null; kind: 'rejected' | 'revise' | 'skipped' | 'comment'; comment: string; about?: string }): { tag: string; text: string } | undefined {
  const comment = clean(input.comment, 400)
  if (!comment) return undefined
  // Written in the owner's language: he reads these on the Brain page, and agents read them too.
  const verb = { rejected: 'رفض', revise: 'طلب تعديل', skipped: 'تخطّى', comment: 'علّق على' }[input.kind]
  const about = input.about ? ` "${clean(input.about, 80)}"` : ''
  return { tag: input.who?.trim() || 'all agents', text: `بيدو ${verb}${about}: ${comment}` }
}

/** Memory lines for a prompt (voice session or agent brief). */
export function renderMemory(entries: readonly LearningEntry[], limit = 40): string {
  return entries.slice(-limit).map((entry) => `- (${entry.tag}) ${entry.text}`).join('\n')
}

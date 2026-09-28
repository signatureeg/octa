import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Companies Octa works for (the owner's own or ones under management). Each lives in the company
 * brain as knowledge/companies/<slug>/ with company.md, icp.md, voice.md, pricing.md, an optional
 * master-prompt.md (how to show up for this company, RCCF + 3-point QA) and company.json (links).
 * Agents stay the same across companies; the folder they read is what changes.
 */

export const DEFAULT_COMPANY = 'signature'
export const COMPANY_FILES = ['master-prompt.md', 'company.md', 'voice.md', 'icp.md', 'pricing.md', 'lessons.md'] as const

export interface CompanyLinks {
  website?: string
  app?: string
  repo?: string
}

export interface CompanyInfo {
  slug: string
  name: string
  links: CompanyLinks
  files: string[]
  hasMasterPrompt: boolean
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/

export function isCompanySlug(value: unknown): value is string {
  return typeof value === 'string' && SLUG.test(value)
}

/** Latin slug from a company name; non-Latin names need an explicit slug. */
export function companySlug(name: string): string {
  return name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
}

export function companiesRoot(knowledgeRoot: string): string {
  return join(knowledgeRoot, 'companies')
}

export function companyPath(knowledgeRoot: string, slug: string): string | undefined {
  if (!isCompanySlug(slug)) return undefined
  const path = join(companiesRoot(knowledgeRoot), slug)
  return existsSync(join(path, 'company.md')) ? path : undefined
}

function readLinks(path: string): CompanyLinks {
  try {
    const raw = JSON.parse(readFileSync(join(path, 'company.json'), 'utf8')) as Record<string, unknown>
    const links: CompanyLinks = {}
    for (const key of ['website', 'app', 'repo'] as const) if (typeof raw[key] === 'string' && raw[key]) links[key] = raw[key] as string
    return links
  } catch {
    return {}
  }
}

function readName(path: string, slug: string): string {
  try {
    const heading = readFileSync(join(path, 'company.md'), 'utf8').split(/\r?\n/).find((line) => line.startsWith('# '))
    return heading ? heading.slice(2).replace(/\s+[—-]\s+company\s*$/i, '').trim() || slug : slug
  } catch {
    return slug
  }
}

export function readCompany(knowledgeRoot: string, slug: string): CompanyInfo | undefined {
  const path = companyPath(knowledgeRoot, slug)
  if (!path) return undefined
  const files = readdirSync(path).filter((file) => file.endsWith('.md') && statSync(join(path, file)).isFile()).sort()
  return { slug, name: readName(path, slug), links: readLinks(path), files, hasMasterPrompt: files.includes('master-prompt.md') }
}

export function listCompanies(knowledgeRoot: string): CompanyInfo[] {
  const root = companiesRoot(knowledgeRoot)
  if (!existsSync(root)) return []
  return readdirSync(root)
    .filter((entry) => isCompanySlug(entry))
    .map((slug) => readCompany(knowledgeRoot, slug))
    .filter((company): company is CompanyInfo => Boolean(company))
    .sort((left, right) => (left.slug === DEFAULT_COMPANY ? -1 : right.slug === DEFAULT_COMPANY ? 1 : left.name.localeCompare(right.name)))
}

/**
 * Where a job reads its company brain: the named company's folder, else the active company's,
 * else the knowledge root (older single-company layout).
 */
export function knowledgePathFor(knowledgeRoot: string, company?: string, active?: string): string {
  return (company && companyPath(knowledgeRoot, company)) || (active && companyPath(knowledgeRoot, active)) || knowledgeRoot
}

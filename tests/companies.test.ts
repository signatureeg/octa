import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn as nodeSpawn } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { companySlug, knowledgePathFor, listCompanies, readCompany } from '../electron/core/octa/companies'
import { JobRunner } from '../electron/core/jobs/runner'
import { JobsRepository } from '../electron/db/jobs'

let home: string | undefined
let repository: JobsRepository | undefined
afterEach(() => {
  repository?.close()
  repository = undefined
  if (home) rmSync(home, { recursive: true, force: true })
  home = undefined
})

function company(root: string, slug: string, name: string, extra: Record<string, string> = {}): void {
  const dir = join(root, 'companies', slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'company.md'), `# ${name} — company\n\nAbout ${name}.`)
  for (const [file, body] of Object.entries(extra)) writeFileSync(join(dir, file), body)
}

describe('companies', () => {
  it('lists company folders with names, links and master prompts, Signature first', () => {
    home = mkdtempSync(join(tmpdir(), 'octa-companies-'))
    const root = join(home, 'knowledge')
    company(root, 'acme', 'Acme Clinic')
    company(root, 'signature', 'Signature', { 'master-prompt.md': 'Show up like this.', 'company.json': JSON.stringify({ website: 'https://signaturee.net', repo: 'example-org/example-platform', junk: 1 }) })
    mkdirSync(join(root, 'companies', 'Bad Name'), { recursive: true })
    mkdirSync(join(root, 'companies', 'empty'), { recursive: true })

    expect(listCompanies(root).map((item) => item.slug)).toEqual(['signature', 'acme'])
    expect(readCompany(root, 'signature')).toMatchObject({ name: 'Signature', hasMasterPrompt: true, links: { website: 'https://signaturee.net', repo: 'example-org/example-platform' } })
    expect(readCompany(root, 'acme')).toMatchObject({ name: 'Acme Clinic', hasMasterPrompt: false, links: {} })
    expect(readCompany(root, '../etc')).toBeUndefined()
    expect(companySlug('Acme Clinic, Inc.')).toBe('acme-clinic-inc')
  })

  it('picks the named company, then the active one, then the knowledge root', () => {
    home = mkdtempSync(join(tmpdir(), 'octa-companies-'))
    const root = join(home, 'knowledge')
    company(root, 'signature', 'Signature')
    company(root, 'acme', 'Acme')
    expect(knowledgePathFor(root, 'acme', 'signature')).toBe(join(root, 'companies', 'acme'))
    expect(knowledgePathFor(root, undefined, 'signature')).toBe(join(root, 'companies', 'signature'))
    expect(knowledgePathFor(root, 'missing', 'also-missing')).toBe(root)
  })

  it('a job reads its company\'s master prompt and brain, and is told to run the 3-point QA', async () => {
    home = mkdtempSync(join(tmpdir(), 'octa-companies-'))
    const root = join(home, 'knowledge')
    company(root, 'signature', 'Signature', { 'master-prompt.md': 'MASTER-SIGNATURE' })
    company(root, 'acme', 'Acme', { 'master-prompt.md': 'MASTER-ACME', 'lessons.md': '- 2026-09-28 · x · LESSON-ACME' })
    writeFileSync(join(root, 'owner.md'), '- 2026-09-28 · preference · OWNER-MEMORY')
    repository = new JobsRepository(':memory:')
    const script = `
let input = ''
process.stdin.on('data', (chunk) => { input += chunk })
process.stdin.on('end', () => {
  const seen = ['MASTER-SIGNATURE', 'MASTER-ACME', 'About Acme', 'LESSON-ACME', 'OWNER-MEMORY', '3-point QA', 'working for the company "acme"'].filter((mark) => input.includes(mark)).join('|')
  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'SEEN:' + seen } }) + '\\n')
  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n')
})`
    const runner = new JobRunner({
      homePath: home,
      jobs: repository,
      codexBinary: process.execPath,
      getActiveCompany: () => 'signature',
      spawn: ((_command: string, args: readonly string[], options: object) => nodeSpawn(process.execPath, ['-e', script], { ...(options as Record<string, unknown>), shell: false })) as never
    })
    const named = runner.startJob({ runner: 'codex-exec', company: 'acme', input: {}, maxRetries: 0, skipReview: true })
    await named.promise
    expect(readFileSync(join(named.folder, 'log.jsonl'), 'utf8')).toContain('SEEN:MASTER-ACME|About Acme|LESSON-ACME|OWNER-MEMORY|3-point QA|working for the company \\"acme\\"')
    const active = runner.startJob({ runner: 'codex-exec', input: {}, maxRetries: 0, skipReview: true })
    await active.promise
    expect(readFileSync(join(active.folder, 'log.jsonl'), 'utf8')).toContain('SEEN:MASTER-SIGNATURE|OWNER-MEMORY|3-point QA')
  })
})

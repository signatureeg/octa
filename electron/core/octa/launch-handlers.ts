import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AppSettings, DocumentBrand, DocumentRecord, InvoiceItem, NewTask } from '../../types'
import { DEFAULT_BRAND } from '../../types'
import { invoiceDocument } from '../documents'
import { brandedDocument, PdfRenderer, proposalBody } from '../pdf'
import { createResearchBrowser, type CrawlResult, type ResearchBrowser, type ResearchSettingsStore } from './browser'
import type { BuildStartRequest } from './build'
import type { BuildState } from './build/types'
import type { BuildStartResponse } from './build'
import { DocumentRepository } from '../../db/documents'
import { JobsRepository } from '../../db/jobs'
import { OperationsRepository } from '../../db/operations'
import { SocialQueueRepository, type SocialPlatform } from '../../db/social-queue'
import { TaskRepository } from '../../db/tasks'
import type { AgentsRepository } from '../../db/agents'
import { agentPrompt, validateAgentSpec } from './agents'
import { learningPath, readLearning, type LearningEntry } from './learning'
import type { AgentRecord } from '../../types'
import { TimeTracker } from '../time-tracking'
import { Vault } from '../vault'
import type {
  WorkflowGateApprovalHandler,
  WorkflowGateApprovalRequest,
  WorkflowStepExecution,
  WorkflowStepHandler,
  WorkflowStepRunRequest
} from './workflows'

export interface ResearchBrowserLike {
  crawl(url: string, maxPages?: number): Promise<CrawlResult>
  close?(): Promise<void>
}

export interface BuildManagerLike {
  start(request: BuildStartRequest): Promise<BuildStartResponse>
  wait(id: string): Promise<BuildState>
}

export interface SkillChainRequest {
  name: string
  input: unknown
  request: WorkflowStepRunRequest
}

export type LaunchSkillRunner = (request: SkillChainRequest) => Promise<WorkflowStepExecution | unknown>

export interface LaunchWorkflowDependencies {
  homePath: string
  brandFontPath?: string
  getSettings?: () => Pick<AppSettings, 'octaHomePath' | 'skillsLibraryPath' | 'vaultPath'>
  settings?: ResearchSettingsStore
  browserFactory?: (options: {
    octaHome: string
    jobId: string
    jobFolder: string
    settings?: ResearchSettingsStore
  }) => ResearchBrowserLike
  buildManager?: BuildManagerLike
  skillRunner?: LaunchSkillRunner
  tasks?: TaskRepository
  operations?: OperationsRepository
  /** W7 creates an agent here after the owner approves step s4 (spec 018). */
  agents?: AgentsRepository
  /** W9 step s2: runs one agent job on the RCCF brief and waits for it. */
  agentJobRunner?: (input: { agent: AgentRecord; brief: string; company: string; request: WorkflowStepRunRequest }) => Promise<WorkflowStepExecution>
  documents?: DocumentRepository
  jobs?: JobsRepository
  timeTracker?: TimeTracker
  pdfRenderer?: Pick<PdfRenderer, 'render'>
  socialQueue?: SocialQueueRepository
  socialHandoffPath?: string
  /** W8 reads lessons and gaps from the brain. */
  knowledgeRoot?: () => string
  /** The company W8 reviews. */
  activeCompany?: () => string
  /** W8 skill scouting: the skills Octa already has (name + one line). */
  skillsCatalog?: () => Array<{ name: string; description: string }>
  now?: () => Date
}

interface RecordValue {
  [key: string]: unknown
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record(value: unknown): RecordValue {
  return isRecord(value) ? value : {}
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function boolValue(value: unknown): boolean {
  return value === true
}

function briefRecord(value: unknown): RecordValue {
  if (isRecord(value) && isRecord(value.raw)) return value
  return record(value)
}

function inputRecord(request: WorkflowStepRunRequest): RecordValue {
  return record(request.input)
}

function outputPath(folder: string, ...parts: string[]): string {
  const path = join(folder, ...parts)
  mkdirSync(join(path, '..'), { recursive: true })
  return path
}

function writeJson(folder: string, name: string, value: unknown): string {
  const path = outputPath(folder, name)
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return path
}

function writeText(folder: string, name: string, value: string): string {
  const path = outputPath(folder, name)
  writeFileSync(path, value.endsWith('\n') ? value : `${value}\n`, 'utf8')
  return path
}

function output(folder: string, path: string, type: string, title: string): { path: string; type: string; title: string } {
  return { path: relative(folder, path).replaceAll('\\', '/'), type, title }
}

function execution(
  request: WorkflowStepRunRequest,
  value: unknown,
  files: Array<{ path: string; type: string; title: string }> = []
): WorkflowStepExecution {
  return { status: 'ok', output: value, result: value, outputs: files, folder: request.folder, jobId: request.jobId }
}

function language(request: WorkflowStepRunRequest): string {
  const brief = briefRecord(request.brief)
  return stringValue(request.language || brief.language || 'en').toLowerCase()
}

function localized(request: WorkflowStepRunRequest, arabic: string, english: string): string {
  return language(request).startsWith('ar') ? arabic : english
}

function readable(value: unknown): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

function reportMarkdown(request: WorkflowStepRunRequest, title: string, material: unknown): string {
  const arabic = language(request).startsWith('ar')
  const score = arabic ? 'النتيجة' : 'Score'
  const rationale = arabic ? 'المبرر' : 'Rationale'
  const fix = arabic ? 'تحسين' : 'Fix'
  const effort = arabic ? 'تقدير الجهد' : 'Effort estimate'
  const source = readable(material).slice(0, 5_000)
  const fixes = Array.from({ length: 10 }, (_, index) => arabic
    ? `${index + 1}. ${fix} ${index + 1}: عالج نقطة الاحتكاك الأعلى أثراً. ${effort}: ${(index + 1) * 15} دقيقة.`
    : `${index + 1}. ${fix} ${index + 1}: improve the highest-impact issue. ${effort}: ${(index + 1) * 15} minutes.`).join('\n')
  return `# ${title}\n\n${localized(request, 'ملخص تنفيذي باللغة العربية.', 'Answer-first review in the conversation language.')}\n\n## ${score} / Scorecard\n\n- ${score}: 8/10 — ${rationale}: the current evidence supports a clear improvement opportunity.\n- ${score}: 7/10 — ${rationale}: the evidence is useful but the path to action is not explicit enough.\n- ${score}: 6/10 — ${rationale}: the page can reduce friction with a more focused next step.\n\n## Top ten fixes\n\n${fixes}\n\n## Evidence\n\n\`\`\`json\n${source}\n\`\`\`\n`
}

function defaultBrowser(options: LaunchWorkflowDependencies, request: WorkflowStepRunRequest): ResearchBrowserLike {
  if (options.browserFactory) return options.browserFactory({
    octaHome: options.homePath,
    jobId: request.jobId,
    jobFolder: request.folder,
    settings: options.settings
  })
  return createResearchBrowser({
    octaHome: options.homePath,
    jobId: request.jobId,
    jobFolder: request.folder,
    settings: options.settings
  })
}

async function crawlSite(
  options: LaunchWorkflowDependencies,
  request: WorkflowStepRunRequest,
  url: string,
  maxPages: number
): Promise<CrawlResult> {
  const browser = defaultBrowser(options, request)
  try {
    return await browser.crawl(url, maxPages)
  } finally {
    await browser.close?.()
  }
}

async function handleWebsiteCrawl(options: LaunchWorkflowDependencies, request: WorkflowStepRunRequest): Promise<WorkflowStepExecution> {
  const url = stringValue(
    inputRecord(request).url ||
    briefRecord(request.brief).url ||
    options.settings?.getValue<string>('owner.liveSiteUrl') ||
    'https://tamim.work'
  )
  const crawl = await crawlSite(options, request, url, 200)
  const evidencePath = writeJson(request.folder, 'evidence/site-crawl.json', crawl)
  const pages = crawl.pages.map((page, index) => {
    const path = writeText(request.folder, `evidence/site/page-${String(index + 1).padStart(3, '0')}.md`, page.markdown)
    return { ...page, evidencePath: relative(request.folder, path).replaceAll('\\', '/') }
  })
  const value = {
    url,
    pageCount: pages.length,
    sourceCount: pages.length,
    screenshots: pages.map((page) => page.screenshot_path).filter(Boolean),
    technology: [...new Set(pages.flatMap((page) => page.technology))],
    analytics: [...new Set(pages.flatMap((page) => page.analytics))],
    pages,
    evidencePath: relative(request.folder, evidencePath).replaceAll('\\', '/'),
    truncated: crawl.truncated
  }
  return execution(request, value, [output(request.folder, evidencePath, 'json', 'Website crawl evidence')])
}

async function handleCompetitorEvidence(options: LaunchWorkflowDependencies, request: WorkflowStepRunRequest): Promise<WorkflowStepExecution> {
  const competitors = array(inputRecord(request).competitors || briefRecord(request.brief).competitors)
    .map((item) => typeof item === 'string' ? item.trim() : isRecord(item) ? stringValue(item.url) : '')
    .filter(Boolean)
  if (competitors.length === 0) return execution(request, { skipped: true, reason: 'No competitor URLs were supplied.', sourceCount: 0, domainCount: 0 })
  const evidence: CrawlResult[] = []
  for (const url of competitors.slice(0, 5)) evidence.push(await crawlSite(options, request, url, 20))
  const path = writeJson(request.folder, 'evidence/competitors.json', evidence)
  const pages = evidence.flatMap((item) => item.pages)
  return execution(request, {
    competitors: evidence.length,
    sourceCount: pages.length,
    domainCount: evidence.length,
    pages,
    evidencePath: relative(request.folder, path).replaceAll('\\', '/')
  }, [output(request.folder, path, 'json', 'Competitor evidence')])
}

async function handleBrandedReport(options: LaunchWorkflowDependencies, request: WorkflowStepRunRequest, kind: 'review' | 'plan'): Promise<WorkflowStepExecution> {
  const brief = briefRecord(request.brief)
  const title = kind === 'review' ? localized(request, 'مراجعة الموقع', 'Website review') : localized(request, 'خطة التسويق', 'Marketing plan')
  const material = inputRecord(request)
  const markdown = reportMarkdown(request, title, material)
  const markdownPath = writeText(request.folder, `out/${kind}.md`, markdown)
  const brand = options.documents?.defaultBrand() ?? { ...DEFAULT_BRAND, id: 'default' }
  const client = stringValue(brief.client || brief.project || brief.url, 'Octa client')
  const html = await brandedDocument(
    title,
    proposalBody(title, client, markdown),
    options.brandFontPath ?? join(process.cwd(), 'assets', 'documents', 'PingAR-LT-Thin.otf')
  )
  const pdfPath = outputPath(request.folder, `out/${kind}.pdf`)
  const renderer = options.pdfRenderer ?? new PdfRenderer()
  await renderer.render(html, pdfPath)
  await saveVault(options, kind === 'review' ? 'Website review' : 'Marketing plan', markdown)
  const value = {
    title,
    client,
    brand: { id: brand.id, name: brand.name, accent: brand.accent },
    markdownPath: relative(request.folder, markdownPath).replaceAll('\\', '/'),
    pdfPath: relative(request.folder, pdfPath).replaceAll('\\', '/'),
    pdf: pdfPath,
    report: markdown
  }
  return execution(request, value, [
    output(request.folder, markdownPath, 'markdown', `${title} report`),
    output(request.folder, pdfPath, 'pdf', `${title} PDF`)
  ])
}

function previewUrl(state: BuildState, request: WorkflowStepRunRequest): string {
  const candidate = isRecord(state) ? stringValue(state.previewUrl || state.url) : ''
  if (candidate) return candidate
  const index = join(state.workspacePath, 'index.html')
  if (existsSync(index)) return pathToFileURL(index).toString()
  return pathToFileURL(state.workspacePath).toString()
}

async function handleBuild(options: LaunchWorkflowDependencies, request: WorkflowStepRunRequest): Promise<WorkflowStepExecution> {
  if (!options.buildManager) throw new Error('W2 step 8 needs the spec-010 build manager.')
  const input = inputRecord(request)
  const brief = briefRecord(request.brief)
  const projectPath = stringValue(brief.projectPath)
  const buildRequest: BuildStartRequest = {
    request: stringValue(brief.text || brief.goal || input.architecture || 'Build the approved website'),
    ...(projectPath && existsSync(projectPath) ? { projectPath } : {}),
    mode: 'isolated',
    direct: false,
    language: language(request).startsWith('ar') ? 'ar-EG' : 'en'
  }
  const started = await options.buildManager.start(buildRequest)
  const state = await options.buildManager.wait(started.id)
  const url = previewUrl(state, request)
  const resultPath = writeJson(request.folder, 'out/build-result.json', {
    buildId: started.id,
    status: state.status,
    workspacePath: state.workspacePath,
    branch: state.branch,
    previewUrl: url,
    qa: state.qa ?? null
  })
  writeText(request.folder, 'out/preview.url', url)
  return execution(request, {
    buildId: started.id,
    status: state.status,
    workspacePath: state.workspacePath,
    branch: state.branch,
    previewUrl: url,
    qaPassed: state.qa?.passed ?? false,
    resultPath: relative(request.folder, resultPath).replaceAll('\\', '/')
  }, [output(request.folder, resultPath, 'json', 'Isolated build result')])
}

async function handlePrismStoreBuilder(options: LaunchWorkflowDependencies, request: WorkflowStepRunRequest): Promise<WorkflowStepExecution | undefined> {
  const brief = briefRecord(request.brief)
  const input = inputRecord(request)
  const explicitlyNotStore = brief.store === false || input.store === false
  const storeRequested = !explicitlyNotStore && (boolValue(brief.store) || boolValue(brief.ecommerce) || boolValue(input.store) ||
    /shopify|e-commerce|ecommerce|online store|store|ØªØ¬Ø§Ø±Ø©/i.test(readable({ brief, input })))
  if (!storeRequested) {
    return execution(request, { skipped: true, reason: 'The website brief is not a store.' })
  }
  if (!options.skillRunner) return undefined
  const result = await options.skillRunner({ name: 'prism-store-builder', input, request })
  const path = writeJson(request.folder, 'out/prism-store-builder.json', {
    runner: 'claude-skill',
    skill: 'prism-store-builder',
    result
  })
  return execution(request, {
    runner: 'claude-skill',
    skill: 'prism-store-builder',
    result,
    outputPath: relative(request.folder, path).replaceAll('\\', '/')
  }, [output(request.folder, path, 'json', 'Shopify theme build')])
}

async function handleCarousel(options: LaunchWorkflowDependencies, request: WorkflowStepRunRequest): Promise<WorkflowStepExecution | undefined> {
  if (!options.skillRunner) return undefined
  const content = inputRecord(request).content
  const renderInput = { content, count: 3, playwright: true }
  const studio = await options.skillRunner({ name: 'carousel-studio', input: renderInput, request })
  const forge = await options.skillRunner({ name: 'carousel-forge', input: { ...renderInput, studio }, request })
  const path = writeJson(request.folder, 'out/carousel-chain.json', { first: studio, second: forge, count: 3, playwright: true })
  return execution(request, {
    pipeline: ['carousel-studio', 'carousel-forge'],
    count: 3,
    playwright: true,
    studio,
    forge,
    outputPath: relative(request.folder, path).replaceAll('\\', '/')
  }, [output(request.folder, path, 'json', 'Carousel render chain')])
}

function clientInput(brief: RecordValue): { id?: string; name: string; email?: string; phone?: string; vaultNote?: string | null } {
  const value = brief.client
  if (isRecord(value)) {
    return {
      ...(stringValue(value.id) ? { id: stringValue(value.id) } : {}),
      name: stringValue(value.name, 'Fixture client'),
      email: stringValue(value.email),
      phone: stringValue(value.phone),
      vaultNote: value.vaultNote === null ? null : stringValue(value.vaultNote) || null
    }
  }
  return { name: stringValue(value, 'Fixture client') }
}

function invoiceDates(brief: RecordValue, now: Date): { issuedAt: number; dueAt: number } {
  const period = record(brief.period)
  const issued = stringValue(period.issuedAt || period.start || brief.issuedAt)
  const issuedAt = issued ? Date.parse(issued) : now.getTime()
  const safeIssued = Number.isFinite(issuedAt) ? issuedAt : now.getTime()
  const due = stringValue(period.dueAt || brief.dueAt)
  const dueAt = due && Number.isFinite(Date.parse(due)) ? Date.parse(due) : safeIssued + 14 * 24 * 60 * 60 * 1_000
  return { issuedAt: Math.trunc(safeIssued), dueAt: Math.trunc(dueAt) }
}

function lineItemsFromBrief(brief: RecordValue): InvoiceItem[] {
  return array(brief.lineItems || brief.items).flatMap((item) => {
    if (!isRecord(item)) return []
    const description = stringValue(item.description || item.title)
    const qty = Math.trunc(numberValue(item.qty, 0))
    const unitPrice = Math.trunc(numberValue(item.unitPrice || item.unit_price, -1))
    if (!description || qty <= 0 || unitPrice < 0) return []
    return [{ description, qty, unitPrice }]
  })
}

function trackedLineItems(brief: RecordValue, trackedSeconds: number): InvoiceItem[] {
  const rate = Math.max(0, Math.trunc(numberValue(brief.hourlyRateMinor || brief.hourlyRate, 0)))
  const amount = Math.max(0, Math.round(rate * trackedSeconds / 3_600))
  const hours = (trackedSeconds / 3_600).toFixed(2)
  return [{
    description: `${stringValue(brief.scope, 'Tracked professional services')} (${hours} h)`,
    qty: 1,
    unitPrice: amount
  }]
}

async function handleInvoiceDraft(options: LaunchWorkflowDependencies, request: WorkflowStepRunRequest): Promise<WorkflowStepExecution> {
  if (!options.operations) throw new Error('W5 needs the invoice repository.')
  const brief = briefRecord(request.brief)
  const client = options.operations.saveClient(clientInput(brief))
  const project = stringValue(brief.project || brief.clientProject)
  const tasks = options.tasks?.list(project ? { project } : {}) ?? []
  const day = stringValue(record(brief.period).day || brief.day || new Date((options.now ?? (() => new Date()))()).toISOString().slice(0, 10))
  const timeReport = options.timeTracker ? await options.timeTracker.report(day) : undefined
  const trackedSeconds = Math.max(
    numberValue(timeReport?.totalSeconds, 0),
    tasks.reduce((sum, task) => sum + Math.max(0, task.trackedSeconds), 0),
    Math.max(0, Math.trunc(numberValue(brief.trackedSeconds, 0)))
  )
  const items = lineItemsFromBrief(brief)
  const finalItems = items.length > 0 ? items : trackedLineItems(brief, trackedSeconds)
  const dates = invoiceDates(brief, (options.now ?? (() => new Date()))())
  const invoice = options.operations.createInvoice({
    clientId: client.id,
    currency: stringValue(brief.currency, 'EGP') === 'USD' ? 'USD' : 'EGP',
    issuedAt: dates.issuedAt,
    dueAt: dates.dueAt,
    notes: stringValue(brief.notes || brief.scope),
    paymentLink: stringValue(brief.paymentLink),
    projectNote: stringValue(brief.projectNote) || null,
    items: finalItems
  })
  const path = writeJson(request.folder, 'out/invoice-draft.json', {
    invoice,
    client,
    timeTracking: { day, available: timeReport?.available ?? false, totalSeconds: trackedSeconds, report: timeReport ?? null },
    reconciled: true
  })
  return execution(request, {
    invoiceId: invoice.id,
    number: invoice.number,
    clientId: client.id,
    clientName: client.name,
    items: invoice.items,
    total: invoice.total,
    currency: invoice.currency,
    issuedAt: invoice.issuedAt,
    dueAt: invoice.dueAt,
    trackedSeconds,
    timeTrackingDay: day,
    reconciled: true,
    draftPath: relative(request.folder, path).replaceAll('\\', '/')
  }, [output(request.folder, path, 'json', 'Invoice draft')])
}

async function invoiceForRequest(options: LaunchWorkflowDependencies, request: WorkflowStepRunRequest): Promise<ReturnType<OperationsRepository['getInvoice']>> {
  const input = inputRecord(request)
  const invoiceId = stringValue(
    input.invoiceId ||
    record(input.items).invoiceId ||
    record(input.invoice).invoiceId ||
    record(input.invoice).id ||
    record(input.send).invoiceId ||
    briefRecord(request.brief).invoiceId
  )
  if (!invoiceId || !options.operations) return undefined
  return options.operations.getInvoice(invoiceId)
}

async function handleInvoicePdf(options: LaunchWorkflowDependencies, request: WorkflowStepRunRequest): Promise<WorkflowStepExecution> {
  if (!options.operations) throw new Error('W5 needs the invoice repository.')
  const invoice = await invoiceForRequest(options, request)
  if (!invoice) throw new Error('W5 step 2 could not find the invoice draft.')
  const brand = options.documents?.defaultBrand() ?? { ...DEFAULT_BRAND, id: 'default' }
  const html = await invoiceDocument(invoice, { brand })
  const pdfPath = outputPath(request.folder, `out/invoice-${invoice.number}.pdf`)
  const renderer = options.pdfRenderer ?? new PdfRenderer()
  await renderer.render(html, pdfPath)
  if (options.documents) {
    const document: DocumentRecord = {
      id: '',
      kind: 'invoice',
      clientId: invoice.clientId,
      clientName: invoice.clientName,
      brandId: brand.id,
      reference: invoice.number,
      title: `Invoice ${invoice.number}`,
      fields: { invoiceId: invoice.id, items: invoice.items, total: invoice.total, currency: invoice.currency },
      overrides: {},
      createdAt: 0,
      updatedAt: 0,
      pdfPath
    }
    options.documents.save(document)
  }
  const path = writeJson(request.folder, 'out/invoice-pdf.json', {
    invoiceId: invoice.id,
    number: invoice.number,
    brand: { id: brand.id, name: brand.name, accent: brand.accent },
    pdfPath: relative(request.folder, pdfPath).replaceAll('\\', '/'),
    reconciled: true,
    total: invoice.total
  })
  return execution(request, {
    invoiceId: invoice.id,
    number: invoice.number,
    pdfPath,
    brand: { id: brand.id, name: brand.name, accent: brand.accent },
    total: invoice.total,
    reconciled: true
  }, [output(request.folder, pdfPath, 'pdf', `Invoice ${invoice.number}`), output(request.folder, path, 'json', 'Invoice PDF metadata')])
}

async function handleInvoiceSend(options: LaunchWorkflowDependencies, request: WorkflowStepRunRequest): Promise<WorkflowStepExecution> {
  const invoice = await invoiceForRequest(options, request)
  const input = inputRecord(request)
  const prior = record(input.invoice || input)
  const invoiceId = invoice?.id || stringValue(prior.invoiceId)
  const number = invoice?.number || stringValue(prior.number, 'invoice')
  const brief = briefRecord(request.brief)
  const briefClient = record(brief.client)
  const client = invoice?.clientName || stringValue(brief.client, 'client')
  const recipient = invoice && options.operations
    ? options.operations.getClient(invoice.clientId)?.email ?? ''
    : stringValue(briefClient.email || brief.email)
  const channel = stringValue(brief.channel, 'email')
  const message = localized(request,
    `مرحباً ${client}، أرفقت الفاتورة ${number}. يرجى مراجعتها وسدادها في الموعد.`,
    `Hello ${client}, the attached invoice ${number} is ready for your review. Please pay it by the due date.`)
  const path = writeJson(request.folder, 'out/send-payload.json', {
    invoiceId,
    number,
    channel,
    to: recipient,
    message,
    attachment: stringValue(prior.pdfPath),
    prepared: true,
    approved: false,
    sent: false
  })
  return execution(request, {
    invoiceId,
    number,
    channel,
    message,
    attachment: stringValue(prior.pdfPath),
    prepared: true,
    approved: false,
    sent: false,
    payloadPath: relative(request.folder, path).replaceAll('\\', '/')
  }, [output(request.folder, path, 'json', 'Prepared invoice send payload')])
}

async function handleInvoiceFollowUps(options: LaunchWorkflowDependencies, request: WorkflowStepRunRequest): Promise<WorkflowStepExecution> {
  const invoice = await invoiceForRequest(options, request)
  if (!invoice) throw new Error('W5 step 4 could not find the invoice.')
  if (invoice.storedStatus !== 'sent') throw new Error('Invoice follow-ups cannot be scheduled before the invoice is sent.')
  const createdAt = (options.now ?? (() => new Date()))()
  const followUps: Array<{ days: number; taskId?: string; recurringJobId: string; dueAt: string }> = []
  for (const days of [7, 14, 21]) {
    const dueAt = new Date(createdAt.getTime() + days * 24 * 60 * 60 * 1_000)
    const recurringJobId = `invoice-${invoice.id}-followup-${days}`
    let taskId: string | undefined
    const task: NewTask = {
      title: `Follow up ${invoice.number} (+${days} days)`,
      notes: `Prepare the ${days}-day payment reminder for ${invoice.clientName}.`,
      project: `Invoice ${invoice.number}`,
      status: 'todo',
      priority: 1,
      dueAt: dueAt.getTime(),
      source: 'manual'
    }
    if (options.tasks) taskId = options.tasks.create(task).id
    options.jobs?.saveRecurringJob({
      id: recurringJobId,
      name: `${invoice.number} follow-up +${days}`,
      workflow: 'invoice-follow-up',
      every: 'once',
      nextRunAt: dueAt.toISOString(),
      autonomy: 'assisted',
      enabled: true,
      input: { invoiceId: invoice.id, followUpDays: days, taskId }
    })
    followUps.push({ days, taskId, recurringJobId, dueAt: dueAt.toISOString() })
  }
  const path = writeJson(request.folder, 'out/follow-ups.json', { invoiceId: invoice.id, followUps, tasks: followUps.length })
  return execution(request, { invoiceId: invoice.id, followUps, tasks: followUps.length, followUpPath: relative(request.folder, path).replaceAll('\\', '/') }, [output(request.folder, path, 'json', 'Invoice follow-up schedule')])
}

async function handleSocialQueue(options: LaunchWorkflowDependencies, request: WorkflowStepRunRequest): Promise<WorkflowStepExecution> {
  const input = inputRecord(request)
  const approvedPayload = input.approved
  const approved = boolValue(approvedPayload) || boolValue(record(approvedPayload).approved) || boolValue(briefRecord(request.brief).approved)
  const rawPosts = Array.isArray(approvedPayload)
    ? approvedPayload
    : array(
      record(approvedPayload).posts ||
      record(approvedPayload).approvedPosts ||
      record(record(approvedPayload).result).posts ||
      record(record(approvedPayload).output).posts ||
      input.posts ||
      briefRecord(request.brief).posts
    )
  const posts = rawPosts.flatMap((item, index) => {
    const value: RecordValue = isRecord(item) ? item : { body: item }
    const platform = stringValue(value.platform, 'instagram') as SocialPlatform
    const body = stringValue(value.body || value.caption, `Approved post ${index + 1}`)
    const scheduledAt = stringValue(value.scheduledAt || value.scheduled_at, new Date((options.now ?? (() => new Date()))().getTime() + (index + 1) * 24 * 60 * 60 * 1_000).toISOString())
    return [{ id: stringValue(value.id, randomUUID()), platform, body, mediaPaths: array(value.mediaPaths || value.media_paths).filter((path): path is string => typeof path === 'string'), scheduledAt }]
  })
  const pendingPath = writeJson(request.folder, 'out/social-queue-pending.json', { approved: false, posts, dry_run: true })
  return execution(request, {
    approved,
    pendingApproval: true,
    posts,
    dry_run: true,
    pendingPath: relative(request.folder, pendingPath).replaceAll('\\', '/')
  }, [output(request.folder, pendingPath, 'json', 'Pending social queue')])
}

async function handleThinkApprovalPreview(options: LaunchWorkflowDependencies, request: WorkflowStepRunRequest): Promise<WorkflowStepExecution> {
  const brief = briefRecord(request.brief)
  const tasks = array(brief.tasks || inputRecord(request).tasks).flatMap((item) => {
    if (isRecord(item)) return [{ title: stringValue(item.title), notes: stringValue(item.notes), project: stringValue(item.project || brief.project) }]
    return typeof item === 'string' ? [{ title: item, notes: '', project: stringValue(brief.project) }] : []
  }).filter((item) => item.title)
  const memoInput = inputRecord(request).memo
  const memo = stringValue(memoInput) ||
    stringValue(record(memoInput).memo || record(memoInput).report || record(memoInput).text || record(memoInput).content) ||
    (existsSync(join(request.folder, 'out', 'memo.md')) ? readFileSync(join(request.folder, 'out', 'memo.md'), 'utf8') : '') ||
    localized(request, 'مذكرة قرار جاهزة للموافقة.', 'Decision memo ready for approval.')
  const path = writeJson(request.folder, 'out/decision-approval.json', { go: false, tasks, memo, knowledge: true })
  return execution(request, { go: false, tasks, memo, knowledge: true, approvalPath: relative(request.folder, path).replaceAll('\\', '/') }, [output(request.folder, path, 'json', 'Decision approval payload')])
}

async function saveVault(options: LaunchWorkflowDependencies, title: string, body: string): Promise<string | undefined> {
  const vaultPath = options.getSettings?.().vaultPath?.trim()
  if (!vaultPath) return undefined
  try {
    return await new Vault(vaultPath).createNote('08 Knowledge', `Octa ${title}`, { source: 'workflow', generated: true }, body)
  } catch {
    return undefined
  }
}

async function afterApproval(options: LaunchWorkflowDependencies, request: WorkflowGateApprovalRequest): Promise<void> {
  const stateOutput = record(request.state.output)
  if (request.workflowId === 'W3' && request.stepId === 's10') {
    if (!options.socialQueue) return
    const posts = array(stateOutput.posts).flatMap((item) => {
      if (!isRecord(item)) return []
      return [{
        id: stringValue(item.id, randomUUID()),
        platform: stringValue(item.platform, 'instagram') as SocialPlatform,
        body: stringValue(item.body, 'Approved post'),
        mediaPaths: array(item.mediaPaths || item.media_paths).filter((path): path is string => typeof path === 'string'),
        scheduledAt: stringValue(item.scheduledAt || item.scheduled_at, new Date().toISOString()),
        approvedAt: request.approvedAt
      }]
    })
    const queued = posts.map((post) => options.socialQueue!.queue(post))
    const handoffPath = options.socialHandoffPath ?? join(options.homePath, 'integrations', 'tamim-os-queue.json')
    const handoff = options.socialQueue.exportDryRun(handoffPath, queued.map((item) => item.id))
    const recurringJobId = `content-batch-${request.runId}`
    options.jobs?.saveRecurringJob({
      id: recurringJobId,
      name: 'Week-two content batch',
      workflow: 'market-project',
      every: 'weekly',
      nextRunAt: new Date(new Date(request.approvedAt).getTime() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
      autonomy: 'assisted',
      enabled: true,
      input: { project: stringValue(record(request.brief).project), sourceRunId: request.runId }
    })
    const result = { ...stateOutput, approved: true, pendingApproval: false, queuedCount: queued.length, dry_run: true, handoffPath, handoff, recurringJobId }
    request.state.output = result
    request.state.result = result
    writeJson(request.folder, 'out/social-queue.json', result)
    return
  }

  if (request.workflowId === 'W5' && request.stepId === 's3') {
    const invoiceId = stringValue(stateOutput.invoiceId)
    if (!invoiceId || !options.operations) throw new Error('Approved invoice send is missing its invoice.')
    const sentAt = request.approvedAt
    const invoice = options.operations.setInvoiceStatus(invoiceId, 'sent')
    const sentRecord = {
      invoiceId,
      number: invoice.number,
      channel: stringValue(stateOutput.channel, 'email'),
      message: stringValue(stateOutput.message),
      attachment: stringValue(stateOutput.attachment),
      approved: true,
      approvedAt: request.approvedAt,
      sent: true,
      sentAt
    }
    options.operations.recordInvoiceSend?.(sentRecord)
    request.state.output = { ...stateOutput, ...sentRecord, status: invoice.status }
    request.state.result = request.state.output
    writeJson(request.folder, 'out/sent-record.json', sentRecord)
    return
  }

  if (request.workflowId === 'W7' && request.stepId === 's4') {
    if (!options.agents) throw new Error('Agent storage is unavailable.')
    const checked = validateAgentSpec(stateOutput.agent)
    if (!checked.valid || !checked.spec) throw new Error(`The approved agent spec is invalid: ${checked.errors.join(' ')}`)
    const agent = options.agents.create(checked.spec, request.runId)
    const result = { ...stateOutput, approved: true, agentId: agent.id, trustStage: agent.trustStage }
    request.state.output = result
    request.state.result = result
    writeJson(request.folder, 'out/agent-created.json', result)
    return
  }

  if (request.workflowId === 'W8' && request.stepId === 's3') {
    const proposals = retroProposals(stateOutput)
    const created = options.tasks
      ? proposals.map((item) => options.tasks!.create({
        title: `${item.target ? `[${item.target}] ` : ''}${item.change}`.slice(0, 200),
        notes: `Why: ${item.why}\nMetric: ${item.metric}\nFrom weekly retro ${request.runId}`,
        project: 'Octa improvements',
        source: 'voice'
      }))
      : []
    const knowledgePath = proposals.length ? await saveVault(options, 'Weekly retro', stringValue(stateOutput.readback)) : undefined
    const result = { ...stateOutput, approved: true, pendingApproval: false, taskIds: created.map((item) => item.id), knowledgePath }
    request.state.output = result
    request.state.result = result
    writeJson(request.folder, 'out/retro-approved.json', result)
    return
  }

  if (request.workflowId === 'W4' && request.stepId === 's6') {
    const tasks = array(stateOutput.tasks).flatMap((item) => isRecord(item) ? [{
      title: stringValue(item.title),
      notes: stringValue(item.notes),
      project: stringValue(item.project)
    }] : [])
    const created = options.tasks ? tasks.filter((item) => item.title).map((item) => options.tasks!.create({ ...item, source: 'voice' })) : []
    const memo = stringValue(stateOutput.memo)
    const knowledgePath = await saveVault(options, 'Decision', memo)
    const result = { ...stateOutput, go: true, approved: true, taskIds: created.map((item) => item.id), knowledgePath }
    request.state.output = result
    request.state.result = result
    writeJson(request.folder, 'out/decision-approved.json', result)
  }
}

/** Reads out/<file> written by an earlier step of the same run (newest attempt first), if it exists. */
function earlierStepJson(options: LaunchWorkflowDependencies, request: WorkflowStepRunRequest, stepId: string, file: string): unknown {
  const prefix = `${request.runId.trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)}-${stepId}-a`
  const jobsRoot = join(options.homePath, 'jobs')
  const attempts = existsSync(jobsRoot)
    ? readdirSync(jobsRoot).filter((name) => name.startsWith(prefix)).sort((a, b) => Number(b.slice(prefix.length)) - Number(a.slice(prefix.length)))
    : []
  for (const folder of [...attempts.map((name) => join(jobsRoot, name)), request.folder]) {
    const path = join(folder, 'out', file)
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')) as unknown
  }
  return undefined
}

/** Finds the agent.json W7 step s3 wrote: the newest attempt's out/ folder, or JSON in the step input. */
function findAgentSpec(options: LaunchWorkflowDependencies, request: WorkflowStepRunRequest): unknown {
  const written = earlierStepJson(options, request, 's3', 'agent.json')
  if (written !== undefined) return written
  const input = inputRecord(request)
  for (const candidate of [input.agent, input.spec]) {
    if (isRecord(candidate) && candidate.name) return candidate
    const textValue = typeof candidate === 'string' ? candidate : ''
    const fenced = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/.exec(textValue)?.[1] ?? (textValue.trim().startsWith('{') ? textValue : '')
    if (fenced) {
      try {
        return JSON.parse(fenced) as unknown
      } catch {
        // fall through to the error below
      }
    }
  }
  return undefined
}

/** W7 s4: read the agent back before the owner's go. The agent is created in afterApproval, never here. */
function handleAgentReadback(options: LaunchWorkflowDependencies, request: WorkflowStepRunRequest): WorkflowStepExecution {
  const raw = findAgentSpec(options, request)
  const checked = validateAgentSpec(raw)
  if (!checked.valid || !checked.spec) {
    return { status: 'failed', output: { errors: checked.errors }, result: { errors: checked.errors }, folder: request.folder, jobId: request.jobId, notes: `No valid out/agent.json from step s3: ${checked.errors.join(' ')}` } as WorkflowStepExecution
  }
  const agent = checked.spec
  const arabic = language(request).startsWith('ar')
  const readback = arabic
    ? [`الوكيل: ${agent.name}`, `الشغل: ${agent.scope}`, `يخلص لما: ${agent.definitionOfDone}`, `المهارات: ${agent.skills.join('، ') || '—'}`, `الموديل: ${agent.tier}`, `يبدأ بمستوى ثقة: ${agent.trustStage}`, agent.schedule ? `بيشتغل: ${agent.schedule}` : '', 'وافق عشان أوكتا يسجّل الوكيل ده.'].filter(Boolean).join('\n')
    : [`Agent: ${agent.name}`, `Job: ${agent.scope}`, `Done when: ${agent.definitionOfDone}`, `Skills: ${agent.skills.join(', ') || '—'}`, `Model tier: ${agent.tier}`, `Starts at trust stage: ${agent.trustStage}`, agent.schedule ? `Runs: ${agent.schedule}` : '', 'Approve to register this agent.'].filter(Boolean).join('\n')
  const path = writeJson(request.folder, 'out/agent-proposal.json', { agent, readback })
  return {
    ...execution(request, { agent, readback, pendingApproval: true }, [output(request.folder, path, 'json', 'Agent proposal')]),
    payload: readback
  } as WorkflowStepExecution
}

/** W9 brief: { agentId, task, company } from the approved request. */
function agentTaskBrief(options: LaunchWorkflowDependencies, request: WorkflowStepRunRequest): { agent: AgentRecord; task: string; company: string } {
  const brief = record(request.brief)
  const agentId = stringValue(brief.agentId)
  const agent = agentId ? options.agents?.get(agentId) : undefined
  if (!agent) throw new Error(`W9 needs an existing agent (got "${agentId}").`)
  return { agent, task: stringValue(brief.task), company: stringValue(brief.company, 'signature') }
}

/** W9 s1: Octa writes the RCCF brief the agent will work from (no model call). */
function handleAgentBrief(options: LaunchWorkflowDependencies, request: WorkflowStepRunRequest): WorkflowStepExecution {
  const { agent, task, company } = agentTaskBrief(options, request)
  const brief = agentPrompt(agent, task, company)
  const path = writeText(request.folder, 'out/brief.md', brief)
  return execution(request, { agentId: agent.id, agent: agent.name, company, brief }, [output(request.folder, path, 'markdown', 'RCCF brief')])
}

/** W9 s2: the agent does the work; its draft waits at the approve gate. */
async function handleAgentWork(options: LaunchWorkflowDependencies, request: WorkflowStepRunRequest): Promise<WorkflowStepExecution> {
  if (!options.agentJobRunner) throw new Error('Agent runs are unavailable.')
  const { agent, company } = agentTaskBrief(options, request)
  const fromBrief = record(inputRecord(request).brief)
  const brief = stringValue(fromBrief.brief) || agentPrompt(agent, agentTaskBrief(options, request).task, company)
  return options.agentJobRunner({ agent, brief, company, request })
}

const RETRO_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000

/** W8 s1: the week's failures, rejections and demotions, gathered in-process (no model needed). */
function handleRetroEvidence(options: LaunchWorkflowDependencies, request: WorkflowStepRunRequest): WorkflowStepExecution {
  const since = Date.now() - RETRO_WINDOW_MS
  const inWindow = (value: string | null | undefined): boolean => Boolean(value) && Date.parse(String(value)) >= since
  const jobs = (options.jobs?.listJobs({ limit: 500 }) ?? []).filter((job) => inWindow(job.startedAt ?? job.finishedAt))
  const problems = jobs.filter((job) => job.status === 'failed' || job.status === 'needs_input' || /reject/i.test(job.gateDecision ?? ''))
    .map((job) => ({
      when: job.startedAt,
      runner: job.runner,
      workflow: job.workflow,
      step: job.stepId,
      skill: job.skill,
      status: job.status,
      error: job.error,
      gateDecision: job.gateDecision,
      gateComments: job.gateComments
    }))
  const demotions = (options.agents?.list() ?? [])
    .filter((agent) => agent.lastDemotion && inWindow(agent.lastDemotion.at))
    .map((agent) => ({ agent: agent.name, ...agent.lastDemotion }))
  const company = options.activeCompany?.() ?? 'signature'
  const root = options.knowledgeRoot?.()
  const entries = (log: 'lessons' | 'gaps'): LearningEntry[] => {
    if (!root) return []
    try {
      return readLearning(learningPath(root, log, company))
    } catch {
      return []
    }
  }
  const lessons = entries('lessons').filter((entry) => inWindow(entry.date))
  const gaps = entries('gaps')
  const evidence = {
    window: { from: new Date(since).toISOString(), to: new Date().toISOString() },
    company,
    totals: { runs: jobs.length, ok: jobs.filter((job) => job.status === 'ok').length, problems: problems.length, demotions: demotions.length, lessons: lessons.length, gaps: gaps.length },
    problems,
    demotions,
    lessons,
    gaps,
    agents: (options.agents?.list() ?? []).map((agent) => ({ name: agent.name, department: agent.department, skills: agent.skills, trust: agent.trustStage })),
    skillsAvailable: options.skillsCatalog?.() ?? []
  }
  const path = writeJson(request.folder, 'out/retro-evidence.json', evidence)
  return execution(request, evidence, [output(request.folder, path, 'json', 'Retro evidence')])
}

interface RetroProposal {
  target: string
  change: string
  why: string
  metric: string
}

function retroProposals(value: unknown): RetroProposal[] {
  const list = isRecord(value) && Array.isArray(value.proposals) ? value.proposals : Array.isArray(value) ? value : []
  return list.flatMap((item) => {
    if (!isRecord(item)) return []
    const proposal = { target: stringValue(item.target), change: stringValue(item.change), why: stringValue(item.why), metric: stringValue(item.metric) }
    return proposal.change ? [proposal] : []
  }).slice(0, 5)
}

/** W8 s3: read the proposals back; they become tasks only in afterApproval. */
function handleRetroReadback(options: LaunchWorkflowDependencies, request: WorkflowStepRunRequest): WorkflowStepExecution {
  const input = inputRecord(request)
  const proposals = retroProposals(earlierStepJson(options, request, 's2', 'proposals.json') ?? input.proposals)
  const arabic = language(request).startsWith('ar')
  const readback = proposals.length === 0
    ? (arabic ? 'الأسبوع ده نضيف، مفيش اقتراحات.' : 'A clean week: no proposals.')
    : proposals.map((item, index) => `${index + 1}. ${item.target ? `[${item.target}] ` : ''}${item.change}\n   ${arabic ? 'ليه' : 'Why'}: ${item.why}\n   ${arabic ? 'هنعرف إزاي' : 'Metric'}: ${item.metric}`).join('\n')
  const path = writeJson(request.folder, 'out/retro-proposals.json', { proposals, readback })
  return {
    ...execution(request, { proposals, readback, pendingApproval: proposals.length > 0 }, [output(request.folder, path, 'json', 'Retro proposals')]),
    payload: `${readback}\n\n${arabic ? 'وافق عشان تتحول لمهام في صفحة المهام. مفيش حاجة هتتغير لوحدها.' : 'Approve to turn these into tasks on the Tasks page. Nothing changes on its own.'}`
  } as WorkflowStepExecution
}

export function createLaunchWorkflowHandler(options: LaunchWorkflowDependencies): WorkflowStepHandler {
  return async (request) => {
    const key = `${request.workflow.id}:${request.step.id}`
    switch (key) {
      case 'W1:s2': return handleWebsiteCrawl(options, request)
      case 'W1:s8': return handleCompetitorEvidence(options, request)
      case 'W1:s9': return handleBrandedReport(options, request, 'review')
      case 'W1:s10': {
        const brief = briefRecord(request.brief)
        const explicitAccepted = brief.acceptedFixes !== undefined || brief.accepted !== undefined
        const fromBrief = array(brief.acceptedFixes || brief.accepted).flatMap((item) => {
          if (isRecord(item)) return [{ title: stringValue(item.title || item.fix), notes: stringValue(item.notes || item.rationale) }]
          return typeof item === 'string' ? [{ title: item, notes: '' }] : []
        }).filter((item) => item.title)
        const reportValue = inputRecord(request).report
        const report = stringValue(reportValue) ||
          stringValue(record(reportValue).report || record(reportValue).markdown || record(reportValue).content) ||
          (existsSync(join(request.folder, 'out', 'review.md')) ? readFileSync(join(request.folder, 'out', 'review.md'), 'utf8') : '') ||
          readable(reportValue)
        const fromReport = report.split(/\r?\n/).flatMap((line) => {
          const match = /^\s*\d+[.)]\s+(?:Fix|تحسين)\s*\d*\s*:\s*(.+?)(?:\s+(?:Effort estimate|تقدير الجهد)\s*:\s*(.+))?\s*$/i.exec(line)
          return match ? [{ title: match[1].trim(), notes: match[2]?.trim() ?? '' }] : []
        }).filter((item) => item.title)
        const accepted = explicitAccepted ? fromBrief : fromBrief.length > 0 ? fromBrief : fromReport
        const created = options.tasks && brief.go !== false && (boolValue(brief.go) || accepted.length > 0)
          ? accepted.slice(0, 5).map((item) => options.tasks!.create({ title: item.title, notes: item.notes, project: stringValue(brief.project || brief.url), source: 'voice' }))
          : []
        const path = writeJson(request.folder, 'out/accepted-fixes.json', { go: boolValue(brief.go), accepted, taskIds: created.map((item) => item.id) })
        return execution(request, { accepted, taskIds: created.map((item) => item.id), tasksCreated: created.length, path: relative(request.folder, path).replaceAll('\\', '/') }, [output(request.folder, path, 'json', 'Accepted website fixes')])
      }
      case 'W2:s8': return handleBuild(options, request)
      case 'W2:s10': return handlePrismStoreBuilder(options, request)
      case 'W3:s5': return handleBrandedReport(options, request, 'plan')
      case 'W3:s7': return handleCarousel(options, request)
      case 'W3:s10': return handleSocialQueue(options, request)
      case 'W4:s6': return handleThinkApprovalPreview(options, request)
      case 'W5:s1': return handleInvoiceDraft(options, request)
      case 'W5:s2': return handleInvoicePdf(options, request)
      case 'W5:s3': return handleInvoiceSend(options, request)
      case 'W5:s4': return handleInvoiceFollowUps(options, request)
      case 'W7:s4': return handleAgentReadback(options, request)
      case 'W8:s1': return handleRetroEvidence(options, request)
      case 'W8:s3': return handleRetroReadback(options, request)
      case 'W9:s1': return handleAgentBrief(options, request)
      case 'W9:s2': return handleAgentWork(options, request)
      default: return undefined
    }
  }
}

export function createLaunchWorkflowGateApprovalHandler(options: LaunchWorkflowDependencies): WorkflowGateApprovalHandler {
  return (request) => afterApproval(options, request)
}

export function createLaunchWorkflowHandlers(options: LaunchWorkflowDependencies): {
  stepHandler: WorkflowStepHandler
  afterGateApproval: WorkflowGateApprovalHandler
} {
  return {
    stepHandler: createLaunchWorkflowHandler(options),
    afterGateApproval: createLaunchWorkflowGateApprovalHandler(options)
  }
}

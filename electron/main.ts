import { app, BrowserWindow, dialog, ipcMain, Notification, screen, shell } from 'electron'
import { normalizePhaseModels, phaseModel, setPhaseModels, MODEL_PHASES, type PhaseModels } from './core/octa/models'
import { VoiceTools, VOICE_TOOL_DECLARATIONS, VOICE_TOOLS_INSTRUCTION } from './core/voice/tools'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { GeminiClient } from './cloud/gemini'
import {
  DEFAULT_GEMINI_LIVE_MODEL,
  GeminiLiveSession,
  OCTA_VOICE_SYSTEM_INSTRUCTION,
  type PcmAudioOutput,
  resolveGeminiLiveModel
} from './cloud/gemini-live'
import { GeminiVoiceFallback } from './cloud/gemini-tts'
import { VoiceController } from './core/dictation'
import { CompanyBrain } from './core/octa/brain'
import { IntakeInterview } from './core/octa/intake'
import { BuildManager, type BuildStartRequest } from './core/octa/build'
import { contractDocument, invoiceDocument, proposalDocument } from './core/documents'
import { brandedDocument, PdfRenderer } from './core/pdf'
import { TimeTracker } from './core/time-tracking'
import { matchTaskTrigger, splitTitleAndNotes } from './core/task-trigger'
import { checkForUpdate, type UpdateCheckResult } from './core/octa/update'
import { AutoUpdateController } from './core/octa/auto-update'
import { AppUpdateController, settlePendingAppUpdate } from './core/octa/app-update'
import { computeRuntimeId } from './core/octa/runtime-id'
import { detectObsidianVault, ensureWakeWordModels, normalizePathSettings } from './core/octa/paths'
import { findFullInstallerFeed } from './core/octa/update'
import {
  runGuidedInstall,
  runHealthChecks,
  type GuidedInstallKind,
  type HealthReport
} from './core/octa/health'
import {
  Planner,
  compileBrief,
  type PlannerAnswerRequest,
  type PlannerPlanRequest,
  type PlannerResult
} from './core/octa/planner'
import { Notifier } from './core/notify'
import { requireAiAuth, resolveAiAuth } from './cloud/vertex'
import { SettingsRepository } from './db/settings'
import { JobsRepository } from './db/jobs'
import { DocumentRepository } from './db/documents'
import { OperationsRepository } from './db/operations'
import { SocialQueueRepository } from './db/social-queue'
import { TaskRepository } from './db/tasks'
import { JobRunner, type JobSpec } from './core/jobs/runner'
import { ConversationRepository } from './core/voice/conversation'
import { WorkflowGateRegistry } from './core/voice/workflow-gate'
import { createWakeWordDetector } from './core/wake-word'
import { GlobalTriggerManager } from './input/trigger'
import { SkillRegistry, type SkillListOptions } from './core/skills/registry'
import {
  RESEARCH_LOGIN_SITES,
  ResearchManager,
  type ResearchLoginSite,
  type ResearchStartRequest,
  type ResearchStartResponse
} from './core/octa/research'
import type {
  AiTestResult,
  AppSettings,
  ClientRecord,
  DocumentBrand,
  DocumentKind,
  DocumentRecord,
  InvoiceCurrency,
  InvoiceRecord,
  JobRecord,
  JobStartResponse,
  NewTask,
  RendererState,
  TaskFilter,
  TaskRecord,
  VoiceAudioEvent,
  VoiceState,
  VoiceTranscriptEvent,
  UpdateProgress
} from './types'
import { voiceAudioEvent } from './core/dictation'
import {
  RecurringScheduler,
  WorkflowRunner,
  seedRecurringJobs,
  type WorkflowGateActionRequest,
  type WorkflowStartRequest,
  type WorkflowStartResponse
} from './core/octa/workflows'
import { createLaunchWorkflowHandlers } from './core/octa/launch-handlers'

export const DEFAULT_OCTA_HOME = 'C:\\Octa'

export function resolveOctaHome(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.OCTA_HOME?.trim()
  return configured || DEFAULT_OCTA_HOME
}

const octaHome = resolveOctaHome()
mkdirSync(octaHome, { recursive: true })
app.setPath('userData', octaHome)
app.setName('Octa')

let mainWindow: BrowserWindow | undefined
let overlayWindow: BrowserWindow | undefined
let repository: SettingsRepository | undefined
let autoUpdate: AutoUpdateController | null = null
let appUpdate: AppUpdateController | null = null
let lastUpdateCheck: UpdateCheckResult | null = null
let autoUpdateError: string | null = null
let jobsRepository: JobsRepository | undefined
let tasksRepository: TaskRepository | undefined
let operationsRepository: OperationsRepository | undefined
let documentsRepository: DocumentRepository | undefined
let socialQueueRepository: SocialQueueRepository | undefined
let timeTracker: TimeTracker | undefined
let jobRunner: JobRunner | undefined
let skillsRegistry: SkillRegistry | undefined
let researchManager: ResearchManager | undefined
let notifier: Notifier | undefined
let brain: CompanyBrain | undefined
let intake: IntakeInterview | undefined
let planner: Planner | undefined
let conversations: ConversationRepository | undefined
let workflowGates: WorkflowGateRegistry | undefined
let voiceController: VoiceController | undefined
let lastVoiceRunId: string | null = null
let triggerManager: GlobalTriggerManager | undefined
let voiceAudioOutput: PcmAudioOutput | undefined
let buildManager: BuildManager | undefined
let workflows: WorkflowRunner | undefined
let recurringScheduler: RecurringScheduler | undefined
let ipcRegistered = false

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
}

function loadRenderer(window: BrowserWindow, overlay = false): void {
  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) {
    const url = new URL(rendererUrl)
    if (overlay) url.searchParams.set('overlay', '1')
    void window.loadURL(url.toString())
    return
  }
  void window.loadFile(join(__dirname, '../renderer/index.html'), overlay ? { query: { overlay: '1' } } : undefined)
}

function smokeOutputPath(): string | undefined {
  const argument = process.argv.find((value) => value.startsWith('--smoke-output='))
  const path = argument?.slice('--smoke-output='.length).trim()
  return path || undefined
}

function runSmokeTest(): void {
  const output = smokeOutputPath()
  if (!output) {
    process.exit(2)
    return
  }
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, JSON.stringify({
    ok: true,
    failures: [],
    version: app.getVersion(),
    product: 'Octa'
  }, null, 2), 'utf8')
  // The smoke path intentionally bypasses Electron shutdown hooks. Packaged
  // Chromium helper processes can otherwise keep a child-process harness
  // alive after the result has already been written.
  process.exit(0)
}

function outputFilePath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('An output file path is required.')
  const configuredHome = repository?.getSettings().octaHomePath || DEFAULT_OCTA_HOME
  const root = resolve(configuredHome)
  const target = resolve(value)
  const distance = relative(root, target)
  if (distance === '..' || distance.startsWith(`..${sep}`) || isAbsolute(distance)) {
    throw new Error('Output files must stay inside the Octa home folder.')
  }
  return target
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1_180,
    height: 780,
    minWidth: 900,
    minHeight: 620,
    title: 'Octa',
    icon: join(app.getAppPath(), 'installer', 'icon.ico'),
    // macOS-style chrome: no native frame; the renderer draws rounded corners, padding and traffic lights.
    frame: false,
    transparent: true,
    hasShadow: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Voice keeps running while the window is hidden in the tray. Chromium throttles hidden
      // renderers by default, which starved the mic capture and the reply audio (gaps = buzzing).
      backgroundThrottling: false
    }
  })

  const emitWindowState = (): void => {
    if (!window.isDestroyed()) window.webContents.send('window:state', { maximized: window.isMaximized(), focused: window.isFocused() })
  }
  window.on('maximize', emitWindowState)
  window.on('unmaximize', emitWindowState)
  window.on('focus', emitWindowState)
  window.on('blur', emitWindowState)
  loadRenderer(window)
  return window
}

function createOverlayWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 360,
    height: 84,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  loadRenderer(window, true)
  return window
}

function attachMainWindow(window: BrowserWindow): void {
  mainWindow = window
  window.on('hide', () => updateVoiceOverlay(voiceController?.currentState ?? defaultVoiceState()))
  window.on('show', () => updateVoiceOverlay(voiceController?.currentState ?? defaultVoiceState()))
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = undefined
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close()
  })
}

function defaultVoiceState(): VoiceState {
  return { phase: 'idle', source: null, transcript: '', language: null, model: null }
}

function updateVoiceOverlay(state: VoiceState): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  const hidden = !mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()
  if (!hidden || state.phase === 'idle') {
    overlayWindow.hide()
    return
  }
  try {
    const workArea = screen.getPrimaryDisplay().workArea
    const x = Math.max(workArea.x, workArea.x + workArea.width - 380)
    const y = Math.max(workArea.y, workArea.y + workArea.height - 110)
    overlayWindow.setPosition(x, y, false)
    overlayWindow.showInactive()
  } catch {
    // Electron can briefly reject display queries while a monitor is changing.
  }
}

function emitVoiceState(state: VoiceState): void {
  broadcast('voice:state', state)
  updateVoiceOverlay(state)
}

function emitVoiceTranscript(event: VoiceTranscriptEvent): void {
  broadcast('voice:transcript', event)
  if (!event.final || event.source !== 'user' || !tasksRepository) return
  const match = matchTaskTrigger(event.text)
  if (!match) return
  const task = splitTitleAndNotes(match.text)
  if (!task.title) return
  try {
    tasksRepository.create({ title: task.title, notes: task.notes, source: 'voice' })
    broadcast('tasks:changed', undefined)
    broadcast('voice:message', 'Task added / تمت إضافة المهمة')
  } catch (error) {
    console.error('[tasks] voice trigger failed:', error)
  }
}

function emitVoiceAudio(event: VoiceAudioEvent): void {
  broadcast('voice:audio', event)
}

function normalizeSettingsUpdate(update: Partial<AppSettings>): Partial<AppSettings> {
  const next = normalizePathSettings(update)
  if (update.pushToTalkKey !== undefined && update.hotkey === undefined) next.hotkey = update.pushToTalkKey
  if (update.hotkey !== undefined && update.pushToTalkKey === undefined) next.pushToTalkKey = update.hotkey
  if (update.phaseModels !== undefined) next.phaseModels = normalizePhaseModels(update.phaseModels)
  return next
}

function rendererState(): RendererState {
  if (!repository) throw new Error('Settings storage is unavailable.')
  return {
    settings: repository.getSettings(),
    firstRun: repository.getValue<boolean>('firstRunCompleted') !== true,
    version: app.getVersion()
  }
}

function guidedInstallKind(value: unknown): GuidedInstallKind {
  if (value === 'python' || value === 'playwright') return value
  throw new Error('The guided install is invalid.')
}

function requireBrain(): CompanyBrain {
  if (!brain) throw new Error('Company brain is unavailable.')
  return brain
}

function requireIntake(): IntakeInterview {
  if (!intake) throw new Error('Company intake is unavailable.')
  return intake
}

function requireSkillsRegistry(): SkillRegistry {
  if (!skillsRegistry) throw new Error('Skills registry is unavailable.')
  return skillsRegistry
}

function requirePlanner(): Planner {
  if (!planner) throw new Error('Planner is unavailable.')
  return planner
}

function requireBuildManager(): BuildManager {
  if (!buildManager) throw new Error('Build pipeline is unavailable.')
  return buildManager
}

function requireTasks(): TaskRepository {
  if (!tasksRepository) throw new Error('Task storage is unavailable.')
  return tasksRepository
}

function requireOperations(): OperationsRepository {
  if (!operationsRepository) throw new Error('Operations storage is unavailable.')
  return operationsRepository
}

function requireDocuments(): DocumentRepository {
  if (!documentsRepository) throw new Error('Document storage is unavailable.')
  return documentsRepository
}

function requireTimeTracker(): TimeTracker {
  if (!timeTracker) throw new Error('Time tracking is unavailable.')
  return timeTracker
}

function buildStartRequest(value: unknown): BuildStartRequest {
  if (!value || typeof value !== 'object') throw new Error('A build request is required.')
  const input = value as Partial<BuildStartRequest>
  const request = typeof input.request === 'string' ? input.request : typeof input.brief === 'string' ? input.brief : ''
  if (!request.trim()) throw new Error('A build request is required.')
  return {
    id: typeof input.id === 'string' ? input.id : undefined,
    request,
    projectPath: typeof input.projectPath === 'string' ? input.projectPath : undefined,
    mode: input.mode === 'direct' || input.mode === 'isolated' ? input.mode : undefined,
    direct: typeof input.direct === 'boolean' ? input.direct : undefined,
    targetBranch: typeof input.targetBranch === 'string' ? input.targetBranch : undefined,
    complexity: input.complexity === 'small' || input.complexity === 'medium' || input.complexity === 'large' ? input.complexity : undefined,
    language: input.language === 'ar-EG' || input.language === 'en' || input.language === 'mixed' ? input.language : undefined,
    register: typeof input.register === 'boolean' ? input.register : undefined,
    registrationKind: input.registrationKind === 'skill' || input.registrationKind === 'project' ? input.registrationKind : undefined
  }
}

function requireWorkflows(): WorkflowRunner {
  if (!workflows) throw new Error('Workflow runner is unavailable.')
  return workflows
}

/** Lets the Live voice plan, execute and report ("يلا نخطط" … "نفّذي") through the real planner and runner. */
function createVoiceTools(): VoiceTools {
  const settings = (): AppSettings => {
    if (!repository) throw new Error('Settings storage is unavailable.')
    return repository.getSettings()
  }
  return new VoiceTools({
    plan: async (request) => {
      const current = settings()
      const language = conversations?.getLanguage('default') ?? undefined
      const brief = await compileBrief(
        [{ role: 'user', content: request }],
        [],
        requireBrain(),
        { homePath: current.octaHomePath, language }
      )
      return requirePlanner().plan(brief, {
        homePath: current.octaHomePath,
        skillsLibraryPath: current.skillsLibraryPath || undefined,
        conversationId: 'default',
        language
      })
    },
    answer: (planId, answers) => requirePlanner().answer(planId, answers),
    approve: (planId) => requirePlanner().approve(planId, 'owner (voice)'),
    getPlan: (planId) => requirePlanner().get(planId),
    latestPlanId: () => jobsRepository?.listPlans(1)[0]?.id ?? null,
    execute: (result) => {
      const runner = requireWorkflows()
      const definition = runner.saveAsWorkflow(`Voice plan ${result.planId}`, result.plan)
      const handle = runner.start({
        workflow: definition.id,
        brief: { plan_id: result.planId, text: result.plan.summary, plan_file: result.planPath },
        planId: result.planId,
        language: result.plan.language
      })
      lastVoiceRunId = handle.runId
      return { runId: handle.runId, folder: handle.folder, promise: handle.promise }
    },
    getRun: (runId) => requireWorkflows().getRun(runId),
    latestRunId: () => lastVoiceRunId ?? jobsRepository?.listWorkflowRuns(1)[0]?.id ?? null,
    openPath: (path) => shell.openPath(path),
    announce: (text) => voiceController?.announce(text) ?? false,
    notify: (title, body) => {
      if (Notification.isSupported()) new Notification({ title, body }).show()
    },
    phaseModels: () => Object.fromEntries(MODEL_PHASES.map((phase) => [phase, phaseModel(phase)])) as PhaseModels
  })
}

function workflowStartRequest(value: unknown): WorkflowStartRequest {
  if (!value || typeof value !== 'object') throw new Error('A workflow request is required.')
  const request = value as Partial<WorkflowStartRequest>
  if (typeof request.workflow !== 'string' || !request.workflow.trim()) throw new Error('A workflow name is required.')
  if (request.brief === undefined) throw new Error('A workflow brief is required.')
  return {
    workflow: request.workflow.trim(),
    brief: request.brief,
    planId: typeof request.planId === 'string' ? request.planId : request.planId === null ? null : undefined,
    language: typeof request.language === 'string' ? request.language : undefined,
    autonomy: request.autonomy === 'led' || request.autonomy === 'assisted' || request.autonomy === 'auto' ? request.autonomy : undefined,
    timeBudgetMs: typeof request.timeBudgetMs === 'number' ? request.timeBudgetMs : undefined,
    inputTokenBudget: typeof request.inputTokenBudget === 'number' ? request.inputTokenBudget : undefined
  }
}

function workflowRunId(value: unknown): string {
  const candidate = typeof value === 'object' && value !== null && 'runId' in value
    ? (value as { runId?: unknown }).runId
    : value
  if (typeof candidate !== 'string' || !candidate.trim()) throw new Error('A workflow run id is required.')
  return candidate.trim()
}

function workflowGateRequest(value: unknown): WorkflowGateActionRequest {
  if (!value || typeof value !== 'object') throw new Error('A workflow gate request is required.')
  const request = value as Partial<WorkflowGateActionRequest>
  if (typeof request.runId !== 'string' || !request.runId.trim()) throw new Error('A workflow run id is required.')
  return {
    runId: request.runId.trim(),
    stepId: typeof request.stepId === 'string' ? request.stepId.trim() : undefined,
    payload: typeof request.payload === 'string' ? request.payload : undefined,
    approvedBy: typeof request.approvedBy === 'string' ? request.approvedBy : undefined,
    comment: typeof request.comment === 'string' ? request.comment : undefined,
    reason: typeof request.reason === 'string' ? request.reason : undefined
  }
}

async function configureBrain(settings: AppSettings): Promise<void> {
  if (!repository) throw new Error('Settings storage is unavailable.')
  brain?.close()
  brain = new CompanyBrain({
    vaultPath: settings.vaultPath,
    octaHome: settings.octaHomePath,
    database: repository.getDatabase()
  })
  intake = new IntakeInterview({ vaultPath: settings.vaultPath, settings: repository })
  await brain.start()
}

function proposalId(value: unknown): number {
  const candidate = typeof value === 'object' && value !== null && 'id' in value
    ? (value as { id?: unknown }).id
    : value
  const id = typeof candidate === 'number' ? candidate : Number(candidate)
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('A valid proposal id is required.')
  return id
}

function requireResearchManager(): ResearchManager {
  if (!researchManager) throw new Error('Research engine is unavailable.')
  return researchManager
}

function researchSite(value: unknown): ResearchLoginSite {
  const candidate = typeof value === 'object' && value !== null && 'site' in value
    ? (value as { site?: unknown }).site
    : value
  if (typeof candidate !== 'string' || !(RESEARCH_LOGIN_SITES as readonly string[]).includes(candidate)) {
    throw new Error(`Research login site must be one of: ${RESEARCH_LOGIN_SITES.join(', ')}.`)
  }
  return candidate as ResearchLoginSite
}

function researchChallengeSite(value: unknown): string {
  const candidate = typeof value === 'object' && value !== null && 'site' in value
    ? (value as { site?: unknown }).site
    : value
  if (typeof candidate !== 'string' || !/^[a-zA-Z0-9._-]{1,255}$/.test(candidate.trim())) {
    throw new Error('Research challenge site is invalid.')
  }
  return candidate.trim()
}

function researchStartRequest(value: unknown): ResearchStartRequest {
  if (!value || typeof value !== 'object') throw new Error('A research request is required.')
  const request = value as Partial<ResearchStartRequest>
  if (typeof request.task !== 'string' || !request.task.trim()) throw new Error('A research task is required.')
  return {
    task: request.task,
    conversationLanguage: typeof request.conversationLanguage === 'string' ? request.conversationLanguage : undefined,
    extraLanguages: Array.isArray(request.extraLanguages) ? request.extraLanguages.filter((item): item is string => typeof item === 'string') : undefined,
    budgetMinutes: typeof request.budgetMinutes === 'number' ? request.budgetMinutes : undefined,
    budgetMs: typeof request.budgetMs === 'number' ? request.budgetMs : undefined,
    preset: request.preset === 'persona' || request.preset === 'competitor' ? request.preset : undefined,
    languagePlan: request.languagePlan,
    jobId: typeof request.jobId === 'string' ? request.jobId : undefined
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringField(fields: Record<string, unknown>, key: string, fallback = ''): string {
  return typeof fields[key] === 'string' ? fields[key] as string : fallback
}

function numberField(fields: Record<string, unknown>, key: string, fallback = 0): number {
  return typeof fields[key] === 'number' && Number.isFinite(fields[key]) ? fields[key] as number : fallback
}

function listField(fields: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
  return Array.isArray(fields[key])
    ? fields[key].filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item))
    : []
}

async function documentHtml(record: DocumentRecord, editable: boolean): Promise<string> {
  const documents = requireDocuments()
  const brand = documents.getBrand(record.brandId) ?? documents.defaultBrand()
  const fields = record.fields
  const context = { brand, options: { editable }, overrides: record.overrides }

  if (record.kind === 'invoice') {
    const invoiceId = typeof fields.invoiceId === 'string' ? fields.invoiceId : ''
    const stored = invoiceId ? requireOperations().getInvoice(invoiceId) : undefined
    const rawItems = Array.isArray(fields.items) ? fields.items : []
    const items = rawItems.flatMap((item): Array<{ description: string; qty: number; unitPrice: number }> => {
      const value = objectValue(item)
      const description = typeof value.description === 'string' ? value.description : ''
      const qty = typeof value.qty === 'number' ? value.qty : 1
      const unitPrice = typeof value.unitPrice === 'number' ? value.unitPrice : 0
      return description ? [{ description, qty, unitPrice }] : []
    })
    const invoice = stored ?? {
      id: invoiceId || record.id,
      clientId: record.clientId ?? '',
      clientName: record.clientName,
      number: record.reference,
      currency: (stringField(fields, 'currency', 'EGP') === 'USD' ? 'USD' : 'EGP') as InvoiceCurrency,
      issuedAt: numberField(fields, 'issuedAt', Date.now()),
      dueAt: numberField(fields, 'dueAt', Date.now()),
      status: 'draft' as const,
      storedStatus: 'draft' as const,
      notes: stringField(fields, 'notes'),
      paymentLink: stringField(fields, 'paymentLink'),
      projectNote: null,
      items,
      total: items.reduce((sum, item) => sum + item.qty * item.unitPrice, 0),
      notionPageId: null
    } satisfies InvoiceRecord
    return invoiceDocument(invoice, context)
  }

  if (record.kind === 'contract') {
    const phases = listField(fields, 'phases').map((phase) => ({
      title: typeof phase.title === 'string' ? phase.title : '',
      detail: typeof phase.detail === 'string' ? phase.detail : ''
    }))
    return contractDocument({
      reference: record.reference,
      clientName: record.clientName,
      clientDetails: stringField(fields, 'clientDetails'),
      projectName: stringField(fields, 'projectName'),
      subject: stringField(fields, 'subject'),
      scopeIn: stringField(fields, 'scopeIn'),
      scopeOut: stringField(fields, 'scopeOut'),
      phases,
      amountMinor: numberField(fields, 'amountMinor'),
      currency: stringField(fields, 'currency', 'EGP'),
      paymentTerms: stringField(fields, 'paymentTerms'),
      revisions: stringField(fields, 'revisions'),
      deliverables: stringField(fields, 'deliverables'),
      startAt: numberField(fields, 'startAt', Date.now()),
      durationDays: numberField(fields, 'durationDays', 30)
    }, context)
  }

  const objectives = listField(fields, 'objectives').map((item) => ({
    title: typeof item.title === 'string' ? item.title : '',
    detail: typeof item.detail === 'string' ? item.detail : ''
  }))
  const scope = listField(fields, 'scope').map((item) => ({
    title: typeof item.title === 'string' ? item.title : '',
    items: typeof item.items === 'string' ? item.items : ''
  }))
  const plan = listField(fields, 'plan').map((item) => ({
    title: typeof item.title === 'string' ? item.title : '',
    detail: typeof item.detail === 'string' ? item.detail : ''
  }))
  return proposalDocument({
    reference: record.reference,
    clientName: record.clientName,
    title: stringField(fields, 'title', record.title),
    titleAccent: stringField(fields, 'titleAccent'),
    understanding: stringField(fields, 'understanding'),
    objectives,
    scope,
    plan,
    clientNeeds: stringField(fields, 'clientNeeds'),
    includes: stringField(fields, 'includes'),
    excludes: stringField(fields, 'excludes'),
    amountMinor: numberField(fields, 'amountMinor'),
    currency: stringField(fields, 'currency', 'EGP'),
    durationDays: numberField(fields, 'durationDays', 30),
    nextStep: stringField(fields, 'nextStep')
  }, context)
}

function savedDocumentPath(record: DocumentRecord): string {
  const safeReference = (record.reference || record.id || 'document').replace(/[^a-zA-Z0-9._-]+/g, '-')
  return join(repository?.getSettings().octaHomePath ?? DEFAULT_OCTA_HOME, 'documents', record.kind, `${safeReference}.pdf`)
}

function externalUpdateUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('An update download link is required.')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('The update download link is invalid.')
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') {
    throw new Error('Update links must point to GitHub over HTTPS.')
  }
  return url.toString()
}

function registerIpc(): void {
  if (ipcRegistered) return
  ipcRegistered = true

  ipcMain.handle('app:state', (): RendererState => {
    return rendererState()
  })

  ipcMain.handle('app:update:check', async (): Promise<UpdateCheckResult> => {
    if (!repository) throw new Error('Settings storage is unavailable.')
    const settings = repository.getSettings()
    lastUpdateCheck = await checkForUpdate({ currentVersion: app.getVersion(), repository: settings.updateRepository })
    return lastUpdateCheck
  })

  ipcMain.handle('app:update:open', (_event, value: unknown): Promise<void> =>
    shell.openExternal(externalUpdateUrl(value))
  )

  ipcMain.handle('app:update:download', async (): Promise<UpdateProgress> => {
    // Small app-only update first (a few MB); the full installer only when the runtime changed.
    if (appUpdate && lastUpdateCheck && (await appUpdate.check(lastUpdateCheck))) return appUpdate.download(lastUpdateCheck)
    if (!autoUpdate) throw new Error(`The updater is not available: ${autoUpdateError ?? 'not initialised'}`)
    return autoUpdate.download(lastUpdateCheck ?? undefined)
  })

  ipcMain.handle('app:update:install', (): boolean => (appUpdate?.ready ? appUpdate.install() : autoUpdate?.install() ?? false))

  ipcMain.handle('app:update:progress', (): UpdateProgress => {
    if (appUpdate && appUpdate.state().phase !== 'idle') return appUpdate.state()
    if (!autoUpdate) throw new Error(`The updater is not available: ${autoUpdateError ?? 'not initialised'}`)
    return autoUpdate.state()
  })

  ipcMain.handle('first-run:complete', (): RendererState => {
    if (!repository) throw new Error('Settings storage is unavailable.')
    repository.setValue('firstRunCompleted', true)
    return rendererState()
  })

  ipcMain.handle('health:run', async (): Promise<HealthReport> => {
    if (!repository) throw new Error('Settings storage is unavailable.')
    return runHealthChecks(repository.getSettings(), {
      browserStatus: () => {
        const status = researchManager?.status().browser
        if (!status) throw new Error('Research browser is unavailable.')
        return status
      }
    })
  })

  ipcMain.handle('health:install', async (event, value: unknown) => {
    if (!repository) throw new Error('Settings storage is unavailable.')
    const kind = guidedInstallKind(value)
    const settings = repository.getSettings()
    return runGuidedInstall(kind, settings.octaHomePath, {
      onOutput: (text, stream) => {
        if (!event.sender.isDestroyed()) event.sender.send('health:install-output', { kind, stream, text })
      }
    })
  })

  ipcMain.handle('settings:update', async (_event, update: Partial<AppSettings>): Promise<AppSettings> => {
    if (!repository) throw new Error('Settings storage is unavailable.')
    const before = repository.getSettings()
    const normalized = normalizeSettingsUpdate(update)
    let next = repository.setSettings(normalized)
    setPhaseModels(next.phaseModels)
    if (
      before.geminiApiKey !== next.geminiApiKey &&
      next.geminiApiKey.trim() &&
      !next.geminiLiveModelOverride.trim()
    ) {
      await resolveGeminiLiveModel({
        apiKey: next.geminiApiKey,
        storedModel: next.geminiLiveModel,
        onSelectedModel: (model) => {
          repository?.setSettings({ geminiLiveModel: model })
        }
      })
      next = repository.getSettings()
    }
    if (!brain || update.vaultPath !== undefined || update.octaHomePath !== undefined) {
      await configureBrain(next)
    }
    if (update.skillsLibraryPath !== undefined) skillsRegistry?.reload()
    if (triggerManager && Object.keys(normalized).some((key) =>
      key === 'pushToTalkEnabled' || key === 'pushToTalkKey' || key === 'hotkey' ||
      key === 'triggerType' || key === 'mouseButton'
    )) {
      triggerManager.update(next)
    }
    if (voiceController && Object.keys(normalized).some((key) =>
      key === 'wakeWordEnabled' || key === 'wakeWordModelPath' || key === 'wakeWordSensitivity'
    )) {
      await voiceController.replaceDetector(await createWakeWordDetector(next))
    }
    if (voiceController && voiceAudioOutput && Object.keys(normalized).some((key) =>
      key === 'aiProvider' || key === 'geminiApiKey' || key === 'vertexKeyPath' ||
      key === 'vertexProjectId' || key === 'vertexLocation'
    )) {
      const auth = resolveAiAuth(next)
      voiceController.replaceFallback(auth ? new GeminiVoiceFallback(auth, voiceAudioOutput) : undefined)
    }
    broadcast('settings:changed', next)
    return next
  })

  ipcMain.handle('voice:state', (): VoiceState => voiceController?.currentState ?? defaultVoiceState())
  ipcMain.handle('voice:toggle', async (): Promise<VoiceState> => {
    await voiceController?.pushToTalk()
    return voiceController?.currentState ?? defaultVoiceState()
  })
  ipcMain.handle('voice:push-to-talk', async (): Promise<VoiceState> => {
    await voiceController?.pushToTalk()
    return voiceController?.currentState ?? defaultVoiceState()
  })
  ipcMain.handle('voice:stop', (): VoiceState => {
    voiceController?.stopSession()
    broadcast('voice:audio-stop', undefined)
    return voiceController?.currentState ?? defaultVoiceState()
  })
  ipcMain.handle('voice:interrupt', async (): Promise<VoiceState> => {
    await voiceController?.interrupt()
    return voiceController?.currentState ?? defaultVoiceState()
  })
  ipcMain.on('voice:pcm', (_event, value: unknown) => {
    if (!voiceController) return
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) voiceController.feedPcm(value)
  })
  ipcMain.on('voice:microphone-error', (_event, message: unknown) => {
    const text = typeof message === 'string' ? message.slice(0, 512) : 'Microphone access failed.'
    broadcast('voice:message', text)
  })
  ipcMain.handle('voice:readback', async (_event, value: unknown): Promise<void> => {
    if (!value || typeof value !== 'object') throw new Error('A voice read-back is required.')
    const request = value as { payload?: unknown; text?: unknown; gateId?: unknown }
    if (typeof request.text !== 'string' || !request.text.trim()) throw new Error('Read-back text is required.')
    await voiceController?.readBackPayload(
      request.payload,
      request.text,
      typeof request.gateId === 'string' ? request.gateId : undefined
    )
  })
  ipcMain.handle('voice:approve', async (_event, transcript: unknown) => {
    if (!voiceController) throw new Error('Voice is unavailable.')
    return voiceController.approveTranscript(typeof transcript === 'string' ? transcript : '')
  })

  ipcMain.handle('ai:test', async (): Promise<AiTestResult> => {
    if (!repository) throw new Error('Settings storage is unavailable.')
    const settings = repository.getSettings()
    const auth = requireAiAuth(settings)
    const started = Date.now()
    await new GeminiClient(auth).testConnection()
    return {
      provider: auth.kind === 'vertex' ? 'Vertex AI' : 'Gemini API',
      model: 'gemini-3.5-flash',
      latencyMs: Date.now() - started
    }
  })

  ipcMain.handle('notify:test', () =>
    notifier?.send({
      title: 'Octa / أوكتا',
      body: 'Notifications are connected / الإشعارات متصلة',
      tags: ['octa']
    }) ?? false
  )

  ipcMain.handle('brain:proposals', (_event, status?: string) => {
    const allowed = status === 'pending' || status === 'approved' || status === 'rejected' ? status : undefined
    return requireBrain().listProposals(allowed)
  })

  ipcMain.handle('brain:approve', async (_event, value: unknown) => {
    const selected = requireBrain().approveProposal(proposalId(value))
    return requireBrain().applyProposal(selected)
  })

  ipcMain.handle('brain:reject', (_event, value: unknown) =>
    requireBrain().rejectProposal(proposalId(value))
  )

  ipcMain.handle('brain:status', () => requireBrain().status())

  ipcMain.handle('intake:next', (_event, options?: { mode?: 'company' | 'client'; client?: string; reset?: boolean }) =>
    requireIntake().next(options)
  )

  ipcMain.handle('intake:answer', (_event, input: { answer: string; questionId?: string } | string) =>
    requireIntake().answer(input)
  )

  ipcMain.handle('intake:state', () => requireIntake().getState())
  ipcMain.handle('skills:list', (_event, options?: SkillListOptions) =>
    requireSkillsRegistry().listSkills(options)
  )
  ipcMain.handle('skills:get', (_event, name: string) =>
    requireSkillsRegistry().getSkill(name) ?? null
  )

  ipcMain.handle('planner:plan', async (_event, request: PlannerPlanRequest): Promise<PlannerResult> => {
    const settings = repository?.getSettings()
    if (!settings) throw new Error('Settings storage is unavailable.')
    const language = request.language ?? conversations?.getLanguage(request.conversationId) ?? undefined
    const options = {
      homePath: settings.octaHomePath,
      skillsLibraryPath: settings.skillsLibraryPath || undefined,
      conversationId: request.conversationId,
      planId: request.planId,
      language,
      client: request.client,
      maxDebateRounds: request.maxDebateRounds,
      maxQuestionRounds: request.maxQuestionRounds
    }
    const brief = request.brief?.trim()
      ? request.brief
      : await compileBrief(
          request.conversation ?? [],
          request.attachments ?? [],
          requireBrain(),
          { homePath: settings.octaHomePath, planId: request.planId, language }
        )
    return requirePlanner().plan(brief, options)
  })

  ipcMain.handle('planner:answer', (_event, request: PlannerAnswerRequest): Promise<PlannerResult> =>
    requirePlanner().answer(request.planId, request.answers)
  )

  ipcMain.handle('planner:approve', (_event, value: string | { planId: string; approvedBy?: string }): Promise<PlannerResult> => {
    const planId = typeof value === 'string' ? value : value.planId
    const approvedBy = typeof value === 'string' ? 'owner' : value.approvedBy ?? 'owner'
    return requirePlanner().approve(planId, approvedBy)
  })

  ipcMain.handle('planner:get', (_event, planId: string): PlannerResult | null =>
    requirePlanner().get(planId)
  )

  ipcMain.handle('build:start', (_event, value: unknown) =>
    requireBuildManager().start(buildStartRequest(value))
  )

  ipcMain.handle('build:status', (_event, value?: unknown) => {
    const id = typeof value === 'string'
      ? value
      : value && typeof value === 'object' && 'id' in value && typeof (value as { id?: unknown }).id === 'string'
        ? (value as { id: string }).id
        : undefined
    return requireBuildManager().status(id)
  })

  ipcMain.handle('build:resume', (_event, value: string | { id: string }) =>
    requireBuildManager().resume(typeof value === 'string' ? value : value.id)
  )

  ipcMain.handle('build:merge', (_event, value: string | { id: string; strategy?: 'merge' | 'pr'; targetPath?: string }) => {
    const request = typeof value === 'string' ? { id: value } : value
    return requireBuildManager().merge(request.id, { strategy: request.strategy, targetPath: request.targetPath })
  })

  ipcMain.handle('build:discard', (_event, value: string | { id: string }) =>
    requireBuildManager().discard(typeof value === 'string' ? value : value.id)
  )

  ipcMain.handle('build:review', (_event, value: string | { id: string }) =>
    requireBuildManager().review(typeof value === 'string' ? value : value.id)
  )

  ipcMain.handle('build:analyze', (_event, value?: unknown) => {
    const input = value && typeof value === 'object' ? value as Record<string, unknown> : {}
    return requireBuildManager().analyze({
      id: typeof input.id === 'string' ? input.id : undefined,
      projectPath: typeof input.projectPath === 'string' ? input.projectPath : undefined,
      brief: typeof input.brief === 'string' ? input.brief : undefined,
      competitorBrief: typeof input.competitorBrief === 'string' ? input.competitorBrief : undefined,
      ideationPasses: Array.isArray(input.ideationPasses)
        ? input.ideationPasses.filter((item): item is 'code-quality' | 'security' | 'performance' | 'ux' | 'documentation' => ['code-quality', 'security', 'performance', 'ux', 'documentation'].includes(String(item)))
        : undefined
    })
  })

  ipcMain.handle('tasks:list', (_event, filter?: TaskFilter): TaskRecord[] =>
    requireTasks().list(filter ?? {})
  )
  ipcMain.handle('tasks:create', (_event, input: NewTask): TaskRecord => {
    const task = requireTasks().create(input)
    broadcast('tasks:changed', undefined)
    return task
  })
  ipcMain.handle('tasks:update', (_event, id: string, patch: Partial<NewTask>): TaskRecord => {
    const task = requireTasks().update(id, patch)
    broadcast('tasks:changed', undefined)
    return task
  })
  ipcMain.handle('tasks:remove', (_event, id: string): boolean => {
    const removed = requireTasks().remove(id)
    if (removed) broadcast('tasks:changed', undefined)
    return removed
  })
  ipcMain.handle('tasks:start', (_event, id: string): TaskRecord => {
    const task = requireTasks().start(id)
    broadcast('tasks:changed', undefined)
    return task
  })
  ipcMain.handle('tasks:stop', (_event, id: string): TaskRecord | undefined => {
    const task = requireTasks().stop(id)
    broadcast('tasks:changed', undefined)
    return task
  })
  ipcMain.handle('tasks:running', (): TaskRecord | undefined => requireTasks().running())
  ipcMain.handle('tasks:projects', (): string[] => requireTasks().projects())

  ipcMain.handle('time:report', (_event, day: string) => requireTimeTracker().report(day))
  ipcMain.handle('time:launch', (): boolean => requireTimeTracker().launch())

  ipcMain.handle('billing:clients', (_event, query?: string): ClientRecord[] =>
    requireOperations().listClients(typeof query === 'string' ? query : '')
  )
  ipcMain.handle('billing:saveClient', (_event, input: { name: string; email?: string; phone?: string; vaultNote?: string | null }): ClientRecord => {
    const client = requireOperations().saveClient(input)
    broadcast('billing:changed', undefined)
    return client
  })
  ipcMain.handle('billing:invoices', (): InvoiceRecord[] => requireOperations().listInvoices())
  ipcMain.handle('billing:createInvoice', (_event, input: {
    clientId: string
    currency: InvoiceCurrency
    issuedAt: number
    dueAt: number
    notes?: string
    paymentLink?: string
    projectNote?: string | null
    items: Array<{ description: string; qty: number; unitPrice: number }>
  }): InvoiceRecord => {
    const invoice = requireOperations().createInvoice(input)
    broadcast('billing:changed', undefined)
    return invoice
  })
  ipcMain.handle('billing:setStatus', (_event, id: string, status: 'draft' | 'sent' | 'paid'): InvoiceRecord[] => {
    requireOperations().setInvoiceStatus(id, status)
    broadcast('billing:changed', undefined)
    return requireOperations().listInvoices()
  })
  ipcMain.handle('billing:deleteInvoice', (_event, id: string): InvoiceRecord[] => {
    requireOperations().deleteInvoice(id)
    broadcast('billing:changed', undefined)
    return requireOperations().listInvoices()
  })
  ipcMain.handle('billing:deleteClient', (_event, id: string): ClientRecord[] => {
    requireOperations().deleteClient(id)
    broadcast('billing:changed', undefined)
    return requireOperations().listClients()
  })
  ipcMain.handle('billing:pdf', async (_event, id: string): Promise<string> => {
    const invoice = requireOperations().getInvoice(id)
    if (!invoice) throw new Error('Invoice not found.')
    const documents = requireDocuments()
    const brand = documents.defaultBrand()
    const html = await invoiceDocument(invoice, { brand })
    const record: DocumentRecord = {
      id: '',
      kind: 'invoice',
      clientId: invoice.clientId,
      clientName: invoice.clientName,
      brandId: brand.id,
      reference: invoice.number,
      title: `Invoice ${invoice.number}`,
      fields: { invoiceId: invoice.id, currency: invoice.currency, items: invoice.items },
      overrides: {},
      createdAt: 0,
      updatedAt: 0,
      pdfPath: null
    }
    const path = savedDocumentPath(record)
    await new PdfRenderer().render(html, path)
    documents.save({ ...record, pdfPath: path })
    broadcast('billing:changed', undefined)
    return path
  })
  ipcMain.handle('billing:openPdf', (_event, path: string): Promise<string> =>
    shell.openPath(outputFilePath(path))
  )

  ipcMain.handle('brands:list', (): DocumentBrand[] => requireDocuments().listBrands())
  ipcMain.handle('brands:save', (_event, brand: DocumentBrand): DocumentBrand[] => {
    requireDocuments().saveBrand(brand)
    return requireDocuments().listBrands()
  })
  ipcMain.handle('brands:remove', (_event, id: string): DocumentBrand[] => {
    requireDocuments().removeBrand(id)
    return requireDocuments().listBrands()
  })
  ipcMain.handle('dialog:pickPath', async (_event, request: unknown): Promise<string | null> => {
    const options = request && typeof request === 'object' ? request as { kind?: unknown; extensions?: unknown; defaultPath?: unknown } : {}
    const folder = options.kind === 'folder'
    const extensions = Array.isArray(options.extensions) ? options.extensions.filter((value): value is string => typeof value === 'string' && /^[a-z0-9]{1,8}$/i.test(value)) : []
    const selected = await dialog.showOpenDialog({
      properties: [folder ? 'openDirectory' : 'openFile'],
      ...(typeof options.defaultPath === 'string' && options.defaultPath ? { defaultPath: options.defaultPath } : {}),
      ...(!folder && extensions.length > 0 ? { filters: [{ name: extensions.join(', '), extensions }] } : {})
    })
    return selected.canceled ? null : selected.filePaths[0] ?? null
  })

  ipcMain.handle('setup:detectVault', (): string | null => detectObsidianVault())

  ipcMain.handle('brands:pickSignature', async (): Promise<string | null> => {
    const selected = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
    })
    return selected.canceled ? null : selected.filePaths[0] ?? null
  })

  ipcMain.handle('documents:list', (_event, filter?: { clientId?: string; kind?: DocumentKind }): DocumentRecord[] =>
    requireDocuments().list(filter ?? {})
  )
  ipcMain.handle('documents:get', (_event, id: string): DocumentRecord | null =>
    requireDocuments().get(id) ?? null
  )
  ipcMain.handle('documents:nextReference', (_event, kind: DocumentKind): string =>
    requireDocuments().nextReference(kind)
  )
  ipcMain.handle('documents:save', (_event, record: DocumentRecord): DocumentRecord =>
    requireDocuments().save(record)
  )
  ipcMain.handle('documents:remove', (_event, id: string): boolean => requireDocuments().remove(id))
  ipcMain.handle('documents:preview', (_event, record: DocumentRecord): Promise<string> => documentHtml(record, true))
  ipcMain.handle('documents:export', async (_event, record: DocumentRecord): Promise<string> => {
    const stored = requireDocuments().save(record)
    const html = await documentHtml(stored, false)
    const path = savedDocumentPath(stored)
    await new PdfRenderer().render(html, path)
    requireDocuments().save({ ...stored, pdfPath: path })
    return path
  })
  ipcMain.handle('documents:openPdf', (_event, path: string): Promise<string> =>
    shell.openPath(outputFilePath(path))
  )

  ipcMain.handle('jobs:start', (_event, spec: JobSpec): JobStartResponse => {
    if (!jobRunner) throw new Error('Job runner is unavailable.')
    const handle = jobRunner.startJob(spec)
    return { id: handle.id, folder: handle.folder }
  })

  ipcMain.handle('jobs:cancel', async (_event, value: string | { id: string }): Promise<boolean> => {
    if (!jobRunner) throw new Error('Job runner is unavailable.')
    const id = typeof value === 'string' ? value : value.id
    return jobRunner.cancel(id)
  })

  ipcMain.handle('jobs:list', (_event, options?: { status?: string; limit?: number }): JobRecord[] => {
    if (!jobsRepository) throw new Error('Job storage is unavailable.')
    return jobsRepository.listJobs(options)
  })

  ipcMain.handle('plans:list', (_event, limit?: number) => {
    if (!jobsRepository) throw new Error('Plan storage is unavailable.')
    return jobsRepository.listPlans(typeof limit === 'number' ? limit : 5)
  })

  ipcMain.handle('jobs:get', (_event, id: string): JobRecord | null => {
    if (!jobsRepository) throw new Error('Job storage is unavailable.')
    return jobsRepository.getJob(id) ?? null
  })

  ipcMain.handle('jobs:approve', (_event, value: string | { id: string; approvedBy?: string }): JobRecord | null => {
    if (!jobsRepository) throw new Error('Job storage is unavailable.')
    const id = typeof value === 'string' ? value : value.id
    const approvedBy = typeof value === 'string' ? 'owner' : value.approvedBy ?? 'owner'
    const job = jobsRepository.approveJob(id, approvedBy)
    if (job) broadcast('jobs:events', {
      type: 'done',
      jobId: job.id,
      timestamp: new Date().toISOString(),
      status: job.status
    })
    return job ?? null
  })

  ipcMain.handle('workflows:list', () => requireWorkflows().list())

  ipcMain.handle('workflows:get', (_event, value: string) => {
    if (typeof value !== 'string' || !value.trim()) throw new Error('A workflow or run id is required.')
    return requireWorkflows().get(value.trim())
  })

  ipcMain.handle('workflows:start', (_event, value: unknown): WorkflowStartResponse => {
    const request = workflowStartRequest(value)
    const handle = requireWorkflows().start(request)
    return { runId: handle.runId, workflow: request.workflow, folder: handle.folder }
  })

  ipcMain.handle('workflows:resume', (_event, value: unknown): WorkflowStartResponse => {
    const runId = workflowRunId(value)
    const handle = requireWorkflows().resume(runId)
    const run = requireWorkflows().getRun(runId)
    return { runId: handle.runId, workflow: run?.workflow ?? '', folder: handle.folder }
  })

  ipcMain.handle('workflows:gate:approve', (_event, value: unknown) =>
    requireWorkflows().approveGate(workflowGateRequest(value))
  )

  ipcMain.handle('workflows:gate:reject', (_event, value: unknown) =>
    requireWorkflows().rejectGate(workflowGateRequest(value))
  )

  ipcMain.handle('workflows:gate:comment', (_event, value: unknown) =>
    requireWorkflows().commentGate(workflowGateRequest(value))
  )

  ipcMain.handle('workflows:save', (_event, value: unknown) => {
    if (!value || typeof value !== 'object') throw new Error('A workflow name and plan are required.')
    const request = value as { name?: unknown; plan?: unknown; definition?: unknown }
    if (typeof request.name !== 'string' || !request.name.trim()) throw new Error('A workflow name is required.')
    const source = request.definition ?? request.plan
    return requireWorkflows().saveAsWorkflow(request.name, source)
  })

  ipcMain.handle('research:start', (_event, value: unknown): ResearchStartResponse => {
    const request = researchStartRequest(value)
    const handle = requireResearchManager().start(request.task, {
      conversationLanguage: request.conversationLanguage,
      extraLanguages: request.extraLanguages,
      budgetMinutes: request.budgetMinutes,
      budgetMs: request.budgetMs,
      preset: request.preset,
      languagePlan: request.languagePlan,
      jobId: request.jobId
    })
    return { id: handle.id, folder: handle.folder }
  })

  ipcMain.handle('research:status', (_event, value?: unknown) => {
    const id = typeof value === 'string' && value.trim() ? value.trim() : undefined
    return requireResearchManager().status(id)
  })

  const resolveChallenge = (_event: Electron.IpcMainInvokeEvent, value: unknown) =>
    requireResearchManager().challengeResolved(researchChallengeSite(value))
  const startLogin = (_event: Electron.IpcMainInvokeEvent, value: unknown) =>
    requireResearchManager().loginStart(researchSite(value))
  const finishLogin = (_event: Electron.IpcMainInvokeEvent, value: unknown) =>
    requireResearchManager().loginDone(researchSite(value))
  ipcMain.handle('research:challenge:resolved', resolveChallenge)
  ipcMain.handle('challenge:resolved', resolveChallenge)
  ipcMain.handle('research:login:start', startLogin)
  ipcMain.handle('login:start', startLogin)
  ipcMain.handle('research:login:done', finishLogin)
  ipcMain.handle('login:done', finishLogin)

  ipcMain.handle('files:read', async (_event, value: unknown): Promise<string> =>
    readFile(outputFilePath(value), 'utf8')
  )

  ipcMain.handle('files:open', async (_event, value: unknown): Promise<string> =>
    shell.openPath(outputFilePath(value))
  )

  ipcMain.on('window:minimize', (event) => BrowserWindow.fromWebContents(event.sender)?.minimize())
  ipcMain.on('window:maximize', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window?.isMaximized()) window.unmaximize()
    else window?.maximize()
  })
  ipcMain.on('window:close', (event) => BrowserWindow.fromWebContents(event.sender)?.close())
  ipcMain.handle('window:state', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    return { maximized: window?.isMaximized() ?? false, focused: window?.isFocused() ?? true }
  })
}

// electron-updater constructs its NSIS updater on import and must only load after app.whenReady(); importing it
// at module level froze the packaged executable before the ready event (2026-09-15).
async function createAutoUpdate(): Promise<AutoUpdateController | null> {
  try {
  // electron-updater is CommonJS and exposes autoUpdater through a lazy getter that ESM named imports cannot see.
  const updaterModule = await import('electron-updater')
  const autoUpdater = (updaterModule.default ?? updaterModule).autoUpdater
  if (!autoUpdater) throw new Error('electron-updater did not expose autoUpdater.')
  const controller = new AutoUpdateController({
    updater: autoUpdater,
    packaged: app.isPackaged,
    currentVersion: app.getVersion(),
    getRepository: () => repository?.getSettings().updateRepository,
    // App-only releases carry no latest.yml, so point electron-updater at the newest release that has one.
    resolveFeed: async () => {
      const slug = lastUpdateCheck?.repository
      if (!slug) return null
      const feed = await findFullInstallerFeed(slug, app.getVersion())
      return feed ? { provider: 'generic', url: feed.url } : null
    },
    onProgress: (progress) => broadcast('app:update:progress', progress)
  })
  // electron-updater only reports "differential" through its logger, so listen for that line.
  autoUpdater.logger = {
    info: (message: unknown) => {
      const text = String(message)
      if (/differential download/i.test(text)) controller.markDifferential(!/failed|cannot|disabled/i.test(text))
      console.log('[updater]', text)
    },
    warn: (message: unknown) => console.warn('[updater]', message),
    error: (message: unknown) => console.error('[updater]', message),
    debug: () => {}
  }
  return controller
  } catch (error) {
    autoUpdateError = error instanceof Error ? (error.stack ?? error.message) : String(error)
    console.error('[updater] unavailable:', autoUpdateError)
    return null
  }
}

async function start(): Promise<void> {
  repository = new SettingsRepository(join(octaHome, 'octa.db'))
  autoUpdate = await createAutoUpdate()
  try {
    const settings = repository.getSettings()
    const modelPath = settings.wakeWordModelPath.trim() || join(octaHome, 'models', 'octa.onnx')
    const restored = ensureWakeWordModels(modelPath, join(app.getAppPath(), 'assets', 'wake-word'))
    if (restored.length > 0) console.log('[wake-word] restored bundled models:', restored.join(', '))
  } catch (error) {
    console.error('[wake-word] could not restore bundled models:', error instanceof Error ? error.message : error)
  }
  if (app.isPackaged) {
    const updatesDir = join(octaHome, 'updates')
    const settled = settlePendingAppUpdate(updatesDir, app.getVersion(), process.resourcesPath)
    if (settled) console.log('[updater]', settled)
    appUpdate = new AppUpdateController({
      packaged: true,
      currentVersion: app.getVersion(),
      runtimeId: computeRuntimeId({ electronVersion: process.versions.electron, unpackedRoot: join(process.resourcesPath, 'app.asar.unpacked') }),
      updatesDir,
      exePath: app.getPath('exe'),
      resourcesPath: process.resourcesPath,
      pid: process.pid,
      onProgress: (progress) => broadcast('app:update:progress', progress),
      quit: () => app.quit()
    })
  }
  jobsRepository = new JobsRepository(join(octaHome, 'octa.db'))
  const databasePath = join(octaHome, 'octa.db')
  tasksRepository = new TaskRepository(databasePath)
  operationsRepository = new OperationsRepository(databasePath)
  documentsRepository = new DocumentRepository(databasePath)
  socialQueueRepository = new SocialQueueRepository(databasePath)
  timeTracker = new TimeTracker()
  skillsRegistry = new SkillRegistry({
    getSettings: () => {
      if (!repository) throw new Error('Settings storage is unavailable.')
      return repository.getSettings()
    },
    onChange: (skills) => broadcast('skills:changed', skills),
    onError: (error) => console.error('[skills] manifest reload failed:', error.message)
  })
  jobRunner = new JobRunner({
    jobs: jobsRepository,
    getSettings: () => {
      if (!repository) throw new Error('Settings storage is unavailable.')
      return repository.getSettings()
    },
    onEvent: (event) => {
      broadcast('jobs:events', event)
      if (event.type !== 'done' || !event.result) return
      const resultText = event.result.notes.trim() ||
        (event.result.questions.length > 0 ? JSON.stringify(event.result.questions) : '') ||
        `Job ${event.jobId} finished with status ${event.status}.`
      if (event.status === 'needs_approval') {
        void voiceController?.readBackPayload(
          { kind: 'job-result', jobId: event.jobId, result: event.result },
          resultText,
          event.jobId
        ).catch((error: unknown) => console.error('[voice] job read-back failed:', error))
      } else {
        void voiceController?.speak(resultText).catch((error: unknown) => {
          console.error('[voice] job result speech failed:', error)
        })
      }
    }
  })
  researchManager = new ResearchManager({
    runner: jobRunner,
    jobs: jobsRepository,
    getSettings: () => {
      if (!repository) throw new Error('Settings storage is unavailable.')
      return repository.getSettings()
    },
    settings: repository,
    onEvent: (event) => broadcast('research:events', event),
    onChallenge: (event) => broadcast('browser:challenge', event)
  })
  notifier = new Notifier(() => {
    if (!repository) throw new Error('Settings storage is unavailable.')
    return repository.getSettings()
  }, {
    showLocalNotification: (options) => {
      if (!Notification.isSupported()) return false
      const notification = new Notification({ title: options.title, body: options.body })
      if (options.clickUrl) notification.on('click', () => void shell.openExternal(options.clickUrl!))
      notification.show()
      return true
    }
  })

  conversations = new ConversationRepository(repository.getDatabase())
  workflowGates = new WorkflowGateRegistry()
  const initialSettings = repository.getSettings()
  setPhaseModels(initialSettings.phaseModels)
  if (initialSettings.geminiApiKey.trim()) {
    await resolveGeminiLiveModel({
      apiKey: initialSettings.geminiApiKey,
      override: initialSettings.geminiLiveModelOverride,
      storedModel: initialSettings.geminiLiveModel,
      onSelectedModel: (model) => {
        repository?.setSettings({ geminiLiveModel: model })
      }
    })
  }

  const wakeDetector = await createWakeWordDetector(initialSettings)
  const audioOutput = {
    play: (data: Buffer, mimeType: string): void => emitVoiceAudio(voiceAudioEvent(data, mimeType)),
    stop: (): void => broadcast('voice:audio-stop', undefined),
    clear: (): void => broadcast('voice:audio-stop', undefined)
  }
  voiceAudioOutput = audioOutput
  const fallbackAuth = resolveAiAuth(initialSettings)
  const voiceTools = createVoiceTools()
  voiceController = new VoiceController({
    settings: () => {
      if (!repository) throw new Error('Settings storage is unavailable.')
      return repository.getSettings()
    },
    detector: wakeDetector,
    conversation: conversations,
    conversationId: 'default',
    fallback: fallbackAuth ? new GeminiVoiceFallback(fallbackAuth, audioOutput) : undefined,
    createSession: ({ model, onEvent }) => {
      if (!repository) throw new Error('Settings storage is unavailable.')
      const settings = repository.getSettings()
      if (!settings.geminiApiKey.trim()) throw new Error('Add a Gemini AI Studio key before starting voice.')
      if (!/^AIza[0-9A-Za-z_-]{20,}$/.test(settings.geminiApiKey.trim())) {
        throw new Error('The Gemini key in Settings is not an AI Studio API key (they start with "AIza"). Create one at aistudio.google.com/apikey.')
      }
      return new GeminiLiveSession({
        apiKey: settings.geminiApiKey,
        model: settings.geminiLiveModelOverride.trim() || settings.geminiLiveModel.trim() || model || DEFAULT_GEMINI_LIVE_MODEL,
        audioOutput,
        onEvent,
        systemInstruction: `${OCTA_VOICE_SYSTEM_INSTRUCTION}
${VOICE_TOOLS_INSTRUCTION}`,
        functionDeclarations: VOICE_TOOL_DECLARATIONS
      })
    },
    onToolCall: (name, args) => voiceTools.call(name, args),
    onState: emitVoiceState,
    onTranscript: emitVoiceTranscript,
    onMessage: (message) => broadcast('voice:message', message),
    approveGate: (request) => {
      if (!workflowGates) throw new Error('Workflow gates are unavailable.')
      return workflowGates.approve(request)
    }
  })
  triggerManager = new GlobalTriggerManager(
    () => void voiceController?.pushToTalk(),
    join(initialSettings.octaHomePath, 'tools', 'mouse-hook.exe')
  )
  triggerManager.update(initialSettings)
  await voiceController.start()

  await configureBrain(initialSettings)
  planner = new Planner({
    jobs: jobsRepository,
    jobRunner,
    homePath: repository.getSettings().octaHomePath,
    skillsLibraryPath: repository.getSettings().skillsLibraryPath || undefined,
    onEvent: (event) => {
      broadcast(event.type, event)
      if (event.type !== 'planner:questions' || event.questions.length === 0) return
      const text = event.questions.map((question) => question.text.trim()).filter(Boolean).join('\n')
      if (!text) return
      void voiceController?.readBackPayload(
        { kind: 'planner-questions', planId: event.planId, questions: event.questions },
        text,
        `planner:${event.planId}`
      ).catch((error: unknown) => console.error('[voice] planner read-back failed:', error))
    }
  })
  buildManager = new BuildManager({
    homePath: repository.getSettings().octaHomePath,
    projectPath: process.cwd(),
    skillsLibraryPath: repository.getSettings().skillsLibraryPath || skillsRegistry.libraryPath,
    registry: skillsRegistry,
    research: researchManager,
    planner,
    onEvent: (event) => broadcast('build:events', event)
  })
  const launchHandlers = createLaunchWorkflowHandlers({
    homePath: repository.getSettings().octaHomePath,
    brandFontPath: app.isPackaged
      ? join(process.resourcesPath, 'documents', 'PingAR-LT-Thin.otf')
      : join(app.getAppPath(), 'assets', 'documents', 'PingAR-LT-Thin.otf'),
    getSettings: () => {
      if (!repository) throw new Error('Settings storage is unavailable.')
      return repository.getSettings()
    },
    settings: repository,
    buildManager,
    tasks: tasksRepository,
    operations: operationsRepository,
    documents: documentsRepository,
    jobs: jobsRepository,
    timeTracker,
    socialQueue: socialQueueRepository,
    socialHandoffPath: join(repository.getSettings().octaHomePath, 'integrations', 'tamim-os-queue.json'),
    skillRunner: async ({ name, input, request }) => {
      if (!jobRunner) throw new Error('Job runner is unavailable.')
      const handle = jobRunner.startJob({
        id: `${request.jobId}-${name}`,
        runner: 'claude-skill',
        skill: name,
        input,
        prompt: `Run ${name} for workflow ${request.workflow.id}.`,
        workflowRunId: request.jobId,
        workflow: request.workflow.id,
        stepId: request.step.id,
        autonomy: 'assisted',
        language: request.language,
        homePath: repository?.getSettings().octaHomePath,
        skillsLibraryPath: repository?.getSettings().skillsLibraryPath || undefined,
        skipReview: true
      })
      const result = await handle.promise
      return {
        status: result.status,
        output: result,
        result,
        outputs: result.outputs,
        folder: handle.folder,
        jobId: handle.id,
        notes: result.notes
      }
    }
  })
  workflows = new WorkflowRunner({
    jobs: jobsRepository,
    jobRunner,
    homePath: repository.getSettings().octaHomePath,
    getSettings: () => {
      if (!repository) throw new Error('Settings storage is unavailable.')
      return repository.getSettings()
    },
    notifier,
    research: async (request) => {
      const manager = researchManager
      if (!manager) throw new Error('Research engine is unavailable.')
      const input = typeof request.input === 'object' && request.input !== null
        ? request.input as { task?: unknown }
        : {}
      const task = typeof input.task === 'string' && input.task.trim()
        ? input.task
        : request.step.prompt?.trim() || String(request.brief ?? '')
      const handle = manager.start(task, {
        jobId: request.jobId,
        workflowRunId: request.runId,
        stepId: request.step.id,
        conversationLanguage: request.language,
        budgetMs: request.timeBudgetMs,
        preset: request.step.id === 's3' ? 'competitor' : request.step.id === 's2' ? 'persona' : undefined
      })
      const result = await handle.promise
      return {
        status: result.status === 'ok' ? 'ok' : result.status === 'cancelled' ? 'cancelled' : 'failed',
        output: result,
        result: result.agent,
        outputs: result.reportPath
          ? [{ path: relative(handle.folder, result.reportPath), type: 'markdown', title: 'Research report' }]
          : [],
        folder: handle.folder,
        jobId: handle.id,
        notes: result.gate.failures.join(' ')
      }
    },
    stepHandler: launchHandlers.stepHandler,
    afterGateApproval: launchHandlers.afterGateApproval,
    onEvent: (event) => broadcast(event.type, event)
  })
  workflows.seedLaunchWorkflows()
  seedRecurringJobs(jobsRepository)
  recurringScheduler = new RecurringScheduler({
    jobs: jobsRepository,
    workflows,
    onEvent: (message) => console.warn(`[recurring] ${message}`)
  })
  recurringScheduler.start()
  void workflows.resumePending()
  registerIpc()
  attachMainWindow(createWindow())
  overlayWindow = createOverlayWindow()
}

function logStartupError(source: string, error: unknown): void {
  const text = error instanceof Error ? (error.stack ?? error.message) : String(error)
  console.error(`[${source}] ${text}`)
  try {
    mkdirSync(octaHome, { recursive: true })
    appendFileSync(join(octaHome, 'startup-error.log'), `${new Date().toISOString()} [${source}] ${text}
`)
  } catch {
    // The log is best-effort; never mask the original failure.
  }
}

process.on('uncaughtException', (error) => logStartupError('uncaught', error))
process.on('unhandledRejection', (reason) => logStartupError('unhandled', reason))

app.whenReady().then(() => process.argv.includes('--smoke-test') ? runSmokeTest() : start()).catch((error: unknown) => {
  logStartupError('startup', error)
  app.exit(1)
})

app.on('activate', () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    attachMainWindow(createWindow())
    if (!overlayWindow || overlayWindow.isDestroyed()) overlayWindow = createOverlayWindow()
  }
})

app.on('before-quit', () => {
  triggerManager?.dispose()
  triggerManager = undefined
  voiceController?.dispose()
  voiceController = undefined
  voiceAudioOutput = undefined
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close()
  overlayWindow = undefined
  recurringScheduler?.stop()
  recurringScheduler = undefined
  void workflows?.close()
  workflows = undefined
  void researchManager?.close()
  researchManager = undefined
  brain?.close()
  brain = undefined
  intake = undefined
  planner?.close()
  planner = undefined
  buildManager = undefined
  repository?.checkpoint()
  jobsRepository?.checkpoint()
  tasksRepository?.close()
  operationsRepository?.close()
  documentsRepository?.close()
  socialQueueRepository?.close()
  repository?.close()
  jobsRepository?.close()
  skillsRegistry?.close()
  repository = undefined
  jobsRepository = undefined
  tasksRepository = undefined
  operationsRepository = undefined
  documentsRepository = undefined
  socialQueueRepository = undefined
  timeTracker = undefined
  jobRunner = undefined
  skillsRegistry = undefined
  conversations = undefined
  workflowGates = undefined
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

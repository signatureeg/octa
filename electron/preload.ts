import { contextBridge, ipcRenderer } from 'electron'
import type { BrainProposal, BrainStatus, ProposalStatus } from './core/octa/brain'
import type { BrowserChallengeEvent, ResearchBrowserStatus } from './core/octa/browser'
import type { IntakeAnswerResult, IntakeQuestion, IntakeStartOptions, IntakeState } from './core/octa/intake'
import type { Skill, SkillListOptions } from './core/skills/registry'
import type {
  PlannerAnswerRequest,
  PlannerEvent,
  PlannerPlanRequest,
  PlannerResult
} from './core/octa/planner'
import type {
  ResearchLoginSite,
  ResearchStartRequest,
  ResearchStartResponse,
  ResearchStatusResponse
} from './core/octa/research'
import type { BuildEvent, BuildState } from './core/octa/build'
import type {
  WorkflowDefinition,
  WorkflowEvent,
  WorkflowGateActionRequest,
  WorkflowListItem,
  WorkflowRunRecord,
  WorkflowStartRequest,
  WorkflowStartResponse
} from './core/octa/workflows'
import type {
  GuidedInstallKind,
  GuidedInstallResult,
  HealthOutputStream,
  HealthReport
} from './core/octa/health'
import type {
  AiTestResult,
  ClientRecord,
  DocumentBrand,
  DocumentKind,
  DocumentRecord,
  InvoiceCurrency,
  InvoiceRecord,
  NewTask,
  AppSettings,
  JobEvent,
  JobRecord,
  JobStartRequest,
  JobStartResponse,
  RendererState,
  TaskFilter,
  TaskRecord,
  TimeReport,
  VoiceAudioEvent,
  VoiceState,
  VoiceTranscriptEvent,
  UpdateProgress
} from './types'
import type { UpdateCheckResult } from './core/octa/update'
import type { ApprovalResult } from './core/voice/readback'
import type { PlanRecord } from './db/jobs'

export interface WindowChromeState { maximized: boolean; focused: boolean }

const api = {
  state: (): Promise<RendererState> => ipcRenderer.invoke('app:state'),
  update: {
    check: (): Promise<UpdateCheckResult> => ipcRenderer.invoke('app:update:check'),
    open: (url: string): Promise<void> => ipcRenderer.invoke('app:update:open', url),
    /** Differential download of the latest release (only changed installer blocks). */
    download: (): Promise<UpdateProgress> => ipcRenderer.invoke('app:update:download'),
    install: (): Promise<boolean> => ipcRenderer.invoke('app:update:install'),
    progress: (): Promise<UpdateProgress> => ipcRenderer.invoke('app:update:progress'),
    onProgress: (listener: (progress: UpdateProgress) => void): (() => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, progress: UpdateProgress): void => listener(progress)
      ipcRenderer.on('app:update:progress', wrapped)
      return () => ipcRenderer.removeListener('app:update:progress', wrapped)
    }
  },
  settings: {
    update: (update: Partial<AppSettings>): Promise<AppSettings> =>
      ipcRenderer.invoke('settings:update', update)
  },
  firstRun: {
    complete: (): Promise<RendererState> => ipcRenderer.invoke('first-run:complete')
  },
  health: {
    run: (): Promise<HealthReport> => ipcRenderer.invoke('health:run'),
    install: (kind: GuidedInstallKind): Promise<GuidedInstallResult> =>
      ipcRenderer.invoke('health:install', kind),
    onInstallOutput: (listener: (event: { kind: GuidedInstallKind; stream: HealthOutputStream; text: string }) => void): (() => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, output: { kind: GuidedInstallKind; stream: HealthOutputStream; text: string }): void => listener(output)
      ipcRenderer.on('health:install-output', wrapped)
      return () => ipcRenderer.removeListener('health:install-output', wrapped)
    }
  },
  ai: {
    test: (): Promise<AiTestResult> => ipcRenderer.invoke('ai:test')
  },
  notify: {
    test: (): Promise<boolean> => ipcRenderer.invoke('notify:test')
  },
  brain: {
    proposals: (status?: ProposalStatus): Promise<BrainProposal[]> =>
      ipcRenderer.invoke('brain:proposals', status),
    approve: (id: number): Promise<BrainProposal> => ipcRenderer.invoke('brain:approve', id),
    reject: (id: number): Promise<BrainProposal> => ipcRenderer.invoke('brain:reject', id),
    status: (): Promise<BrainStatus> => ipcRenderer.invoke('brain:status')
  },
  intake: {
    next: (options?: IntakeStartOptions): Promise<IntakeQuestion | null> =>
      ipcRenderer.invoke('intake:next', options),
    answer: (input: { answer: string; questionId?: string } | string): Promise<IntakeAnswerResult> =>
      ipcRenderer.invoke('intake:answer', input),
    state: (): Promise<IntakeState | null> => ipcRenderer.invoke('intake:state')
  },
  skills: {
    list: (options?: SkillListOptions): Promise<Skill[]> => ipcRenderer.invoke('skills:list', options),
    get: (name: string): Promise<Skill | null> => ipcRenderer.invoke('skills:get', name)
  },
  tasks: {
    list: (filter: TaskFilter = {}): Promise<TaskRecord[]> => ipcRenderer.invoke('tasks:list', filter),
    create: (input: NewTask): Promise<TaskRecord> => ipcRenderer.invoke('tasks:create', input),
    update: (id: string, patch: Partial<NewTask>): Promise<TaskRecord> => ipcRenderer.invoke('tasks:update', id, patch),
    remove: (id: string): Promise<boolean> => ipcRenderer.invoke('tasks:remove', id),
    start: (id: string): Promise<TaskRecord> => ipcRenderer.invoke('tasks:start', id),
    stop: (id: string): Promise<TaskRecord | undefined> => ipcRenderer.invoke('tasks:stop', id),
    running: (): Promise<TaskRecord | undefined> => ipcRenderer.invoke('tasks:running'),
    projects: (): Promise<string[]> => ipcRenderer.invoke('tasks:projects')
  },
  time: {
    report: (day: string): Promise<TimeReport> => ipcRenderer.invoke('time:report', day),
    launch: (): Promise<boolean> => ipcRenderer.invoke('time:launch')
  },
  billing: {
    clients: (query = ''): Promise<ClientRecord[]> => ipcRenderer.invoke('billing:clients', query),
    saveClient: (client: { name: string; email?: string; phone?: string; vaultNote?: string | null }): Promise<ClientRecord> =>
      ipcRenderer.invoke('billing:saveClient', client),
    invoices: (): Promise<InvoiceRecord[]> => ipcRenderer.invoke('billing:invoices'),
    createInvoice: (invoice: {
      clientId: string
      currency: InvoiceCurrency
      issuedAt: number
      dueAt: number
      notes?: string
      paymentLink?: string
      projectNote?: string | null
      items: Array<{ description: string; qty: number; unitPrice: number }>
    }): Promise<InvoiceRecord> => ipcRenderer.invoke('billing:createInvoice', invoice),
    setStatus: (id: string, status: 'draft' | 'sent' | 'paid'): Promise<InvoiceRecord[]> =>
      ipcRenderer.invoke('billing:setStatus', id, status),
    deleteInvoice: (id: string): Promise<InvoiceRecord[]> => ipcRenderer.invoke('billing:deleteInvoice', id),
    deleteClient: (id: string): Promise<ClientRecord[]> => ipcRenderer.invoke('billing:deleteClient', id),
    pdf: (id: string): Promise<string> => ipcRenderer.invoke('billing:pdf', id),
    openPdf: (path: string): Promise<string> => ipcRenderer.invoke('billing:openPdf', path)
  },
  brands: {
    list: (): Promise<DocumentBrand[]> => ipcRenderer.invoke('brands:list'),
    save: (brand: DocumentBrand): Promise<DocumentBrand[]> => ipcRenderer.invoke('brands:save', brand),
    remove: (id: string): Promise<DocumentBrand[]> => ipcRenderer.invoke('brands:remove', id),
    pickSignature: (): Promise<string | null> => ipcRenderer.invoke('brands:pickSignature')
  },
  documents: {
    list: (filter: { clientId?: string; kind?: DocumentKind } = {}): Promise<DocumentRecord[]> =>
      ipcRenderer.invoke('documents:list', filter),
    get: (id: string): Promise<DocumentRecord | null> => ipcRenderer.invoke('documents:get', id),
    nextReference: (kind: DocumentKind): Promise<string> => ipcRenderer.invoke('documents:nextReference', kind),
    save: (record: DocumentRecord): Promise<DocumentRecord> => ipcRenderer.invoke('documents:save', record),
    remove: (id: string): Promise<boolean> => ipcRenderer.invoke('documents:remove', id),
    preview: (record: DocumentRecord): Promise<string> => ipcRenderer.invoke('documents:preview', record),
    exportPdf: (record: DocumentRecord): Promise<string> => ipcRenderer.invoke('documents:export', record),
    openPdf: (path: string): Promise<string> => ipcRenderer.invoke('documents:openPdf', path)
  },
  planner: {
    plan: (request: PlannerPlanRequest): Promise<PlannerResult> => ipcRenderer.invoke('planner:plan', request),
    answer: (request: PlannerAnswerRequest): Promise<PlannerResult> => ipcRenderer.invoke('planner:answer', request),
    approve: (planId: string, approvedBy?: string): Promise<PlannerResult> =>
      ipcRenderer.invoke('planner:approve', { planId, approvedBy }),
    get: (planId: string): Promise<PlannerResult | null> => ipcRenderer.invoke('planner:get', planId),
    onQuestions: (listener: (event: Extract<PlannerEvent, { type: 'planner:questions' }>) => void): (() => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, plannerEvent: Extract<PlannerEvent, { type: 'planner:questions' }>): void => listener(plannerEvent)
      ipcRenderer.on('planner:questions', wrapped)
      return () => ipcRenderer.removeListener('planner:questions', wrapped)
    },
    onRound: (listener: (event: Extract<PlannerEvent, { type: 'planner:round' }>) => void): (() => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, plannerEvent: Extract<PlannerEvent, { type: 'planner:round' }>): void => listener(plannerEvent)
      ipcRenderer.on('planner:round', wrapped)
      return () => ipcRenderer.removeListener('planner:round', wrapped)
    }
  },
  jobs: {
    start: (spec: JobStartRequest): Promise<JobStartResponse> => ipcRenderer.invoke('jobs:start', spec),
    cancel: (id: string): Promise<boolean> => ipcRenderer.invoke('jobs:cancel', id),
    list: (options?: { status?: string; limit?: number }): Promise<JobRecord[]> => ipcRenderer.invoke('jobs:list', options),
    get: (id: string): Promise<JobRecord | null> => ipcRenderer.invoke('jobs:get', id),
    approve: (id: string, approvedBy?: string): Promise<JobRecord | null> =>
      ipcRenderer.invoke('jobs:approve', { id, approvedBy }),
    onEvent: (listener: (event: JobEvent) => void): (() => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, jobEvent: JobEvent): void => listener(jobEvent)
      ipcRenderer.on('jobs:events', wrapped)
      return () => ipcRenderer.removeListener('jobs:events', wrapped)
    }
  },
  plans: {
    list: (limit = 5): Promise<PlanRecord[]> => ipcRenderer.invoke('plans:list', limit)
  },
  workflows: {
    list: (): Promise<WorkflowListItem[]> => ipcRenderer.invoke('workflows:list'),
    get: (idOrName: string): Promise<WorkflowDefinition | WorkflowRunRecord | null> =>
      ipcRenderer.invoke('workflows:get', idOrName),
    start: (request: WorkflowStartRequest): Promise<WorkflowStartResponse> =>
      ipcRenderer.invoke('workflows:start', request),
    resume: (runId: string): Promise<WorkflowStartResponse> =>
      ipcRenderer.invoke('workflows:resume', runId),
    approve: (request: WorkflowGateActionRequest): Promise<WorkflowRunRecord> =>
      ipcRenderer.invoke('workflows:gate:approve', request),
    reject: (request: WorkflowGateActionRequest): Promise<WorkflowRunRecord> =>
      ipcRenderer.invoke('workflows:gate:reject', request),
    comment: (request: WorkflowGateActionRequest): Promise<WorkflowRunRecord> =>
      ipcRenderer.invoke('workflows:gate:comment', request),
    save: (name: string, source: unknown): Promise<WorkflowDefinition> =>
      ipcRenderer.invoke('workflows:save', { name, plan: source }),
    onStep: (listener: (event: Extract<WorkflowEvent, { type: 'workflow:step' }>) => void): (() => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, workflowEvent: Extract<WorkflowEvent, { type: 'workflow:step' }>): void => listener(workflowEvent)
      ipcRenderer.on('workflow:step', wrapped)
      return () => ipcRenderer.removeListener('workflow:step', wrapped)
    },
    onGate: (listener: (event: Extract<WorkflowEvent, { type: 'workflow:gate' }>) => void): (() => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, workflowEvent: Extract<WorkflowEvent, { type: 'workflow:gate' }>): void => listener(workflowEvent)
      ipcRenderer.on('workflow:gate', wrapped)
      return () => ipcRenderer.removeListener('workflow:gate', wrapped)
    }
  },
  research: {
    start: (request: ResearchStartRequest): Promise<ResearchStartResponse> =>
      ipcRenderer.invoke('research:start', request),
    status: (jobId?: string): Promise<ResearchStatusResponse> =>
      ipcRenderer.invoke('research:status', jobId),
    challengeResolved: (site: string): Promise<ResearchBrowserStatus> =>
      ipcRenderer.invoke('research:challenge:resolved', { site }),
    loginStart: (site: ResearchLoginSite): Promise<ResearchBrowserStatus> =>
      ipcRenderer.invoke('research:login:start', { site }),
    loginDone: (site: ResearchLoginSite): Promise<ResearchBrowserStatus> =>
      ipcRenderer.invoke('research:login:done', { site }),
    onChallenge: (listener: (event: BrowserChallengeEvent) => void): (() => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, browserEvent: BrowserChallengeEvent): void => listener(browserEvent)
      ipcRenderer.on('browser:challenge', wrapped)
      return () => ipcRenderer.removeListener('browser:challenge', wrapped)
    }
  },
  voice: {
    state: (): Promise<VoiceState> => ipcRenderer.invoke('voice:state'),
    toggle: (): Promise<VoiceState> => ipcRenderer.invoke('voice:toggle'),
    pushToTalk: (): Promise<VoiceState> => ipcRenderer.invoke('voice:push-to-talk'),
    stop: (): Promise<VoiceState> => ipcRenderer.invoke('voice:stop'),
    interrupt: (): Promise<VoiceState> => ipcRenderer.invoke('voice:interrupt'),
    pcm: (pcm: ArrayBuffer): void => ipcRenderer.send('voice:pcm', pcm),
    microphoneError: (message: string): void => ipcRenderer.send('voice:microphone-error', message),
    readBack: (payload: unknown, text: string, gateId?: string): Promise<void> =>
      ipcRenderer.invoke('voice:readback', { payload, text, gateId }),
    approve: (transcript: string): Promise<ApprovalResult> =>
      ipcRenderer.invoke('voice:approve', transcript),
    onState: (listener: (state: VoiceState) => void): (() => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, state: VoiceState): void => listener(state)
      ipcRenderer.on('voice:state', wrapped)
      return () => ipcRenderer.removeListener('voice:state', wrapped)
    },
    onTranscript: (listener: (event: VoiceTranscriptEvent) => void): (() => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, transcript: VoiceTranscriptEvent): void => listener(transcript)
      ipcRenderer.on('voice:transcript', wrapped)
      return () => ipcRenderer.removeListener('voice:transcript', wrapped)
    },
    onAudio: (listener: (event: VoiceAudioEvent) => void): (() => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, audio: VoiceAudioEvent): void => listener(audio)
      ipcRenderer.on('voice:audio', wrapped)
      return () => ipcRenderer.removeListener('voice:audio', wrapped)
    },
    onAudioStop: (listener: () => void): (() => void) => {
      const wrapped = (): void => listener()
      ipcRenderer.on('voice:audio-stop', wrapped)
      return () => ipcRenderer.removeListener('voice:audio-stop', wrapped)
    },
    onMessage: (listener: (message: string) => void): (() => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, message: string): void => listener(message)
      ipcRenderer.on('voice:message', wrapped)
      return () => ipcRenderer.removeListener('voice:message', wrapped)
    }
  },
  dialog: {
    pickPath: (request: { kind: 'file' | 'folder'; extensions?: string[]; defaultPath?: string }): Promise<string | null> =>
      ipcRenderer.invoke('dialog:pickPath', request)
  },
  setup: {
    detectVault: (): Promise<string | null> => ipcRenderer.invoke('setup:detectVault')
  },
  files: {
    read: (path: string): Promise<string> => ipcRenderer.invoke('files:read', path),
    open: (path: string): Promise<string> => ipcRenderer.invoke('files:open', path)
  },
  builds: {
    start: (request: { request: string; id?: string; projectPath?: string; mode?: 'isolated' | 'direct'; direct?: boolean; targetBranch?: string; complexity?: 'small' | 'medium' | 'large'; language?: 'ar-EG' | 'en' | 'mixed'; register?: boolean; registrationKind?: 'skill' | 'project' }): Promise<{ id: string; status: BuildState['status']; workspacePath: string; branch: string; specPath: string; planPath: string }> =>
      ipcRenderer.invoke('build:start', request),
    status: (id?: string): Promise<BuildState | BuildState[]> => ipcRenderer.invoke('build:status', id),
    resume: (id: string): Promise<{ id: string; status: BuildState['status']; workspacePath: string; branch: string; specPath: string; planPath: string }> =>
      ipcRenderer.invoke('build:resume', id),
    merge: (id: string, options?: { strategy?: 'merge' | 'pr'; targetPath?: string }): Promise<unknown> =>
      ipcRenderer.invoke('build:merge', { id, ...options }),
    discard: (id: string): Promise<{ id: string; status: 'discarded' }> => ipcRenderer.invoke('build:discard', id),
    review: (id: string): Promise<unknown> => ipcRenderer.invoke('build:review', id),
    analyze: (request?: { id?: string; projectPath?: string; brief?: string; competitorBrief?: string; ideationPasses?: Array<'code-quality' | 'security' | 'performance' | 'ux' | 'documentation'> }): Promise<unknown> =>
      ipcRenderer.invoke('build:analyze', request),
    onEvent: (listener: (event: BuildEvent) => void): (() => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, buildEvent: BuildEvent): void => listener(buildEvent)
      ipcRenderer.on('build:events', wrapped)
      return () => ipcRenderer.removeListener('build:events', wrapped)
    }
  },
  window: {
    minimize: (): void => ipcRenderer.send('window:minimize'),
    maximize: (): void => ipcRenderer.send('window:maximize'),
    close: (): void => ipcRenderer.send('window:close'),
    state: (): Promise<WindowChromeState> => ipcRenderer.invoke('window:state'),
    onState: (listener: (state: WindowChromeState) => void): (() => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, state: WindowChromeState): void => listener(state)
      ipcRenderer.on('window:state', wrapped)
      return () => ipcRenderer.removeListener('window:state', wrapped)
    }
  },
  onSettingsChanged: (listener: (settings: AppSettings) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, settings: AppSettings): void => listener(settings)
    ipcRenderer.on('settings:changed', wrapped)
    return () => ipcRenderer.removeListener('settings:changed', wrapped)
  },
  onTasksChanged: (listener: () => void): (() => void) => {
    const wrapped = (): void => listener()
    ipcRenderer.on('tasks:changed', wrapped)
    return () => ipcRenderer.removeListener('tasks:changed', wrapped)
  }
}

contextBridge.exposeInMainWorld('octa', api)

export type OctaApi = typeof api

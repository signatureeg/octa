import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { JobEvent, JobRecord, JobStatus } from '../electron/types'
import type { PlanRecord } from '../electron/db/jobs'
import type { PlannerResult } from '../electron/core/octa/planner'
import type { SourceLedgerEntry } from '../electron/core/octa/sources'
import { OctaPage, type OctaPageApi, type OctaPanelState } from '../src/components/OctaPage'
import { Sidebar } from '../src/components/Sidebar'

const listJobs = vi.fn(async () => [] as JobRecord[])
const cancelJob = vi.fn(async () => true)
const approveJob = vi.fn(async () => null as JobRecord | null)
const onJobEvent = vi.fn((_listener: (event: JobEvent) => void) => () => undefined)
const planBrief = vi.fn(async () => plan)
const answerPlan = vi.fn(async () => plan)
const approvePlan = vi.fn(async () => plan)
const getPlan = vi.fn(async () => plan)
const onPlannerQuestions = vi.fn((_listener: Parameters<OctaPageApi['planner']['onQuestions']>[0]) => () => undefined)
const onPlannerRound = vi.fn((_listener: Parameters<OctaPageApi['planner']['onRound']>[0]) => () => undefined)

const api: OctaPageApi = {
  jobs: { list: listJobs, cancel: cancelJob, approve: approveJob, onEvent: onJobEvent },
  planner: {
    plan: planBrief,
    answer: answerPlan,
    approve: approvePlan,
    get: getPlan,
    onQuestions: onPlannerQuestions,
    onRound: onPlannerRound
  },
  files: {
    read: vi.fn(async () => '# Readable output'),
    open: vi.fn(async () => '')
  }
}

const question = {
  id: 'q1',
  text: 'Who should this reach?',
  why: 'The audience changes the work.',
  options: ['Founders', 'Teams'],
  blocking: true
}

const plan: PlannerResult = {
  status: 'needs_input',
  planId: 'plan-1',
  plan: {
    plan_id: 'plan-1',
    language: 'en',
    summary: 'Create a sourced launch plan for the new service.',
    questions: [question],
    assumptions: [],
    workflow: 'custom',
    steps: [{
      id: 's1',
      runner: 'codex-exec',
      skill: 'marketing-plan',
      needs: [],
      gate: 'approve',
      autonomy: 'assisted',
      acceptance: ['The launch plan is written to out/plan.md.']
    }],
    deliverables: ['out/plan.md'],
    estimated_minutes: 24
  },
  questions: [question],
  debate: [],
  debateMarkdown: 'Fable draft: clarify audience before execution.',
  briefPath: 'C:\\Octa\\jobs\\plan-1\\brief.md',
  planPath: 'C:\\Octa\\jobs\\plan-1\\plan.json',
  debatePath: 'C:\\Octa\\jobs\\plan-1\\debate.md',
  workspace: 'C:\\Octa\\jobs\\plan-1',
  round: 1,
  questionRound: 0
}

const source: SourceLedgerEntry = {
  n: 1,
  url: 'https://example.com/research',
  domain: 'example.com',
  title: 'Research source',
  lang: 'en',
  type: 'article',
  published: '2026-09-01',
  fetched: '2026-09-08T00:00:00.000Z',
  words: 420,
  claims: [],
  relevance: 0.94
}

function job(status: JobStatus, overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'job-1',
    planId: 'plan-1',
    workflow: 'custom',
    stepId: 's1',
    skill: 'marketing-plan',
    runner: 'codex-exec',
    department: 'marketing',
    status,
    autonomy: 'assisted',
    gate: status === 'needs_approval' ? 'approve' : 'none',
    input: { brief: 'Create a launch plan.' },
    result: null,
    review: null,
    sourceCount: 0,
    cost: null,
    startedAt: '2026-09-08T08:00:00.000Z',
    finishedAt: status === 'running' ? null : '2026-09-08T08:02:00.000Z',
    approvedBy: null,
    approvedAt: null,
    error: null,
    workflowRunId: null,
    state: null,
    gatePayload: null,
    gateCreatedAt: null,
    gateExpiresAt: null,
    gateDecision: null,
    gateComments: null,
    attempt: 1,
    ...overrides
  }
}

function renderPage(state: Partial<OctaPanelState> = {}, locale: 'en' | 'ar' = 'en'): string {
  return renderToStaticMarkup(createElement(OctaPage, { api, autoLoad: false, locale, state }))
}

describe('OctaPage states', () => {
  it('renders the idle conversation, empty plan slot, live slot, and empty steps', () => {
    const html = renderPage()
    expect(html).toContain("Hi, I&#x27;m Octa")
    expect(html).toContain('Octa needs setup')
    expect(html).toContain('Review a website')
    expect(html).toContain('Build a website')
    expect(html).toContain('Market a project')
    expect(html).toContain('Think through a project')
    expect(html).toContain('Handle an invoice')
    expect(html).toContain('Research a question')
    expect(html).toContain('No jobs yet. Your first run will appear here.')
    expect(html).toContain('No saved plans yet. Octa will keep the next one here.')
    expect(html).toContain('Bring the next thing into focus')
    expect(html).toContain('Nothing is queued yet')
    expect(html).toContain('Voice controls appear here')
    expect(html).toContain('Steps will appear after Octa has a plan.')
    expect(listJobs).not.toHaveBeenCalled()
  })

  it('renders planner questions and the debate viewer', () => {
    const html = renderPage({ plan })
    expect(html).toContain('Waiting for your answers')
    expect(html).toContain('Who should this reach?')
    expect(html).toContain('Fable draft: clarify audience before execution.')
    expect(html).toContain('Send answers')
  })

  it('shows only the five newest jobs and keeps recent plans visible on the home surface', () => {
    const jobs = Array.from({ length: 6 }, (_, index) => job('ok', {
      id: `job-${index}`,
      workflow: `workflow-${index}`
    }))
    const recentPlan: PlanRecord = {
      id: 'plan-recent',
      conversationId: null,
      briefMd: 'A recent brief',
      plan: { summary: 'Recent plan summary' },
      round: 1,
      questionRound: 0,
      status: 'approved',
      createdAt: '2026-09-08T08:03:00.000Z'
    }
    const html = renderPage({ jobs, recentPlans: [recentPlan] })
    expect(html).toContain('workflow-0')
    expect(html).toContain('workflow-4')
    expect(html).not.toContain('workflow-5')
    expect(html).toContain('Recent plan summary')
    expect(html).not.toContain('No jobs yet. Your first run will appear here.')
    expect(html).not.toContain('No saved plans yet. Octa will keep the next one here.')
  })

  it('renders running steps and live job events', () => {
    const html = renderPage({
      plan: { ...plan, status: 'approved', questions: [], plan: { ...plan.plan, questions: [] } },
      jobs: [job('running')],
      events: [{ type: 'text', jobId: 'job-1', timestamp: '2026-09-08T08:01:00.000Z', text: 'Research is gathering context.' }]
    })
    expect(html).toContain('Working now')
    expect(html).toContain('Research is gathering context.')
    expect(html).toContain('Streaming')
    expect(html).toContain('Running')
  })

  it('renders the exact gate payload with one-click approval, rejection, and comment controls', () => {
    const html = renderPage({
      plan: { ...plan, status: 'approved', questions: [], plan: { ...plan.plan, questions: [] } },
      jobs: [job('needs_approval', {
        result: { payload: { channel: 'email', body: 'The exact approved message.' } }
      })]
    })
    expect(html).toContain('Review before Octa acts')
    expect(html).toContain('&quot;channel&quot;: &quot;email&quot;')
    expect(html).toContain('Approve payload')
    expect(html).toContain('Reject')
    expect(html).toContain('Add comment')
  })

  it('renders completed outputs and the source ledger', () => {
    const html = renderPage({
      plan: { ...plan, status: 'approved', questions: [], plan: { ...plan.plan, questions: [] } },
      jobs: [job('ok', {
        result: {
          outputs: [{ path: 'C:\\Octa\\jobs\\job-1\\out\\plan.md', type: 'markdown', title: 'Launch plan' }],
          sourceEntries: [source]
        },
        sourceCount: 1
      })]
    })
    expect(html).toContain('Work complete')
    expect(html).toContain('Launch plan')
    expect(html).toContain('View')
    expect(html).toContain('Research source')
  })

  it('renders a failure summary with recovery context', () => {
    const html = renderPage({
      plan: { ...plan, status: 'approved', questions: [], plan: { ...plan.plan, questions: [] } },
      jobs: [job('failed', { error: 'The scout stopped before the source gate.' })]
    })
    expect(html).toContain('This run needs attention')
    expect(html).toContain('The scout stopped before the source gate.')
    expect(html).toContain('Failed')
  })

  it('sets RTL direction for Arabic and keeps the full sidebar navigation available', () => {
    const html = renderPage({}, 'ar')
    expect(html).toContain('dir="rtl"')
    const sidebar = renderToStaticMarkup(createElement(Sidebar, {
      locale: 'en',
      onChange: () => undefined,
      onToggleLocale: () => undefined,
      page: 'octa'
    }))
    expect(sidebar.indexOf('Octa')).toBeLessThan(sidebar.indexOf('Jobs'))
    expect(sidebar.indexOf('Jobs')).toBeLessThan(sidebar.indexOf('Workflows'))
    expect(sidebar.indexOf('Workflows')).toBeLessThan(sidebar.indexOf('Skills'))
    expect(sidebar.indexOf('Skills')).toBeLessThan(sidebar.indexOf('Brain'))
    expect(sidebar.indexOf('Brain')).toBeLessThan(sidebar.indexOf('Settings'))
  })
})

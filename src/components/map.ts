import type { JobOutput, JobRecord, JobStatus } from '../../electron/types'
import type { Skill } from '../../electron/core/skills/registry'
import type { Locale, TranslationKey } from '../i18n'
import { t } from '../i18n'

export const MAP_DEPARTMENTS = [
  'sales',
  'deals',
  'marketing',
  'design',
  'operations',
  'intelligence',
  'customer',
  'backoffice',
  'engineering',
  'thinking',
  'documents',
  'commerce',
  'personal-os'
] as const

export type MapDepartment = (typeof MAP_DEPARTMENTS)[number]

const DEPARTMENT_KEYS: Record<MapDepartment, TranslationKey> = {
  sales: 'mapDepartmentSales',
  deals: 'mapDepartmentDeals',
  marketing: 'mapDepartmentMarketing',
  design: 'mapDepartmentDesign',
  operations: 'mapDepartmentOperations',
  intelligence: 'mapDepartmentIntelligence',
  customer: 'mapDepartmentCustomer',
  backoffice: 'mapDepartmentBackoffice',
  engineering: 'mapDepartmentEngineering',
  thinking: 'mapDepartmentThinking',
  documents: 'mapDepartmentDocuments',
  commerce: 'mapDepartmentCommerce',
  'personal-os': 'mapDepartmentPersonalOs'
}

/** Localised department name; shared by the Map and Skills pages. */
export function departmentLabel(department: string, locale: Locale): string {
  const key = DEPARTMENT_KEYS[department as MapDepartment]
  return key ? t(key, locale) : t('mapDepartmentOther', locale)
}
export type MapSkillStatus = 'never' | 'ok' | 'failed' | 'needs_approval' | 'running'

export const MAP_STATUS_COLORS: Readonly<Record<MapSkillStatus, string>> = {
  never: '#746b7f',
  ok: '#4ebe96',
  failed: '#ff5c5c',
  needs_approval: '#9d78d2',
  running: '#479ffa'
}

const VISIBLE_VERDICTS = new Set(['core', 'keep', 'client'])

export function isVisibleSkill(skill: Pick<Skill, 'verdict'>): boolean {
  return VISIBLE_VERDICTS.has(skill.verdict)
}

export interface MapLayoutNode {
  id: string
  type: 'center' | 'department' | 'skill'
  label: string
  x: number
  y: number
  radius: number
  /** Direction from the center in radians (department and skill nodes). */
  angle?: number
  department?: string
  skill?: Skill
}

export interface MapLayoutLink {
  source: string
  target: string
  type: 'center-department' | 'department-skill'
}

export interface MapLayout {
  width: number
  height: number
  center: MapLayoutNode
  departments: MapLayoutNode[]
  skills: MapLayoutNode[]
  nodes: MapLayoutNode[]
  links: MapLayoutLink[]
}

export interface MapLayoutOptions {
  width?: number
  height?: number
}

export interface SkillRunField {
  name: 'text'
  type: 'textarea'
  placeholder: string
}

export interface SkillRunForm {
  skill: string
  description: string
  argumentHint: string
  fields: readonly SkillRunField[]
}

const DEFAULT_MAP_WIDTH = 0
const DEFAULT_MAP_HEIGHT = 0
/** Distance along the ring between two neighbouring skills; ~ one label line at the rendered scale. */
const SLOT_SPACING = 17
const MIN_SKILL_RADIUS = 260
/** Room outside the ring for a label (24 mono chars) plus its autonomy tag. */
const LABEL_REACH = 230

function compareNames(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function safeDimension(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

function visibleSkills(skills: readonly Skill[]): Skill[] {
  return skills
    .filter(isVisibleSkill)
    .slice()
}

/**
 * Place the center, department branches, and visible skills without a graph
 * dependency. The ordering and every radius/angle are derived from stable
 * inputs, so the same registry always paints the same map.
 */
export function layoutMap(skills: readonly Skill[], options: MapLayoutOptions = {}): MapLayout {
  const width = safeDimension(options.width, DEFAULT_MAP_WIDTH)
  const height = safeDimension(options.height, DEFAULT_MAP_HEIGHT)
  const center: MapLayoutNode = {
    id: 'center',
    type: 'center',
    label: 'Octa brain',
    x: width / 2,
    y: height / 2,
    radius: 48
  }
  const groups = new Map<string, Skill[]>()

  for (const skill of visibleSkills(skills)) {
    const department = skill.department.trim().toLocaleLowerCase() || 'other'
    const group = groups.get(department) ?? []
    group.push(skill)
    groups.set(department, group)
  }

  for (const group of groups.values()) group.sort((left, right) => compareNames(left.name, right.name))

  const extraDepartments = [...groups.keys()]
    .filter((department) => !(MAP_DEPARTMENTS as readonly string[]).includes(department))
    .sort(compareNames)
  const departmentNames = [...MAP_DEPARTMENTS, ...extraDepartments]

  // Radial tree: every skill sits on one ring, grouped into department sectors with a gap
  // between sectors, and its label points straight outward. Labels never cross each other,
  // which the old fan-of-rows layout could not guarantee once a department had ~10 skills.
  const gapSlots = 1.5
  const sectorSlots = departmentNames.map((department) => Math.max(1, groups.get(department)?.length ?? 0) + gapSlots)
  const totalSlots = sectorSlots.reduce((sum, value) => sum + value, 0)
  const slotAngle = (Math.PI * 2) / totalSlots
  const skillRadius = Math.max(MIN_SKILL_RADIUS, (totalSlots * SLOT_SPACING) / (Math.PI * 2))
  const departmentRadius = skillRadius * 0.55
  const size = Math.max(width, height, Math.ceil((skillRadius + LABEL_REACH) * 2))
  center.x = size / 2
  center.y = size / 2
  const startAngle = -Math.PI / 2
  const departments: MapLayoutNode[] = []
  const skillNodes: MapLayoutNode[] = []
  const links: MapLayoutLink[] = []

  let cursor = 0
  departmentNames.forEach((department, departmentIndex) => {
    const group = groups.get(department) ?? []
    const slots = sectorSlots[departmentIndex]
    const firstSkill = cursor + gapSlots / 2 + 0.5
    const middle = startAngle + (cursor + slots / 2) * slotAngle
    const departmentNode: MapLayoutNode = {
      id: `department:${department}`,
      type: 'department',
      label: department,
      x: center.x + Math.cos(middle) * departmentRadius,
      y: center.y + Math.sin(middle) * departmentRadius,
      radius: 44,
      angle: middle,
      department
    }
    departments.push(departmentNode)
    links.push({ source: center.id, target: departmentNode.id, type: 'center-department' })

    group.forEach((skill, skillIndex) => {
      const angle = startAngle + (firstSkill + skillIndex) * slotAngle
      const node: MapLayoutNode = {
        id: `skill:${skill.name}`,
        type: 'skill',
        label: skill.name,
        x: center.x + Math.cos(angle) * skillRadius,
        y: center.y + Math.sin(angle) * skillRadius,
        radius: 7,
        angle,
        department,
        skill
      }
      skillNodes.push(node)
      links.push({ source: departmentNode.id, target: node.id, type: 'department-skill' })
    })
    cursor += slots
  })

  spreadDepartments(departments, center, departmentRadius)

  return {
    width: size,
    height: size,
    center,
    departments,
    skills: skillNodes,
    nodes: [center, ...departments, ...skillNodes],
    links
  }
}

/**
 * Small departments get narrow sectors, so their hub circles can collide. Push neighbouring hubs
 * apart along the ring until each pair is at least one diameter (plus a margin) apart.
 */
function spreadDepartments(departments: MapLayoutNode[], center: MapLayoutNode, radius: number): void {
  if (departments.length < 2) return
  const minGap = (departments[0].radius * 2 + 10) / radius
  const angles = departments.map((node) => node.angle ?? 0)
  for (let pass = 0; pass < 200; pass++) {
    let moved = false
    for (let index = 0; index < angles.length; index++) {
      const next = (index + 1) % angles.length
      let gap = angles[next] - angles[index]
      if (next === 0) gap += Math.PI * 2
      if (gap < minGap) {
        const push = (minGap - gap) / 2 + 1e-4
        angles[index] -= push
        angles[next] += push
        moved = true
      }
    }
    if (!moved) break
  }
  departments.forEach((node, index) => {
    node.angle = angles[index]
    node.x = center.x + Math.cos(angles[index]) * radius
    node.y = center.y + Math.sin(angles[index]) * radius
  })
}

function jobTimestamp(job: JobRecord): number {
  const value = job.startedAt ?? job.finishedAt
  if (!value) return Number.NEGATIVE_INFINITY
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp
}

function orderedJobs(jobs: readonly JobRecord[]): JobRecord[] {
  return jobs
    .map((job, index) => ({ job, index }))
    .sort((left, right) => jobTimestamp(right.job) - jobTimestamp(left.job) || left.index - right.index)
    .map(({ job }) => job)
}

/** Return the most recent persisted job for each skill. */
export function latestJobBySkill(jobs: readonly JobRecord[]): Map<string, JobRecord> {
  const latest = new Map<string, JobRecord>()
  for (const job of orderedJobs(jobs)) {
    const skill = job.skill?.trim()
    if (skill && !latest.has(skill)) latest.set(skill, job)
  }
  return latest
}

/** Collapse job states into the five visual states used by the map. */
export function mapJobStatus(status: JobStatus | string | null | undefined): MapSkillStatus {
  switch (status) {
    case 'running':
      return 'running'
    case 'ok':
      return 'ok'
    case 'needs_approval':
      return 'needs_approval'
    case 'failed':
      return 'failed'
    case 'never':
    case undefined:
    case null:
      return 'never'
    default:
      // needs_input and cancelled are both non-success terminal states. The
      // map deliberately keeps the status palette compact and clear.
      return 'failed'
  }
}

export function skillStatus(skillName: string, jobs: readonly JobRecord[]): MapSkillStatus {
  return mapJobStatus(latestJobBySkill(jobs).get(skillName)?.status)
}

export function statusColor(status: MapSkillStatus): string {
  return MAP_STATUS_COLORS[status]
}

export const colorForStatus = statusColor

function outputRecord(value: unknown): JobOutput | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const candidate = value as Partial<JobOutput>
  if (typeof candidate.path !== 'string' || typeof candidate.type !== 'string' || typeof candidate.title !== 'string') {
    return undefined
  }
  return { path: candidate.path, type: candidate.type, title: candidate.title }
}

function outputsFromJob(job: JobRecord): JobOutput[] {
  if (typeof job.result !== 'object' || job.result === null || Array.isArray(job.result)) return []
  const outputs = (job.result as { outputs?: unknown }).outputs
  if (!Array.isArray(outputs)) return []
  return outputs.map(outputRecord).filter((output): output is JobOutput => output !== undefined)
}

/** Flatten the newest runs into the three most recent output files. */
export function lastOutputsForSkill(skillName: string, jobs: readonly JobRecord[], limit = 3): JobOutput[] {
  const safeLimit = Math.max(0, Math.trunc(limit))
  if (safeLimit === 0) return []
  const outputs: JobOutput[] = []
  for (const job of orderedJobs(jobs)) {
    if (job.skill !== skillName) continue
    outputs.push(...outputsFromJob(job))
    if (outputs.length >= safeLimit) return outputs.slice(0, safeLimit)
  }
  return outputs
}

/** Build the one free-form field shown when a skill is opened from the map. */
export function buildSkillRunForm(skill: Skill): SkillRunForm {
  const argumentHint = skill.argumentHint?.trim() ?? ''
  return {
    skill: skill.name,
    description: skill.description,
    argumentHint,
    fields: [{
      name: 'text',
      type: 'textarea',
      placeholder: argumentHint
    }]
  }
}

export const generateSkillRunForm = buildSkillRunForm

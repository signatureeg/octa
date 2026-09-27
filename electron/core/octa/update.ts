import type { AppUpdate, UpdateStatus } from '../../types'

/** The public repository used by the first Octa release. It can be changed in Settings. */
export const DEFAULT_UPDATE_REPOSITORY = 'abdutamim/octa'
export const GITHUB_API_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28'
} as const

export interface UpdateReleaseAsset {
  name?: unknown
  browser_download_url?: unknown
}

export interface UpdateReleasePayload {
  tag_name?: unknown
  html_url?: unknown
  assets?: unknown
  draft?: unknown
  prerelease?: unknown
}

export interface UpdateResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
}

export type UpdateFetcher = (
  url: string,
  options?: { headers: Record<string, string> }
) => Promise<UpdateResponse>

export interface UpdateCheckOptions {
  currentVersion: string
  repository?: string
  environment?: NodeJS.ProcessEnv
  fetcher?: UpdateFetcher
  now?: () => Date
}

export type UpdateCheckResult = AppUpdate

function emptyResult(
  currentVersion: string,
  repository: string,
  status: UpdateStatus,
  options: Pick<UpdateCheckOptions, 'now'>,
  extra: Partial<AppUpdate> = {}
): AppUpdate {
  return {
    status,
    currentVersion,
    repository,
    checkedAt: (options.now ?? (() => new Date()))().toISOString(),
    ...extra
  }
}

/** Accept owner/repo or a GitHub repository URL and return the canonical slug. */
export function normalizeRepository(value: string): string | null {
  let candidate = value.trim()
  if (!candidate) return null

  if (/^(?:https?:\/\/)?(?:www\.)?github\.com\//i.test(candidate)) {
    candidate = candidate.replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, '')
  }
  candidate = candidate.replace(/\.git\/?$/i, '').replace(/\/+$/, '')
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(candidate)) return null
  return candidate
}

export function resolveConfiguredRepository(
  configured: string | undefined,
  environment: NodeJS.ProcessEnv = process.env
): string {
  const candidate = configured?.trim() || environment.OCTA_UPDATE_REPOSITORY?.trim() || DEFAULT_UPDATE_REPOSITORY
  return normalizeRepository(candidate) ?? DEFAULT_UPDATE_REPOSITORY
}

interface ParsedVersion {
  numbers: [number, number, number]
  prerelease: string[]
}

function parseVersion(value: string): ParsedVersion | null {
  const match = value.trim().replace(/^[v=]/i, '').match(
    /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
  )
  if (!match) return null
  return {
    numbers: [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)],
    prerelease: match[4] ? match[4].split('.') : []
  }
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) return 0
  if (left.length === 0) return 1
  if (right.length === 0) return -1
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    if (a === b) continue
    const aNumber = /^\d+$/.test(a)
    const bNumber = /^\d+$/.test(b)
    if (aNumber && bNumber) return Number(a) > Number(b) ? 1 : -1
    if (aNumber !== bNumber) return aNumber ? -1 : 1
    return a > b ? 1 : -1
  }
  return 0
}

/** Returns -1 when current is older, 0 when equal, and 1 when newer. */
export function compareVersions(current: string, latest: string): number {
  const left = parseVersion(current)
  const right = parseVersion(latest)
  if (!left || !right) return 0
  for (let index = 0; index < left.numbers.length; index += 1) {
    if (left.numbers[index] !== right.numbers[index]) return left.numbers[index] > right.numbers[index] ? 1 : -1
  }
  return comparePrerelease(left.prerelease, right.prerelease)
}

function githubUrl(value: unknown, repository: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const url = new URL(value)
    const expectedPrefix = `/${repository.toLowerCase()}`
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') return null
    const pathname = url.pathname.toLowerCase().replace(/\/+$/, '')
    if (pathname !== expectedPrefix && !pathname.startsWith(`${expectedPrefix}/`)) return null
    return url.toString()
  } catch {
    return null
  }
}

function releaseAssets(value: unknown): UpdateReleaseAsset[] {
  if (!Array.isArray(value)) return []
  return value.filter((asset): asset is UpdateReleaseAsset => Boolean(asset && typeof asset === 'object'))
}

function releaseLink(payload: UpdateReleasePayload, repository: string, tag: string): { releaseUrl: string; downloadUrl: string; appUpdateUrl?: string } {
  const releaseUrl = githubUrl(payload.html_url, repository) ??
    `https://github.com/${repository}/releases/tag/${encodeURIComponent(tag)}`
  const installer = releaseAssets(payload.assets).find((asset) =>
    typeof asset.name === 'string' && /\.exe$/i.test(asset.name) && githubUrl(asset.browser_download_url, repository)
  )
  const appManifest = releaseAssets(payload.assets).find((asset) => asset.name === 'app-update.json')
  const appUpdateUrl = githubUrl(appManifest?.browser_download_url, repository) ?? undefined
  return {
    releaseUrl,
    downloadUrl: githubUrl(installer?.browser_download_url, repository) ?? releaseUrl,
    ...(appUpdateUrl ? { appUpdateUrl } : {})
  }
}

/**
 * The download base of the newest release that still carries a full installer (latest.yml). App-only
 * releases do not, so electron-updater must be pointed at this URL as a generic feed instead of
 * GitHub's "latest" release.
 */
export async function findFullInstallerFeed(
  repository: string,
  currentVersion: string,
  fetcher: UpdateFetcher = async (url, init) => fetch(url, init)
): Promise<{ tag: string; url: string } | null> {
  const endpoint = `https://api.github.com/repos/${repository}/releases?per_page=20`
  try {
    const response = await fetcher(endpoint, { headers: { ...GITHUB_API_HEADERS, 'User-Agent': `Octa-Assistant/${currentVersion}` } })
    if (!response.ok) return null
    const releases = await response.json() as unknown
    if (!Array.isArray(releases)) return null
    for (const release of releases as UpdateReleasePayload[]) {
      if (!release || release.draft === true || release.prerelease === true) continue
      const tag = typeof release.tag_name === 'string' ? release.tag_name.trim() : ''
      if (!tag || !parseVersion(tag)) continue
      const hasFeed = releaseAssets(release.assets).some((asset) => asset.name === 'latest.yml')
      const hasInstaller = releaseAssets(release.assets).some((asset) => typeof asset.name === 'string' && /\.exe$/i.test(asset.name))
      if (hasFeed && hasInstaller) return { tag, url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}` }
    }
    return null
  } catch {
    return null
  }
}

function errorText(status: number): string {
  return status > 0 ? `GitHub release check returned HTTP ${status}.` : 'GitHub release check failed.'
}

/** Read the latest non-draft GitHub release. This function never installs or replaces the app. */
export async function checkForUpdate(options: UpdateCheckOptions): Promise<AppUpdate> {
  const currentVersion = options.currentVersion.trim() || '0.0.0'
  const repository = normalizeRepository(
    options.repository?.trim() || options.environment?.OCTA_UPDATE_REPOSITORY?.trim() || DEFAULT_UPDATE_REPOSITORY
  )
  if (!repository) {
    return emptyResult(currentVersion, '', 'unconfigured', options, {
      error: 'A GitHub repository in owner/repo format is required.'
    })
  }

  const fetcher = options.fetcher ?? (async (url, init) => fetch(url, init))
  const endpoint = `https://api.github.com/repos/${repository}/releases/latest`
  try {
    const response = await fetcher(endpoint, { headers: { ...GITHUB_API_HEADERS, 'User-Agent': `Octa-Assistant/${currentVersion}` } })
    if (!response.ok) {
      return emptyResult(currentVersion, repository, 'error', options, { error: errorText(response.status) })
    }
    const payload = await response.json() as UpdateReleasePayload
    const latestVersion = typeof payload.tag_name === 'string' ? payload.tag_name.trim() : ''
    if (!latestVersion || !parseVersion(latestVersion)) {
      return emptyResult(currentVersion, repository, 'error', options, { error: 'GitHub returned an invalid release version.' })
    }
    const links = releaseLink(payload, repository, latestVersion)
    const newer = compareVersions(currentVersion, latestVersion) < 0
    return emptyResult(currentVersion, repository, newer ? 'available' : 'current', options, {
      latestVersion,
      ...links
    })
  } catch {
    return emptyResult(currentVersion, repository, 'error', options, { error: errorText(0) })
  }
}

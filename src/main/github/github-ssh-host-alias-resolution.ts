import type { GitHubOwnerRepo } from '../../shared/types'
import { resolveWithSshG } from '../ssh/ssh-g-config-resolution'
import {
  gitHubSshConfigHostAlias,
  parseGitHubOwnerRepo,
  parseGitHubOwnerRepoWithResolvedSshHostname
} from './github-remote-identity-parsing'

/**
 * Outcome of github.com owner/repo resolution including SSH Host alias expansion.
 * `indeterminate` means OpenSSH could not expand the alias (timeout/missing ssh) —
 * must not be long-negative-cached as "not GitHub" (#10284).
 */
export type GitHubOwnerRepoResolution =
  | { kind: 'github'; ownerRepo: GitHubOwnerRepo }
  | { kind: 'not-github' }
  | { kind: 'indeterminate' }

const SSH_HOSTNAME_CACHE_TTL_MS = 60_000
const SSH_HOSTNAME_CACHE_MAX = 256

type SshHostnameCacheEntry = {
  hostname: string | null
  /** false when ssh -G failed — short TTL, not a stable non-GitHub host */
  resolved: boolean
  expiresAt: number
}

const sshHostnameCache = new Map<string, SshHostnameCacheEntry>()
const sshHostnameInFlight = new Map<string, Promise<SshHostnameCacheEntry>>()

/** @internal - tests only */
export function _resetSshHostnameResolutionCache(): void {
  sshHostnameCache.clear()
  sshHostnameInFlight.clear()
}

function pruneSshHostnameCache(now: number): void {
  for (const [key, entry] of sshHostnameCache) {
    if (entry.expiresAt <= now) {
      sshHostnameCache.delete(key)
    }
  }
  while (sshHostnameCache.size > SSH_HOSTNAME_CACHE_MAX) {
    const oldest = sshHostnameCache.keys().next().value
    if (oldest === undefined) {
      return
    }
    sshHostnameCache.delete(oldest)
  }
}

/**
 * Resolve OpenSSH Host → HostName for identity classification only.
 * Caches successful expansions; failed probes get a short TTL so flaky ssh
 * does not pin a 5-minute "not GitHub" owner/repo miss.
 */
export async function resolveSshConfigHostname(host: string): Promise<{
  hostname: string | null
  resolved: boolean
}> {
  const cacheKey = host
  const now = Date.now()
  pruneSshHostnameCache(now)
  const cached = sshHostnameCache.get(cacheKey)
  if (cached && cached.expiresAt > now) {
    return { hostname: cached.hostname, resolved: cached.resolved }
  }
  const inFlight = sshHostnameInFlight.get(cacheKey)
  if (inFlight) {
    const entry = await inFlight
    return { hostname: entry.hostname, resolved: entry.resolved }
  }
  const probe = (async (): Promise<SshHostnameCacheEntry> => {
    const config = await resolveWithSshG(host)
    const hostname = config?.hostname?.trim() || null
    const resolved = hostname != null && hostname.length > 0
    const entry: SshHostnameCacheEntry = {
      hostname: resolved ? hostname : null,
      resolved,
      // Why: successful HostName is stable; failed probes must retry soon.
      expiresAt: Date.now() + (resolved ? SSH_HOSTNAME_CACHE_TTL_MS : 5_000)
    }
    sshHostnameCache.set(cacheKey, entry)
    pruneSshHostnameCache(Date.now())
    return entry
  })()
  sshHostnameInFlight.set(cacheKey, probe)
  try {
    const entry = await probe
    return { hostname: entry.hostname, resolved: entry.resolved }
  } finally {
    if (sshHostnameInFlight.get(cacheKey) === probe) {
      sshHostnameInFlight.delete(cacheKey)
    }
  }
}

/**
 * Resolve github.com owner/repo from a remote URL, expanding OpenSSH Host
 * aliases via `ssh -G` when the remote host is not literally github.com.
 * Transport URL is never rewritten — only identity classification uses HostName.
 */
export async function classifyGitHubOwnerRepoFromRemoteUrl(
  remoteUrl: string
): Promise<GitHubOwnerRepoResolution> {
  const direct = parseGitHubOwnerRepo(remoteUrl)
  if (direct) {
    return { kind: 'github', ownerRepo: direct }
  }
  const aliasHost = gitHubSshConfigHostAlias(remoteUrl)
  if (!aliasHost) {
    return { kind: 'not-github' }
  }
  const { hostname, resolved } = await resolveSshConfigHostname(aliasHost)
  if (!resolved || !hostname) {
    return { kind: 'indeterminate' }
  }
  const ownerRepo = parseGitHubOwnerRepoWithResolvedSshHostname(remoteUrl, hostname)
  return ownerRepo ? { kind: 'github', ownerRepo } : { kind: 'not-github' }
}

/** Convenience wrapper for callers that only need owner/repo or null. */
export async function resolveGitHubOwnerRepoFromRemoteUrl(
  remoteUrl: string
): Promise<GitHubOwnerRepo | null> {
  const result = await classifyGitHubOwnerRepoFromRemoteUrl(remoteUrl)
  return result.kind === 'github' ? result.ownerRepo : null
}

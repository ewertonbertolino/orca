import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitRunner from '../git/runner'

// #10284: getOwnerRepoForRemote must expand OpenSSH Host aliases so PR merge
// can resolve owner/repo when origin is git@github-work:OWNER/REPO.git.

const { gitExecFileAsyncMock, resolveWithSshGMock, readLocalGitConfigSignatureMock } = vi.hoisted(
  () => ({
    gitExecFileAsyncMock: vi.fn(),
    resolveWithSshGMock: vi.fn(),
    readLocalGitConfigSignatureMock: vi.fn(async () => 'sig-10284')
  })
)

vi.mock('../git/runner', async (importOriginal) => ({
  ...(await importOriginal<typeof GitRunner>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: () => null
}))

vi.mock('./local-git-config-signature', () => ({
  readLocalGitConfigSignature: readLocalGitConfigSignatureMock
}))

vi.mock('../ssh/ssh-g-config-resolution', () => ({
  resolveWithSshG: resolveWithSshGMock
}))

import {
  getOwnerRepoForRemote,
  _resetOwnerRepoCache,
  _getOwnerRepoCacheSize
} from './github-repository-identity'
import {
  classifyGitHubOwnerRepoFromRemoteUrl,
  resolveGitHubOwnerRepoFromRemoteUrl,
  _resetSshHostnameResolutionCache
} from './github-ssh-host-alias-resolution'

const REPO = '/tmp/ssh-alias-checkout'

function mockRemoteUrl(url: string): void {
  gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'remote' && args[1] === 'get-url') {
      return { stdout: `${url}\n` }
    }
    throw new Error(`unexpected git args: ${args.join(' ')}`)
  })
}

beforeEach(() => {
  _resetOwnerRepoCache()
  _resetSshHostnameResolutionCache()
  gitExecFileAsyncMock.mockReset()
  resolveWithSshGMock.mockReset()
  readLocalGitConfigSignatureMock.mockClear()
})

describe('#10284 SSH Host alias → github.com owner/repo', () => {
  it('resolveGitHubOwnerRepoFromRemoteUrl expands HostName ssh.github.com', async () => {
    resolveWithSshGMock.mockResolvedValueOnce({
      hostname: 'ssh.github.com',
      port: 443,
      identityFile: [],
      identitiesOnly: true,
      forwardAgent: false,
      proxyUseFdpass: false,
      controlMaster: 'no',
      controlPersist: 'no'
    })

    await expect(
      resolveGitHubOwnerRepoFromRemoteUrl('git@github-work:team/orca.git')
    ).resolves.toEqual({ owner: 'team', repo: 'orca' })
    expect(resolveWithSshGMock).toHaveBeenCalledWith('github-work')
  })

  it('getOwnerRepoForRemote resolves SCP alias remote used for multi-account GitHub', async () => {
    mockRemoteUrl('git@github-work:team/orca.git')
    resolveWithSshGMock.mockResolvedValueOnce({
      hostname: 'github.com',
      port: 22,
      identityFile: ['/home/me/.ssh/id_ed25519_work'],
      identitiesOnly: true,
      forwardAgent: false,
      proxyUseFdpass: false,
      controlMaster: 'no',
      controlPersist: 'no'
    })

    await expect(getOwnerRepoForRemote(REPO, 'origin')).resolves.toEqual({
      owner: 'team',
      repo: 'orca'
    })
    expect(resolveWithSshGMock).toHaveBeenCalledWith('github-work')
  })

  it('getOwnerRepoForRemote resolves ssh:// Host alias remotes', async () => {
    mockRemoteUrl('ssh://git@github.com-work/acme/widgets.git')
    resolveWithSshGMock.mockResolvedValueOnce({
      hostname: 'ssh.github.com',
      port: 443,
      identityFile: [],
      identitiesOnly: false,
      forwardAgent: false,
      proxyUseFdpass: false,
      controlMaster: 'no',
      controlPersist: 'no'
    })

    await expect(getOwnerRepoForRemote(REPO, 'origin')).resolves.toEqual({
      owner: 'acme',
      repo: 'widgets'
    })
    expect(resolveWithSshGMock).toHaveBeenCalledWith('github.com-work')
  })

  it('does not call ssh -G for literal github.com remotes', async () => {
    mockRemoteUrl('git@github.com:team/orca.git')

    await expect(getOwnerRepoForRemote(REPO, 'origin')).resolves.toEqual({
      owner: 'team',
      repo: 'orca'
    })
    expect(resolveWithSshGMock).not.toHaveBeenCalled()
  })

  it('does not call ssh -G for https remotes', async () => {
    mockRemoteUrl('https://github.com/team/orca.git')

    await expect(getOwnerRepoForRemote(REPO, 'origin')).resolves.toEqual({
      owner: 'team',
      repo: 'orca'
    })
    expect(resolveWithSshGMock).not.toHaveBeenCalled()
  })

  it('returns null when alias resolves to a non-GitHub host', async () => {
    mockRemoteUrl('git@gitlab-work:team/orca.git')
    resolveWithSshGMock.mockResolvedValueOnce({
      hostname: 'gitlab.com',
      port: 22,
      identityFile: [],
      identitiesOnly: false,
      forwardAgent: false,
      proxyUseFdpass: false,
      controlMaster: 'no',
      controlPersist: 'no'
    })

    await expect(getOwnerRepoForRemote(REPO, 'origin')).resolves.toBeNull()
  })

  it('returns null when ssh -G fails for an alias', async () => {
    mockRemoteUrl('git@github-work:team/orca.git')
    resolveWithSshGMock.mockResolvedValueOnce(null)

    await expect(getOwnerRepoForRemote(REPO, 'origin')).resolves.toBeNull()
  })

  it('does not rewrite transport: identity resolution only consumes HostName', async () => {
    // Guarantees we never mutate the remote URL passed to git — only classify.
    const remote = 'git@github-work:team/orca.git'
    mockRemoteUrl(remote)
    resolveWithSshGMock.mockResolvedValueOnce({
      hostname: 'github.com',
      port: 22,
      identityFile: [],
      identitiesOnly: false,
      forwardAgent: false,
      proxyUseFdpass: false,
      controlMaster: 'no',
      controlPersist: 'no'
    })

    await getOwnerRepoForRemote(REPO, 'origin')
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['remote', 'get-url', 'origin'],
      expect.objectContaining({ cwd: REPO })
    )
    // No `remote set-url` or similar — classification only.
    const gitArgLists = gitExecFileAsyncMock.mock.calls.map(([args]) => args.join(' '))
    expect(gitArgLists.every((cmd) => cmd.startsWith('remote get-url'))).toBe(true)
  })

  it('classifies ssh -G failure as indeterminate (not stable not-github)', async () => {
    resolveWithSshGMock.mockResolvedValueOnce(null)
    await expect(
      classifyGitHubOwnerRepoFromRemoteUrl('git@github-work:team/orca.git')
    ).resolves.toEqual({ kind: 'indeterminate' })
  })

  it('does not long-negative-cache owner/repo when ssh -G is indeterminate', async () => {
    mockRemoteUrl('git@github-work:team/orca.git')
    resolveWithSshGMock.mockResolvedValue(null)

    await expect(getOwnerRepoForRemote(REPO, 'origin')).resolves.toBeNull()
    // Indeterminate probes must not populate the owner/repo cache (no 5-min miss).
    expect(_getOwnerRepoCacheSize()).toBe(0)

    // Hostname resolution may short-TTL a failed probe; after that cache is cleared,
    // a later lookup must re-run ssh -G instead of a pinned owner/repo miss.
    _resetSshHostnameResolutionCache()
    await expect(getOwnerRepoForRemote(REPO, 'origin')).resolves.toBeNull()
    expect(resolveWithSshGMock).toHaveBeenCalledTimes(2)
    expect(_getOwnerRepoCacheSize()).toBe(0)
  })

  it('caches a successful HostName expansion so repeat probes skip ssh -G', async () => {
    mockRemoteUrl('git@github-work:team/orca.git')
    resolveWithSshGMock.mockResolvedValue({
      hostname: 'github.com',
      port: 22,
      identityFile: [],
      identitiesOnly: false,
      forwardAgent: false,
      proxyUseFdpass: false,
      controlMaster: 'no',
      controlPersist: 'no'
    })

    await expect(getOwnerRepoForRemote(REPO, 'origin')).resolves.toEqual({
      owner: 'team',
      repo: 'orca'
    })
    await expect(getOwnerRepoForRemote(REPO, 'origin')).resolves.toEqual({
      owner: 'team',
      repo: 'orca'
    })
    // owner/repo positive cache + ssh hostname cache: only one ssh -G.
    expect(resolveWithSshGMock).toHaveBeenCalledTimes(1)
  })

  it('classifies a resolved non-GitHub HostName as not-github', async () => {
    resolveWithSshGMock.mockResolvedValueOnce({
      hostname: 'gitlab.com',
      port: 22,
      identityFile: [],
      identitiesOnly: false,
      forwardAgent: false,
      proxyUseFdpass: false,
      controlMaster: 'no',
      controlPersist: 'no'
    })
    await expect(
      classifyGitHubOwnerRepoFromRemoteUrl('git@gitlab-work:team/orca.git')
    ).resolves.toEqual({ kind: 'not-github' })
  })
})

import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  runSafeServerGit,
  safeServerGitArgs,
  safeServerGitEnvironment,
  safeServerGitFailureStderr,
  safeServerGitTimeoutMs,
} from './safeServerGitRunner.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'safe-server-git-'));
  roots.push(root);
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  return root;
}

async function expectRejected(root: string): Promise<void> {
  await expect(runSafeServerGit({
    cwd: root,
    args: ['ls-remote', '--refs', 'https://127.0.0.1:1/org/repo.git', 'refs/heads/main'],
  })).resolves.toEqual({
    exitCode: 128, stdout: '', stderr: 'unsafe repository Git configuration is forbidden',
  });
}

describe('safe server Git runner', () => {
  it.each([
    ['http.sslVerify=false', '\n[http]\n\tsslVerify = false\n'],
    ['http.proxy', '\n[http]\n\tproxy = http://127.0.0.1:9\n'],
    ['http.extraHeader', '\n[http]\n\textraHeader = Authorization: attacker\n'],
    ['credential.helper', '\n[credential]\n\thelper = !echo attacker\n'],
    ['pushInsteadOf', '\n[url "https://evil.example/"]\n\tpushInsteadOf = https://github.com/\n'],
    ['include', '\n[include]\n\tpath = /tmp/attacker-git-config\n'],
    ['remote proxy', '\n[remote "origin"]\n\tproxy = http://127.0.0.1:9\n'],
    ['protocol', '\n[protocol "https"]\n\tallow = never\n'],
    ['unknown core key', '\n[core]\n\tgitProxy = attacker\n'],
  ])('rejects local %s before executing Git', async (_name, config) => {
    const root = repository();
    appendFileSync(join(root, '.git', 'config'), config);
    await expectRejected(root);
  });

  it('rejects configuration reached through a polluted worktree common-dir', async () => {
    const common = repository();
    appendFileSync(join(common, '.git', 'config'), '\n[http]\n\tsslVerify = false\n');
    const gitDir = join(common, '.git', 'worktrees', 'candidate');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, 'commondir'), '../..\n');
    const worktree = mkdtempSync(join(tmpdir(), 'safe-server-worktree-'));
    roots.push(worktree);
    writeFileSync(join(worktree, '.git'), `gitdir: ${gitDir}\n`);

    await expectRejected(worktree);
  });

  it('accepts only Git-init core structural configuration', async () => {
    const root = repository();
    await expect(runSafeServerGit({ cwd: root, args: ['status', '--porcelain=v1'] }))
      .resolves.toMatchObject({ exitCode: 0, stdout: '' });
  });

  it('preserves fixed commit dates for deterministic commit-tree retries', async () => {
    const root = repository();
    writeFileSync(join(root, 'content.txt'), 'deterministic\n');
    expect((await runSafeServerGit({ cwd: root, args: ['add', 'content.txt'] })).exitCode).toBe(0);
    const tree = (await runSafeServerGit({ cwd: root, args: ['write-tree'] })).stdout.trim();
    const env = {
      GIT_AUTHOR_DATE: '2026-08-20T15:52:39.314Z',
      GIT_COMMITTER_DATE: '2026-08-20T15:52:39.314Z',
    };
    const first = await runSafeServerGit({ cwd: root, args: ['commit-tree', tree, '-m', 'stable'], env });
    const second = await runSafeServerGit({ cwd: root, args: ['commit-tree', tree, '-m', 'stable'], env });
    expect(first.exitCode).toBe(0);
    expect(second.stdout).toBe(first.stdout);
    const dates = await runSafeServerGit({ cwd: root, args: ['show', '-s', '--format=%aI%n%cI', first.stdout.trim()] });
    expect(dates.stdout.trim().split('\n').map((value) => new Date(value).toISOString()))
      .toEqual(['2026-08-20T15:52:39.000Z', '2026-08-20T15:52:39.000Z']);
  });

  it('allows controlled fetches to complete without relaxing other Git command timeouts', () => {
    expect(safeServerGitTimeoutMs(['fetch', '--no-tags'])).toBe(120_000);
    expect(safeServerGitTimeoutMs(['status', '--porcelain=v1'])).toBe(30_000);
    expect(safeServerGitTimeoutMs(['push', '--porcelain'])).toBe(30_000);
  });

  it('preserves Git stderr while always identifying timeout termination', () => {
    expect(safeServerGitFailureStderr({ killed: true }, 'remote: partial progress\n', 120_000))
      .toBe('remote: partial progress\nGit command timed out after 120000ms');
    expect(safeServerGitFailureStderr({ killed: true }, '', 120_000))
      .toBe('Git command timed out after 120000ms');
  });

  it('pins network policy and does not depend on GIT_CONFIG_LOCAL', () => {
    const args = safeServerGitArgs(['status']).join(' ');
    expect(args).toContain('protocol.ext.allow=never');
    expect(args).toContain('core.fsmonitor=false');
    expect(args).toContain('core.quotePath=false');
    expect(args).toContain('http.sslVerify=true');
    expect(args).toContain('http.proxy=');
    expect(safeServerGitEnvironment()).toMatchObject({
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ALLOW_PROTOCOL: 'https',
    });
    expect(safeServerGitEnvironment()).not.toHaveProperty('GIT_CONFIG_LOCAL');
  });

  it.each([
    ['-c', ['status', '-c', 'http.sslVerify=false']],
    ['--config-env', ['--config-env=http.sslVerify=ATTACKER', 'status']],
    ['--exec-path', ['status', '--exec-path=/tmp/attacker']],
    ['--git-dir', ['--git-dir', '/tmp/attacker', 'status']],
    ['--work-tree', ['status', '--work-tree=/tmp/attacker']],
    ['--namespace', ['--namespace=attacker', 'status']],
  ])('rejects caller global option %s before spawning Git', (_option, args) => {
    expect(() => safeServerGitArgs(args)).toThrow(/unsafe Git global option is forbidden/);
  });

  it('black-box rejects a trailing -c that would otherwise override pinned TLS policy', async () => {
    const root = repository();
    await expect(runSafeServerGit({
      cwd: root,
      args: ['config', '--get', 'http.sslVerify', '-c', 'http.sslVerify=false'],
    })).rejects.toThrow('unsafe Git global option is forbidden: -c');
  });

  it('does not let caller env override or inject Git network/config policy', () => {
    const env = safeServerGitEnvironment({
      HOME: '/tmp/attacker',
      GIT_CONFIG_GLOBAL: '/tmp/attacker-config',
      GIT_CONFIG_LOCAL: '/tmp/attacker-local',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.sslVerify',
      GIT_CONFIG_VALUE_0: 'false',
      GIT_SSL_NO_VERIFY: '1',
      HTTPS_PROXY: 'http://127.0.0.1:9',
      GIT_ALLOW_PROTOCOL: 'file:https',
      GIT_ASKPASS: '/trusted/server/askpass',
      KY_GIT_PUSH_TOKEN: 'secret',
      GIT_AUTHOR_DATE: '2026-08-20T15:52:39.314Z',
      GIT_COMMITTER_DATE: '2026-08-20T15:52:39.314Z',
    });
    expect(env).toMatchObject({
      HOME: '/nonexistent/integration-v3-control-plane',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_ALLOW_PROTOCOL: 'https',
      GIT_ASKPASS: '/trusted/server/askpass',
      KY_GIT_PUSH_TOKEN: 'secret',
      GIT_AUTHOR_DATE: '2026-08-20T15:52:39.314Z',
      GIT_COMMITTER_DATE: '2026-08-20T15:52:39.314Z',
    });
    for (const key of ['GIT_CONFIG_LOCAL', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0',
      'GIT_SSL_NO_VERIFY', 'HTTPS_PROXY']) expect(env).not.toHaveProperty(key);
  });
});

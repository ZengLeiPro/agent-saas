import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runSafeServerGit, safeServerGitArgs, safeServerGitEnvironment } from './safeServerGitRunner.js';

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
    await expect(runSafeServerGit({ cwd: root, args: ['rev-parse', '--git-dir'] }))
      .resolves.toMatchObject({ exitCode: 0, stdout: '.git\n' });
  });

  it('pins network policy and does not depend on GIT_CONFIG_LOCAL', () => {
    const args = safeServerGitArgs(['status']).join(' ');
    expect(args).toContain('protocol.ext.allow=never');
    expect(args).toContain('core.fsmonitor=false');
    expect(args).toContain('http.sslVerify=true');
    expect(args).toContain('http.proxy=');
    expect(safeServerGitEnvironment()).toMatchObject({
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ALLOW_PROTOCOL: 'https',
    });
    expect(safeServerGitEnvironment()).not.toHaveProperty('GIT_CONFIG_LOCAL');
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
    });
    expect(env).toMatchObject({
      HOME: '/nonexistent/integration-v3-control-plane',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_ALLOW_PROTOCOL: 'https',
      GIT_ASKPASS: '/trusted/server/askpass',
      KY_GIT_PUSH_TOKEN: 'secret',
    });
    for (const key of ['GIT_CONFIG_LOCAL', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0',
      'GIT_SSL_NO_VERIFY', 'HTTPS_PROXY']) expect(env).not.toHaveProperty(key);
  });
});

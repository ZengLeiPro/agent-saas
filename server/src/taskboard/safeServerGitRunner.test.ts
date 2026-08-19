import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runSafeServerGit, safeServerGitArgs, safeServerGitEnvironment } from './safeServerGitRunner.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('safe server Git runner', () => {
  it('blocks repository pushInsteadOf before executing Git', async () => {
    const root = mkdtempSync(join(tmpdir(), 'safe-server-git-')); roots.push(root);
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    execFileSync('git', ['config', 'url.https://evil.example/.pushInsteadOf', 'https://github.com/'], { cwd: root });

    await expect(runSafeServerGit({ cwd: root, args: ['remote', 'get-url', '--push', 'origin'] }))
      .resolves.toMatchObject({ exitCode: 128, stderr: 'unsafe repository Git configuration is forbidden' });
  });

  it('pins hooks, helpers, fsmonitor and ext protocol and redirects host config scopes', () => {
    expect(safeServerGitArgs(['status']).join(' ')).toContain('protocol.ext.allow=never');
    expect(safeServerGitArgs(['status']).join(' ')).toContain('core.fsmonitor=false');
    expect(safeServerGitEnvironment()).toMatchObject({
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_LOCAL: '/dev/null',
    });
  });
});

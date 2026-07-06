import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureUserWorkspace, resolveUserCwd } from '../workspace/resolver.js';

describe('workspace scripts migration', () => {
  const previousChown = process.env.KY_AGENT_WORKSPACE_CHOWN;
  let tmpRoot: string;
  let agentCwd: string;
  let sharedDir: string;

  beforeEach(() => {
    process.env.KY_AGENT_WORKSPACE_CHOWN = '0';
    tmpRoot = mkdtempSync(join(tmpdir(), 'workspace-scripts-migration-'));
    agentCwd = join(tmpRoot, 'workspaces');
    sharedDir = join(tmpRoot, 'shared');
    mkdirSync(agentCwd, { recursive: true });
    mkdirSync(join(sharedDir, '.ky-agent', 'scripts', 'tools'), { recursive: true });
    writeFileSync(join(sharedDir, '.ky-agent', 'scripts', 'tools', 'hello.txt'), 'ok', 'utf-8');
  });

  afterEach(() => {
    if (previousChown === undefined) {
      delete process.env.KY_AGENT_WORKSPACE_CHOWN;
    } else {
      process.env.KY_AGENT_WORKSPACE_CHOWN = previousChown;
    }
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('replaces a legacy broken scripts symlink for existing workspaces', async () => {
    const user = { id: 'ky000000000004', username: 'legacy', role: 'user' as const, tenantId: 'kaiyan' };
    const userCwd = resolveUserCwd(agentCwd, user);
    mkdirSync(join(userCwd, '.ky-agent'), { recursive: true });
    symlinkSync(join(sharedDir, '.claude', 'scripts'), join(userCwd, '.ky-agent', 'scripts'), 'dir');

    await ensureUserWorkspace(userCwd, agentCwd, sharedDir, user);

    expect(lstatSync(join(userCwd, '.ky-agent', 'scripts')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(userCwd, '.ky-agent', 'scripts', 'tools', 'hello.txt'), 'utf-8')).toBe('ok');
  });
});

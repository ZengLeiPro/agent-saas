import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createTaskboardTrustedWorkspaceResolver } from './runtimeOptions.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const identity = {
  tenantId: 'tenant-1', ownerUserId: 'owner-1', username: 'owner', userRole: 'user' as const,
};

describe('createTaskboardTrustedWorkspaceResolver', () => {
  it('maps server-remote identity to the brain-local shared workspace and ignores remote hand paths', async () => {
    const agentCwd = await mkdtemp(join(tmpdir(), 'trusted-workspace-root-'));
    roots.push(agentCwd);
    const expected = join(agentCwd, identity.tenantId, identity.ownerUserId);
    await mkdir(expected, { recursive: true });
    const resolver = createTaskboardTrustedWorkspaceResolver(agentCwd);
    await expect(resolver(identity, {
      id: 'ws_tenant-1__owner-1', executionTarget: 'server-remote',
    })).resolves.toEqual({ id: 'ws_tenant-1__owner-1', root: expected });
    await expect(resolver(identity, {
      id: 'ws_tenant-1__other-user', executionTarget: 'server-remote',
    })).resolves.toBeUndefined();
  });

  it('fails closed when the bound local workspace root is a symlink', async () => {
    const agentCwd = await mkdtemp(join(tmpdir(), 'trusted-workspace-link-'));
    const outside = await mkdtemp(join(tmpdir(), 'trusted-workspace-outside-'));
    roots.push(agentCwd, outside);
    await mkdir(join(agentCwd, identity.tenantId), { recursive: true });
    await symlink(outside, join(agentCwd, identity.tenantId, identity.ownerUserId));
    const resolver = createTaskboardTrustedWorkspaceResolver(agentCwd);
    await expect(resolver(identity, {
      id: 'ws_tenant-1__owner-1', executionTarget: 'server-local',
    })).resolves.toBeUndefined();
  });
});

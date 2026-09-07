import { describe, expect, it } from 'vitest';
import { PlatformToolRuntime } from '../agent/toolRuntime.js';
import { MemoryHandStore } from './helpers/toolRuntimeHandStore.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import type { ChannelContext } from '../types/index.js';
const adminContext = {
  channel: 'web',
  user: { id: 'admin-1', username: 'admin', role: 'admin', tenantId: DEFAULT_TENANT_ID },
} as ChannelContext;
const workspace = (root: string) => ({
  root,
  userId: 'admin-1',
  username: 'admin',
  sessionId: 'session-1',
  executionTarget: 'server-local' as const,
});

describe('workspace readiness after registry upgrade', () => {
  it('reports duplicate ready registry entries as a conflict and ignores retired history', async () => {
    const common = {
      sessionId: 'session-1',
      workspaceId: 'workspace-tenant',
      type: 'server-remote' as const,
      status: 'ready' as const,
      capabilities: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      metadata: { tenantRemoteHandId: 'agent-saas-acs' },
    };
    const old = { ...common, handId: 'legacy' };
    const current = { ...common, handId: 'current' };
    for (const retired of [false, true]) {
      const handStore = new MemoryHandStore([
        { ...old, metadata: { ...old.metadata, ...(retired ? { supersededBy: 'current' } : {}) } },
        current,
      ]);
      const runtime = new PlatformToolRuntime({ handStore });
      const result = await runtime.invoke(
        {
          toolId: 'WaitForWorkspaceReady',
          input: { timeoutMs: 0 },
          authorization: { approved: true, source: 'policy_auto' },
        },
        {
          channelContext: adminContext,
          sessionId: 'session-1',
          workspace: workspace('/tmp/project'),
        },
      );
      expect(JSON.parse(result.content)).toMatchObject(
        retired ? { status: 'ready' } : { status: 'failed', message: 'RUNTIME_HAND_AMBIGUOUS' },
      );
    }
  });
});

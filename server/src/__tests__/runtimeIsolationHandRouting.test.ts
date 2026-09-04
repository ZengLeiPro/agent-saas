import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import { PlatformToolRuntime, type WorkspaceRef } from '../agent/toolRuntime.js';
import type { ExecutionTransport } from '../runtime/executionTransport.js';
import { DefaultExecutionTransportRegistry } from '../runtime/inProcessTransport.js';
import type { HandRecord, HandStore } from '../runtime/handStore.js';
import { RUNTIME_ISOLATION_POLICY_DIGEST } from '../runtime/runtimeIsolationEvidence.js';

const runId = 'run-attested';
const requirement = {
  tenantId: 'tenant-a', taskId: 'task-1', runId, sessionId: 'session-1',
  workspaceId: 'workspace-tenant', policyDigest: RUNTIME_ISOLATION_POLICY_DIGEST,
};
const baseHand = {
  sessionId: 'session-1', workspaceId: 'workspace-tenant', type: 'server-remote' as const,
  status: 'ready' as const, capabilities: [], createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};
const tenantHand: HandRecord = {
  ...baseHand, handId: 'session-1:tenant-legacy', endpoint: 'http://tenant.example',
  metadata: { tenantRemoteHandId: 'tenant-legacy' },
};
const attestedHand: HandRecord = {
  ...baseHand, handId: 'session-1:server-remote', endpoint: 'http://attested.example', runId,
  metadata: {
    registeredBy: 'rawRuntimeRunDispatch', runtimeIsolationAttested: true, runId,
    policyDigest: RUNTIME_ISOLATION_POLICY_DIGEST, sandboxName: 'as-session-1',
    sandboxScopeId: 'workspace-tenant::session-1',
  },
};
const workspace: WorkspaceRef = {
  id: 'workspace-tenant', root: '/tmp/project', sessionId: 'session-1',
  executionTarget: 'server-remote', sandboxPolicy: { denyRead: [] },
};
const context = {
  channelContext: { channel: 'web' as const }, sessionId: 'session-1', runId,
  runtimeIsolationRequirement: requirement, workspace,
};

function handStore(hands: HandRecord[]): HandStore {
  return {
    register: vi.fn(), updateStatus: vi.fn(), listByWorkspace: vi.fn(), listByTarget: vi.fn(),
    get: vi.fn(async id => hands.find(hand => hand.handId === id) ?? null),
    listBySession: vi.fn(async () => hands),
  } as unknown as HandStore;
}

function call() {
  return {
    toolId: 'Read', input: { path: 'hello.txt', handId: tenantHand.handId },
    authorization: { approved: true, source: 'policy_auto' as const },
  };
}

describe('attested runtime hand routing', () => {
  it('uses the exact attested default beside a sole ready tenant hand and ignores model handId', async () => {
    const invoke = vi.fn(async () => ({ status: 'success' as const, content: 'attested result' }));
    const transport: ExecutionTransport = { invoke, listInternalTools: () => [] };
    const registry = new DefaultExecutionTransportRegistry([['server-remote', transport]]);
    const runtime = new PlatformToolRuntime({ executionTransportRegistry: registry, handStore: handStore([tenantHand, attestedHand]) });

    await expect(runtime.invoke(call(), context)).resolves.toMatchObject({ content: 'attested result' });
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({ handId: attestedHand.handId }),
    }));
  });

  it('fails closed when the exact attested default is missing', async () => {
    const runtime = new PlatformToolRuntime({ handStore: handStore([tenantHand]) });
    await expect(runtime.invoke(call(), context)).rejects.toThrow('RUNTIME_ISOLATION_ATTESTED_HAND_MISSING');
  });

  it('carries the same isolation requirement through initial/wake and both resume dispatches', async () => {
    const source = await readFile(new URL('../runtime/rawRuntimeRunDispatch.ts', import.meta.url), 'utf8');
    expect(source.match(/handStore: config\.handStore, runtimeIsolationRequirement,/g)).toHaveLength(3);
    expect(source.match(/runtimeIsolationMetadata: run\.metadata/g)).toHaveLength(3);
    expect(source.match(/automationFence: automationFenceFromMetadata\(request\.runtimeIsolationMetadata\)!/g)).toHaveLength(2);
    for (const name of ['createRawRuntimeRunDispatch', 'createRawApprovalResumeDispatch', 'createRawInteractionResumeDispatch']) {
      const start = source.indexOf(`function ${name}`);
      const end = source.indexOf('\nexport function ', start + 1);
      const body = source.slice(start, end < 0 ? undefined : end);
      expect(body).toContain('runtimeIsolationRequirement,');
      expect(body).toContain('ensureRuntimeHandRegistered({');
      if (name !== 'createRawRuntimeRunDispatch') {
        expect(body).toContain('automationFenceFromMetadata(request.runtimeIsolationMetadata)');
      }
    }
  });
});

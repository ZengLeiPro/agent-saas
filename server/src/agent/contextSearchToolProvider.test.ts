import { describe, expect, it, vi } from 'vitest';

import type {
  ContextRecallHit,
  ContextRecallResolvedScope,
  ContextRecallScopeResolver,
  ContextRecallService,
} from '../context/retrieval/index.js';
import {
  ContextSearchToolProvider,
  contextGetToolDescriptor,
  contextSearchToolDescriptor,
} from './contextSearchToolProvider.js';
import type { AuthorizedToolCall, ToolCallContext } from './toolRuntime.js';

const scopeV1: ContextRecallResolvedScope = {
  collections: [{ collectionId: 'collection-a', assignmentVersion: 7, resourceType: 'org_knowledge' }],
  resolvedAt: '2026-08-22T12:00:00.000Z',
  degraded: false,
  degradationReasons: [],
};

function makeContext(): ToolCallContext {
  return {
    channelContext: {
      channel: 'web',
      user: { id: 'actor-admin', username: 'admin', role: 'admin', tenantId: 'tenant-a' },
      sessionOwner: { id: 'user-a', username: 'owner', role: 'user', tenantId: 'tenant-a' },
    },
    workspace: {
      id: 'workspace-a',
      root: '/tmp/workspace-a',
      userId: 'user-a',
      tenantId: 'tenant-a',
      sessionId: 'session-a',
      executionTarget: 'server-local',
    },
    sessionId: 'session-a',
    orgAgentId: 'agent-a',
  } as ToolCallContext;
}

function makeCall<T>(toolId: string, input: T): AuthorizedToolCall<T> {
  return { toolId, input, authorization: { approved: true, source: 'policy_auto' } };
}

function makeHit(overrides: Partial<ContextRecallHit> = {}): ContextRecallHit {
  return {
    id: 'hit-a',
    collectionId: 'collection-a',
    assignmentVersion: 7,
    kind: 'derived_fact',
    content: 'The launch date is September 1.',
    score: 0.91,
    source: { sourceId: 'wiki', kind: 'wiki', displayName: 'Launch plan', url: 'https://example.test/wiki/1' },
    time: { occurredAt: '2026-08-20T09:00:00Z', observedAt: '2026-08-22T11:00:00Z' },
    freshness: { status: 'stale', asOf: '2026-08-22T11:00:00Z', reason: 'sync_lag' },
    route: { strategy: 'hybrid', stages: ['fts', 'rerank'] },
    derived: true,
    evidence: [{
      evidenceId: 'ev-a',
      sourceId: 'wiki',
      collectionId: 'collection-a',
      recordId: 'record-a',
      revision: 3,
      kind: 'quote',
      excerpt: 'Launch is planned for September 1.',
    }],
    ...overrides,
  };
}

function makeHarness(scope: ContextRecallResolvedScope = scopeV1) {
  const recall: ContextRecallService = {
    search: vi.fn(async () => ({ hits: [], degraded: false, degradationReasons: [] })),
    get: vi.fn(async () => ({ hit: null, degraded: false, degradationReasons: [] })),
  };
  const scopes: ContextRecallScopeResolver = {
    resolve: vi.fn(async () => scope),
  };
  return { recall, scopes, provider: new ContextSearchToolProvider(recall, scopes) };
}

describe('ContextSearchToolProvider', () => {
  it('rejects tenantId/userId injection and never calls server ports', async () => {
    const { provider, recall, scopes } = makeHarness();
    expect(Object.keys(contextSearchToolDescriptor.schema.shape)).not.toContain('tenantId');
    expect(Object.keys(contextSearchToolDescriptor.schema.shape)).not.toContain('userId');
    expect(Object.keys(contextGetToolDescriptor.schema.shape)).not.toContain('tenantId');

    await expect(provider.invoke(makeCall('ContextSearch', {
      query: 'secret', tenantId: 'tenant-b', userId: 'user-b',
    }), makeContext())).rejects.toThrow();
    expect(scopes.resolve).not.toHaveBeenCalled();
    expect(recall.search).not.toHaveBeenCalled();
  });

  it('derives subject from authenticated owner/workspace/session/orgAgent context', async () => {
    const { provider, recall, scopes } = makeHarness();
    await provider.invoke(makeCall('ContextSearch', { query: 'launch' }), makeContext());

    expect(scopes.resolve).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      userId: 'user-a',
      workspaceId: 'workspace-a',
      sessionId: 'session-a',
      orgAgentId: 'agent-a',
    }, { operation: 'search' });
    expect(recall.search).toHaveBeenCalledWith(expect.objectContaining({
      subject: expect.objectContaining({ tenantId: 'tenant-a', userId: 'user-a' }),
      limit: 10,
    }));
  });

  it('fails closed on an empty authorized collection scope', async () => {
    const { provider, recall } = makeHarness({
      collections: [], resolvedAt: '2026-08-22T12:00:00.000Z', degraded: false,
    });
    await expect(provider.invoke(makeCall('ContextSearch', { query: 'anything' }), makeContext()))
      .rejects.toMatchObject({ code: 'CONTEXT_RECALL_EMPTY_SCOPE' });
    expect(recall.search).not.toHaveBeenCalled();
  });

  it('ContextGet freshly reauthorizes and blocks a hit from an old assignment version', async () => {
    const recall: ContextRecallService = {
      search: vi.fn(async () => ({ hits: [makeHit()], degraded: false })),
      get: vi.fn(async () => ({ hit: makeHit(), degraded: false })),
    };
    const scopes: ContextRecallScopeResolver = {
      resolve: vi.fn()
        .mockResolvedValueOnce(scopeV1)
        .mockResolvedValueOnce({
          collections: [{ collectionId: 'collection-a', assignmentVersion: 8 }],
          resolvedAt: '2026-08-22T12:01:00.000Z',
          degraded: false,
        }),
    };
    const provider = new ContextSearchToolProvider(recall, scopes);

    await provider.invoke(makeCall('ContextSearch', { query: 'launch' }), makeContext());
    await expect(provider.invoke(makeCall('ContextGet', { id: 'hit-a' }), makeContext()))
      .rejects.toMatchObject({ code: 'CONTEXT_RECALL_HIT_OUT_OF_SCOPE' });
    expect(scopes.resolve).toHaveBeenNthCalledWith(2, expect.anything(), { operation: 'get', recallId: 'hit-a' });
  });

  it('marks derived facts/evidence and explicitly reports degraded retrieval', async () => {
    const { provider, recall } = makeHarness({
      ...scopeV1,
      degraded: true,
      degradationReasons: ['assignment_snapshot_stale'],
    });
    vi.mocked(recall.search).mockResolvedValue({
      hits: [makeHit()],
      degraded: true,
      degradationReasons: ['reranker_unavailable'],
    });

    const result = await provider.invoke(makeCall('ContextSearch', { query: 'launch date' }), makeContext());
    const output = JSON.parse(result!.content) as Record<string, unknown>;
    expect(output).toMatchObject({
      degraded: true,
      degradationReasons: ['assignment_snapshot_stale', 'reranker_unavailable'],
      hits: [{
        citationMarker: '[CITE]{"contextId":"hit-a","label":"Launch plan"}[/CITE]',
        source: { sourceId: 'wiki' },
        time: { occurredAt: '2026-08-20T09:00:00Z' },
        freshness: { status: 'stale' },
        route: { strategy: 'hybrid' },
        derived: true,
        evidence: [{ evidenceId: 'ev-a', recordId: 'record-a' }],
      }],
    });
  });

  it('validates limits/time ranges/filter arrays and forwards normalized filters', async () => {
    const { provider, recall } = makeHarness();
    await expect(provider.invoke(makeCall('ContextSearch', { query: 'x', limit: 51 }), makeContext())).rejects.toThrow();
    await expect(provider.invoke(makeCall('ContextSearch', {
      query: 'x', timeRange: { from: '2026-08-22T12:00:00Z', to: '2026-08-21T12:00:00Z' },
    }), makeContext())).rejects.toThrow();
    await expect(provider.invoke(makeCall('ContextSearch', { query: 'x', kinds: ['wiki', 'wiki'] }), makeContext())).rejects.toThrow();

    await provider.invoke(makeCall('ContextSearch', {
      query: '  launch  ',
      limit: 3,
      timeRange: { from: '2026-08-20T00:00:00Z', to: '2026-08-23T00:00:00Z' },
      kinds: ['wiki_document'],
      sources: ['wiki'],
    }), makeContext());
    expect(recall.search).toHaveBeenLastCalledWith(expect.objectContaining({
      query: 'launch',
      limit: 3,
      filters: {
        timeRange: { from: '2026-08-20T00:00:00Z', to: '2026-08-23T00:00:00Z' },
        kinds: ['wiki_document'],
        sources: ['wiki'],
      },
    }));
  });
});

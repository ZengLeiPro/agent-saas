import express from 'express';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ContextRecallScopeDriftError,
  type ContextRecallHit,
  type ContextRecallScopeResolver,
  type ContextRecallService,
} from '../context/retrieval/index.js';
import { createContextCitationsRouter } from '../routes/contextCitations.js';
import type { SessionCatalog } from '../runtime/sessionCatalog.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const USER = { sub: 'user-a', username: 'alice', role: 'user', tenantId: 'tenant-a' } as const;

function hit(): ContextRecallHit {
  return {
    id: 'opaque-hit',
    collectionId: 'collection-a',
    assignmentVersion: 7,
    kind: 'chat_message',
    content: '客户确认 9 月 1 日上线。',
    source: { sourceId: 'dws-a', kind: 'dws', displayName: '钉钉聊天', url: 'https://example.test/native' },
    time: { occurredAt: '2026-08-22T12:00:00.000Z' },
    freshness: { status: 'fresh', asOf: '2026-08-22T12:01:00.000Z' },
    route: { strategy: 'exact' },
    derived: false,
    evidence: [{
      evidenceId: 'evidence-a', sourceId: 'dws-a', collectionId: 'collection-a',
      recordId: 'record-secret', revision: 3, kind: 'source_locator', excerpt: '客户确认上线。',
      url: 'javascript:alert(1)',
    }],
  };
}

async function listen(options: {
  ownerId?: string;
  sessionTenantId?: string;
  recall?: ContextRecallService;
  scopes?: ContextRecallScopeResolver;
  withDependencies?: boolean;
} = {}): Promise<{ server: Server; baseUrl: string }> {
  const sessionCatalog: Pick<SessionCatalog, 'get'> = {
    get: vi.fn(async () => ({
      sessionId: SESSION_ID,
      userId: options.ownerId ?? USER.sub,
      username: 'alice',
      tenantId: options.sessionTenantId ?? USER.tenantId,
      orgAgentId: 'agent-a',
      channel: 'web', cwd: '/workspace', transcriptPath: '/workspace/session.jsonl',
      createdAt: '2026-08-22T12:00:00.000Z', updatedAt: '2026-08-22T12:00:00.000Z',
    })),
  };
  const scopes = options.scopes ?? {
    resolve: vi.fn(async () => ({
      collections: [{ collectionId: 'collection-a', assignmentVersion: 7, resourceType: 'org_knowledge' as const }],
      resolvedAt: '2026-08-22T12:01:00.000Z', degraded: false, degradationReasons: [],
    })),
  };
  const recall = options.recall ?? {
    search: vi.fn(),
    get: vi.fn(async () => ({ hit: hit(), degraded: false, degradationReasons: [] })),
  };
  const app = express();
  app.use((req, _res, next) => { req.user = USER; next(); });
  app.use('/api', createContextCitationsRouter(options.withDependencies === false
    ? {}
    : { sessionCatalog, recall, scopes }));
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

describe('Context citations route', () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;
  });

  it('reauthorizes the owner session and returns a redacted evidence DTO', async () => {
    const scopes: ContextRecallScopeResolver = { resolve: vi.fn(async () => ({
      collections: [{ collectionId: 'collection-a', assignmentVersion: 7 }],
      resolvedAt: '2026-08-22T12:01:00.000Z', degraded: false,
    })) };
    const opened = await listen({ scopes }); server = opened.server;
    const response = await fetch(`${opened.baseUrl}/api/sessions/${SESSION_ID}/context-citations/opaque-hit`);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      citation: { id: string; content: string; evidence: Array<Record<string, unknown>> };
    };
    expect(scopes.resolve).toHaveBeenCalledWith({
      tenantId: 'tenant-a', userId: 'user-a', sessionId: SESSION_ID, orgAgentId: 'agent-a',
    }, { operation: 'get', recallId: 'opaque-hit' });
    expect(body.citation).toMatchObject({ id: 'opaque-hit', content: '客户确认 9 月 1 日上线。' });
    expect(body.citation.evidence[0]).not.toHaveProperty('recordId');
    expect(body.citation.evidence[0]).not.toHaveProperty('url');
  });

  it('does not allow admins or users to enumerate another owner session', async () => {
    const scopes = { resolve: vi.fn() };
    const opened = await listen({ ownerId: 'user-b', scopes: scopes as never }); server = opened.server;
    const response = await fetch(`${opened.baseUrl}/api/sessions/${SESSION_ID}/context-citations/opaque-hit`);
    expect(response.status).toBe(404);
    expect(scopes.resolve).not.toHaveBeenCalled();
  });

  it('fails closed when the session tenant does not match the current user', async () => {
    const scopes = { resolve: vi.fn() };
    const opened = await listen({ sessionTenantId: 'tenant-b', scopes: scopes as never }); server = opened.server;
    const response = await fetch(`${opened.baseUrl}/api/sessions/${SESSION_ID}/context-citations/opaque-hit`);
    expect(response.status).toBe(404);
    expect(scopes.resolve).not.toHaveBeenCalled();
  });

  it('reports assignment pin drift without returning stale evidence', async () => {
    const opened = await listen({ scopes: {
      resolve: vi.fn(async () => { throw new ContextRecallScopeDriftError('CONTEXT_RECALL_ASSIGNMENT_PIN_DRIFT'); }),
    } }); server = opened.server;
    const response = await fetch(`${opened.baseUrl}/api/sessions/${SESSION_ID}/context-citations/opaque-hit`);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'CONTEXT_CITATION_ASSIGNMENT_DRIFT' });
  });

  it('fails closed for a tampered hit id and unavailable runtime', async () => {
    const recall: ContextRecallService = {
      search: vi.fn(), get: vi.fn(async () => ({ hit: null, degraded: false })),
    };
    const opened = await listen({ recall }); server = opened.server;
    const missing = await fetch(`${opened.baseUrl}/api/sessions/${SESSION_ID}/context-citations/tampered`);
    expect(missing.status).toBe(404);
    await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined;

    const unavailable = await listen({ withDependencies: false }); server = unavailable.server;
    const response = await fetch(`${unavailable.baseUrl}/api/sessions/${SESSION_ID}/context-citations/opaque-hit`);
    expect(response.status).toBe(503);
  });
});

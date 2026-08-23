import { Buffer } from 'node:buffer';

import { describe, expect, it, vi } from 'vitest';

import { PgContextRecallService } from './postgresContextRecallService.js';
import {
  AssignmentContextRecallScopeResolver,
  ContextRecallScopeDriftError,
} from './assignmentScopeResolver.js';
import type { ContextRecallResolvedScope } from './types.js';

const scope: ContextRecallResolvedScope = {
  collections: [{ collectionId: 'collection-a', assignmentVersion: 7, resourceType: 'org_knowledge' }],
  resolvedAt: '2026-08-22T00:00:00.000Z',
};
const subject = { tenantId: 'tenant-a', userId: 'user-a', sessionId: 'session-a' };

function hitRow(overrides: Record<string, unknown> = {}) {
  return {
    tenant_id: 'tenant-a', source_id: 'source-a', collection_id: 'collection-a', record_id: 'record-a',
    current_revision: 2, content_json: { text: 'Quarterly plan' }, metadata_json: { kind: 'document', url: 'https://example.test/doc' },
    source_updated_at: '2026-08-22T01:00:00.000Z', observed_at: '2026-08-22T01:01:00.000Z',
    source_kind: 'dws', source_display_name: 'DWS', record_kind: 'document', sync_degraded: false,
    sync_as_of: '2026-08-22T01:02:00.000Z', route_rank: 1,
    evidence_items: [{ evidenceId: 'ev-1', kind: 'source_locator', data: { excerpt: 'Quarterly plan', url: 'https://example.test/doc' } }],
    ...overrides,
  };
}

describe('PgContextRecallService', () => {
  it('uses tenant/scope SQL exact + ILIKE + time filters and returns evidence/freshness/degradation', async () => {
    const query = vi.fn(async (sql: string, _params?: unknown[]) => sql.includes('BOOL_OR(refused OR status')
      ? { rows: [{ refused: false, truncated: true, retry_wait: false }] }
      : { rows: [hitRow()] });
    const service = new PgContextRecallService({ pool: { query } as never, tablePrefix: 'test' });

    const result = await service.search({
      subject,
      scope,
      query: 'Quarterly plan',
      limit: 5,
      filters: {
        timeRange: { from: '2026-08-01T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z' },
        kinds: ['document'],
        sources: ['source-a'],
      },
    });

    expect(query.mock.calls[0]![0]).toContain('r.record_id=$3 OR r.external_record_id=$3');
    expect(query.mock.calls[0]![0]).toContain('ILIKE $4');
    expect(query.mock.calls[0]![0]).toContain('COALESCE(r.source_updated_at,r.observed_at) >= $7');
    expect(query.mock.calls[0]![0]).toContain('LEFT JOIN test_agent_dws_accounts a');
    expect(query.mock.calls[0]![0]).toContain("a.event_policy_json #> '{contextPolicy}'");
    expect(query.mock.calls[0]![0]).toContain("s.kind<>'dws' OR a.status='active'");
    expect(query.mock.calls[0]![0]).toContain("CASE c.external_key");
    expect(query.mock.calls[0]![0]).toContain("{historical,lookbackDays}");
    expect(query.mock.calls[0]![0]).toContain("{realtimeEffectiveAt,all}");
    expect(query.mock.calls[0]![0]).toContain("{wiki,enabled}");
    expect(query.mock.calls[0]![0]).toContain("{minutes,lookbackDays}");
    expect(query.mock.calls[0]![1]).toEqual([
      'tenant-a', ['collection-a'], 'Quarterly plan', '%Quarterly plan%', ['document'], ['source-a'],
      '2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 5,
    ]);
    expect(result).toMatchObject({
      degraded: true,
      degradationReasons: ['context_sync_truncated'],
      hits: [{
        collectionId: 'collection-a', assignmentVersion: 7, kind: 'document',
        freshness: { status: 'fresh' },
        route: { strategy: 'postgres_exact_ilike' },
        evidence: [{ evidenceId: 'ev-1', excerpt: 'Quarterly plan' }],
      }],
    });

    await expect(service.get({ subject, scope, id: result.hits[0]!.id })).resolves.toMatchObject({
      hit: { collectionId: 'collection-a' },
    });
    expect(query.mock.calls[2]![0]).toContain("{historical,mode}");
    expect(query.mock.calls[2]![0]).toContain("{realtime,conversationIds}");
    expect(query.mock.calls[2]![0]).toContain('v.revision=$5');
    expect(query.mock.calls[2]![0]).toContain('r.deleted=FALSE AND r.revoked=FALSE');
    expect(query.mock.calls[2]![0]).toContain('e.revision=v.revision');
  });

  it('treats opaque ids as routing only and returns null outside the freshly authorized scope', async () => {
    const query = vi.fn(async () => ({ rows: [hitRow()] }));
    const service = new PgContextRecallService({ pool: { query } as never, tablePrefix: 'test' });
    const search = await service.search({ subject, scope, query: 'plan', limit: 1, filters: {} });
    const id = search.hits[0]!.id;
    const parts = id.split('.');
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
    payload.v = 1;
    const tamperedId = `ctx1.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${parts[2]}`;
    await expect(service.get({ subject, scope, id: tamperedId }))
      .resolves.toEqual({ hit: null, degraded: false });

    const denied = await service.get({
      subject,
      id,
      scope: { ...scope, collections: [{ collectionId: 'other', assignmentVersion: 1 }] },
    });
    expect(denied).toEqual({ hit: null, degraded: false });
    expect(query).toHaveBeenCalledTimes(2); // search + scope health; denied get performs no SQL
  });
});

describe('AssignmentContextRecallScopeResolver', () => {
  it('delegates deny-overrides-allow to fresh org_knowledge assignment resolution and accepts the exact pin', async () => {
    const listEffectiveResourceIds = vi.fn(async () => [{ resourceId: 'collection-a', assignmentVersion: 7 }]);
    const resolver = new AssignmentContextRecallScopeResolver({ listEffectiveResourceIds }, {
      now: () => new Date('2026-08-22T00:00:00.000Z'),
      resolveSessionPin: async () => ({
        tenantId: 'tenant-a', userId: 'user-a', orgAgentId: 'agent-a',
        collectionAssignments: scope.collections,
      }),
    });
    await expect(resolver.resolve(subject, { operation: 'search' })).resolves.toMatchObject({ collections: scope.collections });
    expect(listEffectiveResourceIds).toHaveBeenCalledWith('tenant-a', 'user-a', 'org_knowledge', 'agent-a');
  });

  it('fails the entire query when a pinned assignment version drifts', async () => {
    const resolver = new AssignmentContextRecallScopeResolver({
      listEffectiveResourceIds: async () => [{ resourceId: 'collection-a', assignmentVersion: 8 }],
    }, {
      resolveSessionPin: async () => ({
        tenantId: 'tenant-a', userId: 'user-a', orgAgentId: 'agent-a', collectionAssignments: scope.collections,
      }),
    });
    await expect(resolver.resolve(subject, { operation: 'get' })).rejects.toMatchObject({
      code: 'CONTEXT_RECALL_ASSIGNMENT_PIN_DRIFT',
    } satisfies Partial<ContextRecallScopeDriftError>);
  });

  it('keeps pre-pin sessions compatible while still using only fresh assignments', async () => {
    const resolver = new AssignmentContextRecallScopeResolver({
      listEffectiveResourceIds: async () => [{ resourceId: 'collection-current', assignmentVersion: 3 }],
    }, {
      resolveSessionPin: async () => ({ tenantId: 'tenant-a', userId: 'user-a', orgAgentId: 'agent-a' }),
    });
    await expect(resolver.resolve(subject, { operation: 'search' })).resolves.toMatchObject({
      collections: [{ collectionId: 'collection-current', assignmentVersion: 3 }],
    });
  });
});

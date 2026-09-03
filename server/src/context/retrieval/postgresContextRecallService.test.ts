import { Buffer } from 'node:buffer';

import { describe, expect, it, vi } from 'vitest';

import { PgContextRecallService } from './postgresContextRecallService.js';
import { ContextSourceAuthorizationRegistry } from './sourceAuthorization.js';
import {
  AssignmentContextRecallScopeResolver,
  ContextRecallScopeDriftError,
} from './assignmentScopeResolver.js';
import type { ContextRecallResolvedScope, ContextRecallSubject } from './types.js';

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
    expect(query.mock.calls[0]![0]).toContain('COALESCE(r.occurred_at,r.source_updated_at,r.observed_at) >= $7');
    expect(query.mock.calls[0]![0]).toContain('LOWER(NORMALIZE(r.collection_id, NFKC))=ANY($6::text[])');
    expect(query.mock.calls[0]![0]).toContain("LOWER(NORMALIZE(COALESCE(r.entity_type,''), NFKC))=ANY($5::text[])");
    expect(query.mock.calls[0]![0]).toContain('LEFT JOIN test_agent_dws_accounts a');
    expect(query.mock.calls[0]![0]).toContain("a.event_policy_json #> '{contextPolicy}'");
    expect(query.mock.calls[0]![0]).toContain("a.profile_id=a.corp_id||':'||a.dingtalk_user_id");
    expect(query.mock.calls[0]![0]).toContain("a.profile_id=s.config_json->>'profileId'");
    expect(query.mock.calls[0]![0]).toContain("auth_partition.refused=TRUE OR auth_partition.status='refused'");
    expect(query.mock.calls[0]![0]).toContain("i.review_status='confirmed'");
    expect(query.mock.calls[0]![0]).toContain("i.valid_from<=NOW()");
    expect(query.mock.calls[0]![0]).toContain("i.owner_principal=$10");
    expect(query.mock.calls[0]![0]).toContain("'conflictStatus',i.conflict_status");
    expect(query.mock.calls[0]![0]).toContain("'evidenceId',ie.evidence_id");
    expect(query.mock.calls[0]![0]).toContain("other.record_revision<>r.current_revision");
    expect(query.mock.calls[0]![0]).toContain("CASE c.external_key");
    expect(query.mock.calls[0]![0]).toContain("{historical,lookbackDays}");
    expect(query.mock.calls[0]![0]).toContain("{realtimeEffectiveAt,all}");
    expect(query.mock.calls[0]![0]).toContain("{wiki,enabled}");
    expect(query.mock.calls[0]![0]).toContain("{minutes,lookbackDays}");
    expect(query.mock.calls[0]![1]).toEqual([
      'tenant-a', ['collection-a'], 'Quarterly plan', '%Quarterly plan%', ['document'], ['source-a'],
      '2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 201, 'user-a', null, null,
    ]);
    expect(result).toMatchObject({
      degraded: true,
      degradationReasons: ['context_sync_truncated'],
      hits: [{
        collectionId: 'collection-a', assignmentVersion: 7, kind: 'document', recordKind: 'document',
        freshness: { status: 'fresh' },
        route: { strategy: 'postgres_exact_ilike_derived' },
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
    expect(query.mock.calls[2]![0]).toContain('r.owner_principal,r.acl_principals');
    expect(query.mock.calls[2]![0]).toContain('e.revision=v.revision');
  });

  it('pins group-channel source and conversation filters into SQL instead of filtering only after retrieval', async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [hitRow()] }));
    const service = new PgContextRecallService({ pool: { query } as never, tablePrefix: 'test' });
    const channelSubject: ContextRecallSubject = { ...subject, channelScope: {
      bindingId: 'binding-a', conversationSpaceId: 'space-a',
      workConversationId: 'work-conversation-a', conversationId: 'group-a', policyRevision: 5,
      allowedSourceIds: ['source-a'] } };

    await service.search({ subject: channelSubject, scope, query: 'Quarterly plan', limit: 5, filters: {} });

    expect(query.mock.calls[0]![0]).toContain('r.source_id=ANY($11::text[])');
    expect(query.mock.calls[0]![0]).toContain("r.metadata_json->>'conversationId'");
    expect(query.mock.calls[0]![1]?.slice(-2)).toEqual([['source-a'], 'group-a']);
  });

  it('adds only confirmed evidence-bound derived context to an already authorized source hit', async () => {
    const query = vi.fn(async (sql: string, _params?: readonly unknown[]) => sql.includes('BOOL_OR(refused OR status')
      ? { rows: [{ refused: false, truncated: false, retry_wait: false }] }
      : { rows: [hitRow({
          route_rank: 3,
          derived_items: [{ itemId: 'item-a', itemType: 'Status', semanticKey: 'status', value: { code: 'blocked' },
            authority: 'informational', conflictStatus: 'open',
            evidence: { sourceId: 'source-a', collectionId: 'collection-a', recordId: 'record-a', recordRevision: 2, evidenceId: 'ev-1' } }],
        })] });
    const service = new PgContextRecallService({ pool: { query } as never, tablePrefix: 'test' });
    const result = await service.search({ subject, scope, query: 'blocked', limit: 5, filters: {} });
    expect(result.hits[0]).toMatchObject({ derived: true, route: { stages: ['derived'] } });
    expect(result.hits[0]?.content).toContain('[已确认派生上下文');
    expect(result.hits[0]?.content).toContain('"code":"blocked"');
    expect(result.hits[0]?.content).toContain('"conflictStatus":"open"');
    expect(result.hits[0]?.content).toContain('"evidenceId":"ev-1"');
  });

  it('batch-authorizes taskboard candidates and never returns native-denied content', async () => {
    const taskRows = [
      hitRow({ source_kind: 'taskboard', record_id: 'allowed', metadata_json: { kind: 'board', boardId: 'board-a' } }),
      hitRow({ source_kind: 'taskboard', record_id: 'denied', metadata_json: { kind: 'board', boardId: 'board-b' } }),
    ];
    const query = vi.fn(async (sql: string, _params?: readonly unknown[]) => sql.includes('BOOL_OR(refused OR status')
      ? { rows: [{ refused: false, truncated: false, retry_wait: false }] }
      : { rows: taskRows });
    const registry = new ContextSourceAuthorizationRegistry({
      taskboard: { authorizeBatch: vi.fn(async (_subject, locators: readonly { recordId: string }[]) => locators.map(value => value.recordId === 'allowed')) },
    });
    const service = new PgContextRecallService({ pool: { query } as never, tablePrefix: 'test', sourceAuthorizationRegistry: registry });
    const result = await service.search({ subject, scope, query: 'task', limit: 5, filters: {} });
    expect(result).toMatchObject({ degraded: false, hits: [{ content: JSON.stringify({ text: 'Quarterly plan' }) }] });
    expect(result.hits).toHaveLength(1);
    expect(query.mock.calls[0]![0]).toContain("WHEN s.kind<>'dws' THEN TRUE");
  });

  it('accepts Collection IDs and entity types as canonical filters and exposes storage kind separately', async () => {
    const row = hitRow({
      source_kind: 'taskboard', source_id: 'taskboard', collection_id: 'taskboard-projects',
      entity_type: 'project', record_kind: 'snapshot', metadata_json: { boardId: 'board-a' },
    });
    const query = vi.fn(async (sql: string, _params?: readonly unknown[]) => sql.includes('BOOL_OR(refused OR status')
      ? { rows: [{ refused: false, truncated: false, retry_wait: false }] }
      : { rows: [row] });
    const registry = new ContextSourceAuthorizationRegistry({
      taskboard: { authorizeBatch: vi.fn(async (_subject, locators: readonly unknown[]) => locators.map(() => true)) },
    });
    const service = new PgContextRecallService({ pool: { query } as never, tablePrefix: 'test', sourceAuthorizationRegistry: registry });
    const result = await service.search({
      subject,
      scope: { ...scope, collections: [{ collectionId: 'taskboard-projects', assignmentVersion: 2 }] },
      query: '开沿 Agent 需求', limit: 3,
      filters: { kinds: [' Project '], sources: ['TASKBOARD-PROJECTS'] },
    });

    expect(query.mock.calls[0]![1]).toEqual(expect.arrayContaining([['project'], ['taskboard-projects']]));
    expect(result).toMatchObject({
      hits: [{ kind: 'snapshot', recordKind: 'snapshot', entityType: 'Project', collectionId: 'taskboard-projects' }],
      diagnostics: { normalizedFilters: { kinds: ['project'], sources: ['taskboard-projects'] } },
    });
  });

  it('overfetches before live ACL so denied early candidates do not starve visible hits', async () => {
    const rows = Array.from({ length: 152 }, (_, index) => hitRow({
      source_kind: 'taskboard', record_id: index < 150 ? `denied-${index}` : `allowed-${index}`,
      metadata_json: { taskId: `task-${index}` },
    }));
    const query = vi.fn(async (sql: string, _params?: readonly unknown[]) => sql.includes('BOOL_OR(refused OR status')
      ? { rows: [{ refused: false, truncated: false, retry_wait: false }] }
      : { rows });
    const registry = new ContextSourceAuthorizationRegistry({
      taskboard: { authorizeBatch: vi.fn(async (_subject, locators: readonly { recordId: string }[]) =>
        locators.map(locator => locator.recordId.startsWith('allowed-'))) },
    });
    const service = new PgContextRecallService({ pool: { query } as never, tablePrefix: 'test', sourceAuthorizationRegistry: registry });
    const result = await service.search({ subject, scope, query: 'task', limit: 2, filters: {} });

    expect(result.hits).toHaveLength(2);
    expect(result).toMatchObject({ degraded: false,
      diagnostics: { normalizedFilters: { kinds: [], sources: [] } } });
    expect(result.diagnostics).not.toHaveProperty('deniedCandidates');
    expect(query.mock.calls[0]![1]![8]).toBe(201);
  });

  it('fails closed with a non-sensitive degraded reason when a taskboard authorizer is absent or throws', async () => {
    const row = hitRow({ source_kind: 'taskboard', metadata_json: { kind: 'task', taskId: 'task-a' } });
    const query = vi.fn(async (sql: string, _params?: readonly unknown[]) => sql.includes('BOOL_OR(refused OR status')
      ? { rows: [{ refused: false, truncated: false, retry_wait: false }] }
      : { rows: [row] });
    const missing = new PgContextRecallService({ pool: { query } as never, tablePrefix: 'test' });
    await expect(missing.search({ subject, scope, query: 'secret', limit: 5, filters: {} })).resolves.toMatchObject({
      hits: [], degraded: true, degradationReasons: ['context_source_authorizer_missing'],
      diagnostics: { normalizedFilters: { kinds: [], sources: [] } },
    });

    const broken = new PgContextRecallService({
      pool: { query } as never, tablePrefix: 'test',
      sourceAuthorizationRegistry: new ContextSourceAuthorizationRegistry({
        taskboard: { authorizeBatch: async () => { throw new Error('unavailable'); } },
      }),
    });
    const result = await broken.search({ subject, scope, query: 'secret', limit: 5, filters: {} });
    expect(result).toMatchObject({ hits: [], degraded: true, degradationReasons: ['context_source_authorization_error'],
      diagnostics: { normalizedFilters: { kinds: [], sources: [] } } });
    expect(JSON.stringify(result)).not.toContain('Quarterly plan');
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

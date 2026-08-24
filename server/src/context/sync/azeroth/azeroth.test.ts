import { describe, expect, it, vi } from 'vitest';

import type { ContextSyncPartition } from '../../store/index.js';
import { normalizeAzerothRecord, shouldIngestAzerothRow } from './normalizer.js';
import {
  AzerothAuthorizationError,
  type AzerothContextStorePort,
  type AzerothHttpClient,
  type AzerothServerBinding,
} from './types.js';
import { ConfigAzerothContextPorts } from './runtimePorts.js';
import { AzerothInventoryWorker } from './worker.js';

const tenantId = 'tenant-a';
const ownerId = '11111111-1111-4111-8111-111111111111';
const collaboratorId = '22222222-2222-4222-8222-222222222222';
const binding: AzerothServerBinding = {
  bindingId: 'binding-a',
  serverSide: true,
  roles: ['ADMIN'],
  baseUrl: 'https://azeroth.example.test',
  credentialHandle: 'server-secret-handle',
};
const now = '2026-08-23T06:00:00.000Z';

function customer(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    serialNumber: `CUS-${id}`,
    customerName: `Customer ${id}`,
    status: 'active',
    updatedAt: '2026-08-22T06:00:00.000Z',
    version: 3,
    ...overrides,
  };
}

function partition(overrides: Partial<ContextSyncPartition> = {}): ContextSyncPartition {
  return {
    tenantId,
    sourceId: 'azeroth-authoritative',
    collectionId: 'azeroth-customers',
    partitionKey: 'authoritative-inventory',
    status: 'syncing',
    leaseOwner: 'worker-a',
    leaseFence: 7,
    retryCount: 0,
    truncated: false,
    refused: false,
    updatedAt: now,
    ...overrides,
  };
}

function setup() {
  const store: AzerothContextStorePort = {
    getSource: vi.fn().mockResolvedValue({ revision: 1, status: 'active' }),
    createSource: vi.fn().mockResolvedValue({ revision: 1, status: 'active' }),
    getCollection: vi.fn().mockResolvedValue({ revision: 1, status: 'active' }),
    createCollection: vi.fn().mockResolvedValue({ revision: 1, status: 'active' }),
    ensurePartition: vi.fn().mockResolvedValue(partition({ status: 'idle' })),
    acquirePartitionLease: vi.fn().mockResolvedValue(partition()),
    renewPartitionLease: vi.fn().mockResolvedValue(true),
    ingestPage: vi.fn().mockResolvedValue({}),
    failPartition: vi.fn().mockResolvedValue(partition({ status: 'retry_wait' })),
    listCurrentExternalRecordIds: vi.fn().mockResolvedValue([]),
  };
  const http: AzerothHttpClient = { get: vi.fn() };
  const bindings = { listServerBindings: vi.fn().mockResolvedValue([binding]) };
  const worker = new AzerothInventoryWorker({
    bindings,
    http,
    store,
    leaseOwner: 'worker-a',
    pageSize: 2,
    clock: () => new Date(now),
  });
  return { worker, store, http, bindings };
}

describe('AzerothInventoryWorker', () => {
  it('paginates the documented GET request and commits only one complete inventory watermark', async () => {
    const { worker, store, http } = setup();
    vi.mocked(http.get)
      .mockResolvedValueOnce({ data: [customer('a'), customer('b')], pagination: { page: 1, total: 3, totalPages: 2 } })
      .mockResolvedValueOnce({ data: [customer('c')], pagination: { page: 2, total: 3, totalPages: 2 } });

    await expect(worker.syncEntity(tenantId, 'customers')).resolves.toMatchObject({
      pages: 2,
      records: 3,
      revoked: 0,
    });

    expect(http.get).toHaveBeenNthCalledWith(1, {
      binding,
      path: '/api/v1/customers',
      query: { page: 1, pageSize: 2, sortBy: 'updatedAt', sortOrder: 'asc' },
    });
    expect(http.get).toHaveBeenNthCalledWith(2, {
      binding,
      path: '/api/v1/customers',
      query: { page: 2, pageSize: 2, sortBy: 'updatedAt', sortOrder: 'asc' },
    });
    const calls = vi.mocked(store.ingestPage).mock.calls.map(call => call[0]);
    expect(calls.filter(call => call.checkpoint.complete === true)).toHaveLength(1);
    expect(calls.at(-1)?.checkpoint.watermark).toMatchObject({ mode: 'full_inventory', pages: 2, records: 3 });
    expect(JSON.stringify(calls)).not.toContain('server-secret-handle');
  });

  it('revokes only records absent after every inventory page succeeds', async () => {
    const { worker, store, http } = setup();
    vi.mocked(http.get).mockResolvedValueOnce({ items: [customer('present')], total: 1 });
    vi.mocked(store.listCurrentExternalRecordIds).mockResolvedValueOnce([
      'azeroth:customers:present',
      'azeroth:customers:missing',
    ]);

    await expect(worker.syncEntity(tenantId, 'customers')).resolves.toMatchObject({ revoked: 1 });

    const terminal = vi.mocked(store.ingestPage).mock.calls.at(-1)?.[0];
    expect(terminal?.records).toEqual([
      expect.objectContaining({
        externalRecordId: 'azeroth:customers:missing',
        nativeId: 'missing',
        revoked: true,
        content: null,
      }),
    ]);
    expect(terminal?.checkpoint.complete).toBe(true);
  });

  it('filters website noise before ingest and reconciles only the sales-signal inventory', async () => {
    const { worker, store, http } = setup();
    vi.mocked(http.get).mockResolvedValueOnce({ items: [{
      id: 'pageview-1', event: 'pageview', receivedAt: now, isBot: false,
    }, {
      id: 'lead-1', event: 'consult_form_submit', receivedAt: now, isBot: false,
    }], total: 2 });
    vi.mocked(store.listCurrentExternalRecordIds).mockResolvedValueOnce([
      'azeroth:web-events:lead-old',
    ]);

    await expect(worker.syncEntity(tenantId, 'web-events')).resolves.toMatchObject({ records: 1, revoked: 1 });
    const calls = vi.mocked(store.ingestPage).mock.calls.map(call => call[0]);
    expect(calls[0]?.records).toEqual([expect.objectContaining({ externalRecordId: 'azeroth:web-events:lead-1' })]);
    expect(JSON.stringify(calls)).not.toContain('pageview-1');
    expect(calls.at(-1)?.records).toEqual([
      expect.objectContaining({ externalRecordId: 'azeroth:web-events:lead-old', revoked: true }),
    ]);
  });

  it('does not reconcile or advance a complete watermark when a later page fails', async () => {
    const { worker, store, http } = setup();
    vi.mocked(http.get)
      .mockResolvedValueOnce({ items: [customer('a'), customer('b')] })
      .mockRejectedValueOnce(new Error('page 2 unavailable'));
    vi.mocked(store.listCurrentExternalRecordIds).mockResolvedValue(['azeroth:customers:missing']);

    await expect(worker.syncEntity(tenantId, 'customers')).rejects.toThrow('page 2 unavailable');

    expect(store.listCurrentExternalRecordIds).not.toHaveBeenCalled();
    const calls = vi.mocked(store.ingestPage).mock.calls.map(call => call[0]);
    expect(calls.every(call => call.checkpoint.complete !== true)).toBe(true);
    expect(calls.flatMap(call => call.records).some(record => record.revoked)).toBe(false);
    expect(store.failPartition).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: 'AZEROTH_SYNC_FAILED',
    }));
  });

  it('ingests but marks the inventory degraded and never sweeps without an authoritative total', async () => {
    const { worker, store, http } = setup();
    vi.mocked(http.get).mockResolvedValueOnce({ items: [customer('present')], totalPages: 1 });
    vi.mocked(store.listCurrentExternalRecordIds).mockResolvedValueOnce(['azeroth:customers:missing']);

    await expect(worker.syncEntity(tenantId, 'customers')).resolves.toMatchObject({
      records: 1,
      revoked: 0,
      complete: false,
      degraded: true,
      degradedReason: 'authoritative_count_missing',
    });

    expect(store.listCurrentExternalRecordIds).not.toHaveBeenCalled();
    const terminal = vi.mocked(store.ingestPage).mock.calls.at(-1)?.[0];
    expect(terminal?.records).toEqual([]);
    expect(terminal?.checkpoint).toMatchObject({
      complete: false,
      releaseLease: true,
      watermark: { status: 'degraded', reason: 'authoritative_count_missing' },
    });
  });

  it('fails incomplete when a page-number inventory repeats an id across pages', async () => {
    const { worker, store, http } = setup();
    vi.mocked(http.get)
      .mockResolvedValueOnce({ items: [customer('a'), customer('b')], total: 3, totalPages: 2 })
      .mockResolvedValueOnce({ items: [customer('b')], total: 3, totalPages: 2 });

    await expect(worker.syncEntity(tenantId, 'customers')).rejects.toThrow('repeated id b across pages');
    expect(store.listCurrentExternalRecordIds).not.toHaveBeenCalled();
    expect(vi.mocked(store.ingestPage).mock.calls.flatMap(call => call[0].records).some(record => record.revoked)).toBe(false);
  });

  it('uses each entity native id field when checking cross-page inventory uniqueness', async () => {
    const { worker, store, http } = setup();
    vi.mocked(http.get).mockResolvedValueOnce({
      items: [
        { reportId: 'report-a', updatedAt: '2026-08-22T06:00:00.000Z' },
        { reportId: 'report-b', updatedAt: '2026-08-22T06:00:00.000Z' },
      ], total: 2, totalPages: 1,
    });

    await expect(worker.syncEntity(tenantId, 'dingtalk-logs')).resolves.toMatchObject({
      records: 2, revoked: 0, complete: true,
    });
    expect(vi.mocked(store.ingestPage).mock.calls.flatMap(call => call[0].records)
      .map(record => record.externalRecordId)).toEqual(expect.arrayContaining([
      'azeroth:dingtalk-logs:report-a', 'azeroth:dingtalk-logs:report-b',
    ]));
  });

  it('fails incomplete when authoritative pagination counts drift while data changes', async () => {
    const { worker, store, http } = setup();
    vi.mocked(http.get)
      .mockResolvedValueOnce({ items: [customer('a'), customer('b')], total: 4, totalPages: 2 })
      .mockResolvedValueOnce({ items: [customer('c')], total: 3, totalPages: 2 });

    await expect(worker.syncEntity(tenantId, 'customers')).rejects.toThrow('pagination total drifted from 4 to 3');
    expect(store.listCurrentExternalRecordIds).not.toHaveBeenCalled();
  });

  it('fails incomplete when totalPages drifts despite a stable total', async () => {
    const { worker, store, http } = setup();
    vi.mocked(http.get)
      .mockResolvedValueOnce({ items: [customer('a'), customer('b')], total: 4, totalPages: 2 })
      .mockResolvedValueOnce({ items: [customer('c'), customer('d')], total: 4, totalPages: 3 });

    await expect(worker.syncEntity(tenantId, 'customers')).rejects.toThrow('pagination totalPages drifted from 2 to 3');
    expect(store.listCurrentExternalRecordIds).not.toHaveBeenCalled();
  });

  it('fails incomplete when a non-terminal authoritative page is short', async () => {
    const { worker, store, http } = setup();
    vi.mocked(http.get).mockResolvedValueOnce({ items: [customer('a')], total: 3, totalPages: 2 });

    await expect(worker.syncEntity(tenantId, 'customers')).rejects.toThrow('page 1 expected 2 records but received 1');
    expect(http.get).toHaveBeenCalledTimes(1);
    expect(store.listCurrentExternalRecordIds).not.toHaveBeenCalled();
  });

  it('fails closed before creating a source when there is no unique ADMIN server binding', async () => {
    const { worker, store, bindings, http } = setup();
    vi.mocked(bindings.listServerBindings).mockResolvedValueOnce([{
      ...binding,
      bindingId: 'non-admin',
      roles: ['SALES'],
    }]);

    await expect(worker.syncEntity(tenantId, 'customers')).rejects.toBeInstanceOf(AzerothAuthorizationError);
    expect(store.getSource).not.toHaveBeenCalled();
    expect(store.createSource).not.toHaveBeenCalled();
    expect(http.get).not.toHaveBeenCalled();
  });
});

describe('normalizeAzerothRecord', () => {
  it('maps deletedAt to a tombstone while retaining stable native identity and source revision', () => {
    const first = normalizeAzerothRecord('customers', customer('native-1', {
      deletedAt: '2026-08-22T07:00:00.000Z',
    }), now);
    const replay = normalizeAzerothRecord('customers', customer('native-1', {
      deletedAt: '2026-08-22T07:00:00.000Z',
    }), '2026-08-23T07:00:00.000Z');

    expect(first).toMatchObject({
      nativeId: 'native-1',
      externalRecordId: 'azeroth:customers:native-1',
      deleted: true,
      sourceEventId: 'azeroth:customers:native-1:3',
      entityType: 'customer',
      recordKind: 'snapshot',
    });
    expect(replay.recordId).toBe(first.recordId);
    expect(replay.sourceEventId).toBe(first.sourceEventId);
  });

  it('builds ACLs only from employee UUIDs and never falls back to organization-wide access', () => {
    const record = normalizeAzerothRecord('customers', customer('acl', {
      chargerId: ownerId,
      collaboratorIds: [collaboratorId, 'not-an-employee-uuid'],
    }), now);
    const unknown = normalizeAzerothRecord('customers', customer('unknown', {
      chargerId: 'dingtalk-user-id',
      collaboratorIds: ['display name'],
    }), now);

    expect(record.ownerPrincipal).toBe(`azeroth-employee:${ownerId}`);
    expect(record.aclPrincipals).toEqual([
      `azeroth-employee:${ownerId}`,
      `azeroth-employee:${collaboratorId}`,
    ]);
    expect(unknown.ownerPrincipal).toBeUndefined();
    expect(unknown.aclPrincipals).toEqual([]);
  });

  it('excludes known PII fields and redacts phones/emails embedded in allowed text', () => {
    const record = normalizeAzerothRecord('customers', customer('pii', {
      phone: '13800138000',
      address: 'Secret street 1',
      contacts: [{ mobile: '13900139000' }],
      shortName: 'call 13800138000 or a@example.test',
    }), now);
    const serialized = JSON.stringify(record.content);

    expect(serialized).not.toContain('13800138000');
    expect(serialized).not.toContain('13900139000');
    expect(serialized).not.toContain('Secret street 1');
    expect(serialized).not.toContain('a@example.test');
    expect(serialized).toContain('[PHONE_REDACTED]');
  });

  it('maps employees and contacts to Person without exposing contact details', () => {
    const employee = normalizeAzerothRecord('employees', {
      id: ownerId,
      name: 'Sales owner',
      serialNumber: 'E001',
      position: 'Sales',
      status: 'active',
      phone: '13800138000',
      email: 'owner@example.test',
      updatedAt: '2026-08-22T06:00:00.000Z',
      version: 2,
    }, now);
    const contact = normalizeAzerothRecord('contacts', {
      id: 'contact-1',
      contactName: 'Customer contact',
      customerId: 'customer-1',
      customerName: 'Customer',
      status: 'active',
      mobile: '13900139000',
      email: 'contact@example.test',
      updatedAt: '2026-08-22T06:00:00.000Z',
      version: 1,
    }, now);

    expect(employee).toMatchObject({ entityType: 'person', ownerPrincipal: `azeroth-employee:${ownerId}` });
    expect(contact).toMatchObject({ entityType: 'person', aclPrincipals: [], metadata: { customerId: 'customer-1' } });
    expect(JSON.stringify([employee.content, contact.content])).not.toMatch(/13800138000|13900139000|@example\.test/);
  });

  it('keeps only website sales signals as minimal events without browser identifiers or raw payload', () => {
    expect(shouldIngestAzerothRow('web-events', { event: 'pageview', isBot: false })).toBe(false);
    expect(shouldIngestAzerothRow('web-events', { event: 'consult_form_submit', isBot: false })).toBe(true);
    expect(shouldIngestAzerothRow('web-events', { event: 'consult_form_submit', isBot: true })).toBe(false);
    const record = normalizeAzerothRecord('web-events', {
      id: 'web-1',
      receivedAt: '2026-08-22T06:00:00.000Z',
      site: 'kaiyan.net',
      event: 'consult_click',
      path: '/agent',
      title: 'Agent',
      channel: 'dingtalk',
      vid: 'visitor-secret',
      sid: 'session-secret',
      ipHash: 'ip-secret',
      ua: 'ua-secret',
      raw: { phone: '13800138000' },
    }, now);

    expect(record).toMatchObject({ recordKind: 'event', nativeId: 'web-1', aclPrincipals: [] });
    expect(JSON.stringify(record.content)).not.toMatch(/visitor-secret|session-secret|ip-secret|ua-secret|13800138000/);
  });

  it('keeps PAT behind an opaque handle and rejects endpoint drift', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer pat-secret');
      return new Response(JSON.stringify({ items: [] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    });
    let apiUrl = 'https://azeroth.example.test';
    const ports = new ConfigAzerothContextPorts({
      fetchImpl,
      listBindings: () => [{ tenantId, username: 'admin', token: 'pat-must-not-leak', roles: ['ADMIN'], source: 'v2' }],
      resolveInjection: () => ({ token: 'pat-secret', apiUrl }),
    });
    const [resolved] = await ports.listServerBindings(tenantId);
    expect(resolved).toBeDefined();
    expect(JSON.stringify(resolved)).not.toContain('pat-secret');
    expect(JSON.stringify(resolved)).not.toContain('pat-must-not-leak');
    await expect(ports.get({ binding: resolved!, path: '/api/v1/customers', query: { page: 1 } }))
      .resolves.toEqual({ items: [] });

    apiUrl = 'https://drift.example.test';
    await expect(ports.get({ binding: resolved!, path: '/api/v1/customers', query: { page: 2 } }))
      .rejects.toThrow('AZEROTH_CONTEXT_ENDPOINT_DRIFT');
  });

  it('keeps opportunity as a typed business snapshot without masquerading as Task', () => {
    const record = normalizeAzerothRecord('opportunities', {
      id: 'opp-1',
      serialNumber: 'OPP-1',
      opportunityName: 'Expansion',
      customerId: 'customer-1',
      chargerId: ownerId,
      updatedAt: '2026-08-22T06:00:00.000Z',
      version: 4,
    }, now);

    expect(record.entityType).toBeUndefined();
    expect(record.recordKind).toBe('snapshot');
    expect(record.metadata).toMatchObject({
      businessObjectType: 'opportunity',
      customerId: 'customer-1',
    });
  });
});

import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { contextCenterSnapshotSchema } from '../../../shared/src/lib/governanceApi.js';
import {
  createContextAdminRouter,
  type ContextAdminConsumerStorePort,
  type ContextAdminStorePort,
} from './contextAdmin.js';

const servers: import('node:http').Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

async function start(
  user: Express.Request['user'],
  store?: ContextAdminStorePort,
  consumers?: ContextAdminConsumerStorePort,
) {
  const app = express();
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use('/api/admin/context-plane', createContextAdminRouter({
    ...(store ? { store } : {}),
    ...(consumers ? { consumers } : {}),
    now: () => new Date('2026-08-22T16:00:00.000Z'),
  }));
  const server = await new Promise<import('node:http').Server>(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  servers.push(server);
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/api/admin/context-plane`;
}

function createStore(overrides: Partial<ContextAdminStorePort> = {}): ContextAdminStorePort {
  return {
    listSources: vi.fn(async () => [{
      sourceId: 'source-a', kind: 'dws', displayName: '钉钉', status: 'active',
    }]),
    listCollections: vi.fn(async () => [{
      sourceId: 'source-a', collectionId: 'collection-a', displayName: '产品知识', status: 'active',
      metadata: {
        historicalLearning: {
          enabled: true, mode: 'selected', conversationIds: ['cid-a', 'cid-b'], lookbackDays: 30,
        },
        realtimeListening: { enabled: true, mode: 'all', conversationIds: [] },
      },
    }]),
    listPartitions: vi.fn(async () => [{
      sourceId: 'source-a', collectionId: 'collection-a', status: 'complete',
      watermark: '2026-08-22T15:58:00.000Z', coverageStart: '2026-01-01T00:00:00.000Z',
      coverageEnd: '2026-08-22T15:58:00.000Z', truncated: true, refused: false,
      updatedAt: '2026-08-22T15:59:00.000Z',
    }]),
    countUnreadableRecords: vi.fn(async () => 0),
    ...overrides,
  };
}

const orgAdmin = { sub: 'admin-a', username: 'admin', role: 'admin' as const, tenantId: 'tenant-a' };

describe('Context Plane admin HTTP contract', () => {
  it('builds one truthful shared-schema card per source+collection without inventing an item total', async () => {
    const store = createStore();
    const base = await start(orgAdmin, store);

    const response = await fetch(`${base}/snapshot`);
    expect(response.status).toBe(200);
    const snapshot = contextCenterSnapshotSchema.parse(await response.json());
    expect(snapshot).toEqual({
      generatedAt: '2026-08-22T16:00:00.000Z',
      sources: [{
        sourceId: 'source-a', name: '钉钉', system: 'dws',
        collectionId: 'collection-a', collection: '产品知识', status: 'healthy',
        lastSyncedAt: '2026-08-22T15:59:00.000Z',
        backfillCoverage: {
          kind: 'time', coveredFrom: '2026-01-01T00:00:00.000Z',
          coveredThrough: '2026-08-22T15:58:00.000Z',
        },
        watermarkLagSeconds: 120,
        ingestOutcomes: { truncated: 1, refused: 0, unreadable: 0, retrying: 0, nextRetryAt: null },
        historicalLearningScope: {
          enabled: true, summary: '2 个指定会话 · 30 天', from: '2026-01-01T00:00:00.000Z',
          through: '2026-08-22T15:58:00.000Z',
        },
        realtimeListeningScope: { enabled: true, summary: '全部会话' },
      }],
      consumers: [],
    });
    expect(store.listSources).toHaveBeenCalledWith('tenant-a');
    expect(store.listCollections).toHaveBeenCalledWith('tenant-a');
    expect(store.listPartitions).toHaveBeenCalledWith('tenant-a');
    expect(JSON.stringify(snapshot)).not.toContain('totalItems');
  });

  it('reports persisted unreadable sync failures instead of inventing a zero', async () => {
    const store = createStore({
      countUnreadableRecords: vi.fn(async () => 2),
      listPartitions: vi.fn(async () => [{
        sourceId: 'source-a', collectionId: 'collection-a', status: 'retry_wait',
        truncated: true, refused: false, lastErrorCode: 'CONTEXT_SYNC_UNREADABLE',
        nextRetryAt: '2026-08-22T16:05:00.000Z', updatedAt: '2026-08-22T15:59:00.000Z',
      }]),
    });
    const base = await start(orgAdmin, store);
    const snapshot = contextCenterSnapshotSchema.parse(await (await fetch(`${base}/snapshot`)).json());
    expect(snapshot.sources[0]?.ingestOutcomes).toMatchObject({
      unreadable: 3, retrying: 1, nextRetryAt: '2026-08-22T16:05:00.000Z',
    });
  });

  it('does not report a stale completed partition as healthy', async () => {
    const base = await start(orgAdmin, createStore({
      listPartitions: vi.fn(async () => [{
        sourceId: 'source-a', collectionId: 'collection-a', status: 'complete',
        watermark: { inventoryObservedAt: '2026-08-22T12:00:00.000Z' },
        truncated: false, refused: false, updatedAt: '2026-08-22T12:00:00.000Z',
      }, {
        sourceId: 'source-a', collectionId: 'collection-a', status: 'complete',
        watermark: { inventoryObservedAt: '2026-08-22T15:59:00.000Z' },
        truncated: false, refused: false, updatedAt: '2026-08-22T15:59:00.000Z',
      }]),
    }));

    const snapshot = contextCenterSnapshotSchema.parse(await (await fetch(`${base}/snapshot`)).json());
    expect(snapshot.sources[0]).toMatchObject({ status: 'attention', watermarkLagSeconds: 14_400 });
  });

  it('uses 未配置/unknown when collection source or sync metadata is absent', async () => {
    const base = await start(orgAdmin, createStore({
      listSources: vi.fn(async () => []),
      listCollections: vi.fn(async () => [{
        sourceId: 'source-a', collectionId: 'collection-a', displayName: '产品知识', status: 'active',
      }]),
      listPartitions: vi.fn(async () => []),
    }));

    const snapshot = contextCenterSnapshotSchema.parse(await (await fetch(`${base}/snapshot`)).json());
    expect(snapshot.sources[0]).toMatchObject({
      sourceId: 'source-a', name: '未配置', system: 'unknown', status: 'paused',
      backfillCoverage: { kind: 'time', coveredFrom: null, coveredThrough: null },
      watermarkLagSeconds: null,
      historicalLearningScope: { enabled: false, summary: '未配置' },
      realtimeListeningScope: { enabled: false, summary: '未配置' },
    });
  });

  it('rejects legacy raw evidence locators and fails closed without the product authorization service', async () => {
    const base = await start(orgAdmin, createStore());
    expect((await fetch(`${base}/evidence?sourceId=source-a&collectionId=collection-a`)).status).toBe(400);
    expect((await fetch(`${base}/evidence?id=ce1.payload.signature`)).status).toBe(503);
  });

  it('reports durable derived consumers and fails closed when their read model is unavailable', async () => {
    const consumers: ContextAdminConsumerStorePort = { listConsumers: vi.fn(async () => [{
      id: 'deterministic-v1', name: 'deterministic-v1', kind: 'deterministic-projector',
      status: 'lagging' as const, watermarkAt: '2026-08-22T15:59:00.000Z', lagSeconds: null,
      detail: '待处理 3 个 Context revision',
    }]) };
    const base = await start(orgAdmin, createStore(), consumers);
    const snapshot = contextCenterSnapshotSchema.parse(await (await fetch(`${base}/snapshot`)).json());
    expect(snapshot.consumers).toEqual([expect.objectContaining({
      id: 'deterministic-v1', status: 'lagging', detail: '待处理 3 个 Context revision',
    })]);
    expect(consumers.listConsumers).toHaveBeenCalledWith('tenant-a');

    const unavailable = await start(orgAdmin, createStore(), {
      listConsumers: vi.fn(async () => { throw new Error('db unavailable'); }),
    });
    expect((await fetch(`${unavailable}/snapshot`)).status).toBe(503);
  });

  it('locks organization admins to their tenant and returns 503 for an unavailable optional Store', async () => {
    const store = createStore();
    const base = await start(orgAdmin, store);
    expect((await fetch(`${base}/snapshot?tenantId=tenant-b`)).status).toBe(403);
    expect(store.listSources).not.toHaveBeenCalled();

    const unavailableBase = await start(orgAdmin);
    expect((await fetch(`${unavailableBase}/snapshot`)).status).toBe(503);
  });
});

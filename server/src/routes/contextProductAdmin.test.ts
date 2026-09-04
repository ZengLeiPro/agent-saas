import type { AddressInfo } from 'node:net';

import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ContextProductError, type ContextProductService } from '../context/product/index.js';
import { createContextAdminRouter } from './contextAdmin.js';

const servers: import('node:http').Server[] = [];
afterEach(async () => Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))));

async function start(product: Partial<ContextProductService>, user: Express.Request['user'] = {
  sub: 'actor-a', username: 'admin', role: 'admin', tenantId: 'tenant-a',
}, targetOrganizationAccess?: Parameters<typeof createContextAdminRouter>[0]['targetOrganizationAccess']) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use('/api/admin/context-plane', createContextAdminRouter({
    product: product as ContextProductService,
    ...(targetOrganizationAccess ? { targetOrganizationAccess } : {}),
  }));
  const server = await new Promise<import('node:http').Server>(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/admin/context-plane`;
}

describe('Context product admin routes', () => {
  it('resolves evidence only through an opaque handle and authenticated product service', async () => {
    const getEvidence = vi.fn(async () => [{ id: 'ce1.payload.signature', quote: 'authorized' }]);
    const base = await start({ getEvidence } as Partial<ContextProductService>);
    expect((await fetch(`${base}/evidence?sourceId=source-a&collectionId=collection-a`)).status).toBe(400);
    const response = await fetch(`${base}/evidence?id=ce1.payload.signature`);
    expect(response.status).toBe(200);
    expect(getEvidence).toHaveBeenCalledWith({ tenantId: 'tenant-a', actorId: 'actor-a' }, 'ce1.payload.signature');
  });

  it('takes actor/tenant from authenticated user and strictly validates queries', async () => {
    const listTimeline = vi.fn(async () => ({ items: [], nextCursor: null, degraded: false }));
    const base = await start({ listTimeline } as Partial<ContextProductService>);
    expect((await fetch(`${base}/timeline?limit=0`)).status).toBe(400);
    expect((await fetch(`${base}/timeline?unknown=x`)).status).toBe(400);
    expect((await fetch(`${base}/timeline?from=2026-08-24T00:00:00Z&through=2026-08-23T00:00:00Z`)).status).toBe(400);
    const response = await fetch(`${base}/timeline?limit=10&type=Status`);
    expect(response.status).toBe(200);
    expect(listTimeline).toHaveBeenCalledWith({ tenantId: 'tenant-a', actorId: 'actor-a' }, { limit: 10, type: 'Status' });
  });

  it('blocks organization-admin tenant override but lets platform admin select tenant without changing actor', async () => {
    const listEntities = vi.fn(async () => ({ items: [], nextCursor: null, degraded: false }));
    const org = await start({ listEntities } as Partial<ContextProductService>);
    expect((await fetch(`${org}/entities?tenantId=tenant-b`)).status).toBe(403);
    expect(listEntities).not.toHaveBeenCalled();

    const getMembership = vi.fn();
    const platform = await start({ listEntities } as Partial<ContextProductService>, {
      sub: 'platform-actor', username: 'root', role: 'admin', tenantId: 'pantheon',
    }, {
      memberships: {
        getPlatformAdmin: vi.fn().mockResolvedValue({ userId: 'platform-actor', status: 'active' }),
        getMembership,
      } as never,
      tenantExists: tenantId => tenantId === 'tenant-b',
    });
    const missingTarget = await fetch(`${platform}/entities`);
    expect(missingTarget.status).toBe(403);
    await expect(missingTarget.json()).resolves.toMatchObject({ code: 'TARGET_TENANT_REQUIRED' });
    expect((await fetch(`${platform}/entities?tenantId=tenant-b`)).status).toBe(200);
    expect(listEntities).toHaveBeenLastCalledWith({
      tenantId: 'tenant-b', actorId: 'platform-actor', actorTenantId: 'pantheon',
      actorPersona: 'platform_admin', accessMode: 'platform_manage',
    }, {});
    expect(getMembership).not.toHaveBeenCalled();
  });

  it('paginates entity items and correction history with strict server-owned subjects', async () => {
    const listEntityItems = vi.fn(async () => ({ items: [], nextCursor: null, degraded: false }));
    const listEntityCorrections = vi.fn(async () => ({ items: [], nextCursor: null, degraded: false }));
    const base = await start({ listEntityItems, listEntityCorrections } as Partial<ContextProductService>);

    expect((await fetch(`${base}/entities/entity-a/items?limit=0`)).status).toBe(400);
    expect((await fetch(`${base}/entities/entity-a/items?unknown=x`)).status).toBe(400);
    expect((await fetch(`${base}/entities/entity-a/corrections?tenantId=tenant-b`)).status).toBe(403);
    expect((await fetch(`${base}/entities/entity-a/corrections?unknown=x`)).status).toBe(400);

    expect((await fetch(`${base}/entities/entity-a/items?cursor=item-cursor&limit=25`)).status).toBe(200);
    expect(listEntityItems).toHaveBeenCalledWith(
      { tenantId: 'tenant-a', actorId: 'actor-a' }, 'entity-a', { cursor: 'item-cursor', limit: 25 },
    );
    expect((await fetch(`${base}/entities/entity-a/corrections?cursor=correction-cursor&limit=10`)).status).toBe(200);
    expect(listEntityCorrections).toHaveBeenCalledWith(
      { tenantId: 'tenant-a', actorId: 'actor-a' }, 'entity-a', { cursor: 'correction-cursor', limit: 10 },
    );
  });

  it('requires expectedRevision and the server correction contract', async () => {
    const correct = vi.fn(async () => ({ id: 'review-a' }));
    const base = await start({ correct } as Partial<ContextProductService>);
    const headers = { 'content-type': 'application/json' };
    expect((await fetch(`${base}/entities/entity-a/corrections`, {
      method: 'POST', headers, body: JSON.stringify({ action: 'assert', scope: 'personal', targetItemId: 'item-a', summary: 'new', evidenceIds: ['ce1.x.y'] }),
    })).status).toBe(428);
    expect((await fetch(`${base}/entities/entity-a/corrections`, {
      method: 'POST', headers, body: JSON.stringify({ action: 'assert', scope: 'personal', expectedRevision: 1, summary: 'new', evidenceIds: ['ce1.x.y'] }),
    })).status).toBe(400);
    expect((await fetch(`${base}/entities/entity-a/corrections`, {
      method: 'POST', headers, body: JSON.stringify({ action: 'assert', scope: 'personal', expectedRevision: 1,
        targetItemId: 'item-a', summary: 'new', evidenceIds: ['ce1.x.y'], rejectFingerprint: 'client-must-not-send' }),
    })).status).toBe(400);
    const accepted = await fetch(`${base}/entities/entity-a/corrections`, {
      method: 'POST', headers, body: JSON.stringify({ action: 'reject', scope: 'organization', expectedRevision: 1,
        targetItemId: 'item-a', evidenceIds: ['ce1.x.y'] }),
    });
    expect(accepted.status).toBe(200);
    expect(correct).toHaveBeenCalledWith({ tenantId: 'tenant-a', actorId: 'actor-a' }, 'entity-a', {
      action: 'reject', scope: 'organization', expectedRevision: 1, targetItemId: 'item-a', evidenceIds: ['ce1.x.y'],
    });
  });

  it('maps product errors to clear API status codes and supports review transition aliases', async () => {
    const errors: Array<[ContextProductError['code'], number]> = [
      ['CONTEXT_PRODUCT_INVALID', 400], ['CONTEXT_PRODUCT_FORBIDDEN', 403],
      ['CONTEXT_PRODUCT_NOT_FOUND', 404], ['CONTEXT_PRODUCT_CONFLICT', 409],
      ['CONTEXT_PRODUCT_UNAVAILABLE', 503],
    ];
    for (const [code, status] of errors) {
      const base = await start({ listReviews: vi.fn(async () => { throw new ContextProductError(code); }) } as Partial<ContextProductService>);
      expect((await fetch(`${base}/reviews`)).status).toBe(status);
    }
    const decideReview = vi.fn(async () => ({ status: 'confirmed' }));
    const base = await start({ decideReview } as Partial<ContextProductService>);
    const response = await fetch(`${base}/reviews/item-a/decision`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'confirm', expectedRevision: 1 }),
    });
    expect(response.status).toBe(200);
    expect(decideReview).toHaveBeenCalledWith({ tenantId: 'tenant-a', actorId: 'actor-a' }, 'item-a', {
      decision: 'confirmed', expectedRevision: 1,
    });
  });
});

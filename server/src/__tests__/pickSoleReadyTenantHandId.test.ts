import { describe, expect, it } from 'vitest';

import { pickSoleReadyTenantHandId, type HandRecord } from '../runtime/handStore.js';

function makeHand(overrides: Partial<HandRecord>): HandRecord {
  return {
    handId: overrides.handId ?? 'hand-default',
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
    type: 'server-remote',
    status: 'ready',
    endpoint: 'http://example.local',
    capabilities: [],
    createdAt: '2026-06-19T00:00:00.000Z',
    updatedAt: '2026-06-19T00:00:00.000Z',
    metadata: { tenantRemoteHandId: 'tenant-ecs' },
    ...overrides,
  };
}

describe('pickSoleReadyTenantHandId (B2)', () => {
  it('returns undefined for an empty hand list', () => {
    expect(pickSoleReadyTenantHandId([])).toBeUndefined();
  });

  it('picks the only ready tenant remote hand', () => {
    const hand = makeHand({ handId: 'session-1:tenant-ecs' });
    expect(pickSoleReadyTenantHandId([hand])).toBe('session-1:tenant-ecs');
  });

  it('returns undefined when more than one ready tenant hand exists', () => {
    const a = makeHand({ handId: 'session-1:tenant-a', metadata: { tenantRemoteHandId: 'tenant-a' } });
    const b = makeHand({ handId: 'session-1:tenant-b', metadata: { tenantRemoteHandId: 'tenant-b' } });
    expect(pickSoleReadyTenantHandId([a, b])).toBeUndefined();
  });

  it('ignores non-server-remote hands (e.g. workspace default or client)', () => {
    const tenantHand = makeHand({ handId: 'session-1:tenant-ecs' });
    const workspaceHand = makeHand({
      handId: 'workspace-1:server-local',
      type: 'server-local',
      metadata: {},
    });
    const clientHand = makeHand({
      handId: 'client-daemon-A',
      type: 'client',
      metadata: { tenantRemoteHandId: 'should-not-match-non-server-remote' },
    });
    expect(pickSoleReadyTenantHandId([workspaceHand, tenantHand, clientHand])).toBe('session-1:tenant-ecs');
  });

  it('ignores hands without tenantRemoteHandId metadata', () => {
    const regularServerRemote = makeHand({ handId: 'session-1:plain', metadata: {} });
    const tenantHand = makeHand({ handId: 'session-1:tenant-ecs' });
    expect(pickSoleReadyTenantHandId([regularServerRemote, tenantHand])).toBe('session-1:tenant-ecs');
  });

  it('ignores hands whose status is not ready', () => {
    const unhealthy = makeHand({ handId: 'session-1:tenant-a', status: 'unhealthy', metadata: { tenantRemoteHandId: 'tenant-a' } });
    const ready = makeHand({ handId: 'session-1:tenant-b', metadata: { tenantRemoteHandId: 'tenant-b' } });
    expect(pickSoleReadyTenantHandId([unhealthy, ready])).toBe('session-1:tenant-b');
    expect(pickSoleReadyTenantHandId([unhealthy])).toBeUndefined();
  });

  it('treats empty tenantRemoteHandId string as not a candidate', () => {
    const blank = makeHand({ handId: 'session-1:blank', metadata: { tenantRemoteHandId: '' } });
    expect(pickSoleReadyTenantHandId([blank])).toBeUndefined();
  });
});

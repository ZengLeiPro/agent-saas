import express from 'express';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionAutomationsRouter } from '../routes/sessionAutomations.js';

const user = { sub: 'user-a', username: 'alice', role: 'user', tenantId: 'tenant-a' } as const;
const sessionId = '11111111-1111-4111-8111-111111111111';
const automationId = '22222222-2222-4222-8222-222222222222';
const snapshot = {
  automationId,
  incarnationId: '33333333-3333-4333-8333-333333333333',
  tenantId: user.tenantId,
  sessionId,
  ownerUserId: user.sub,
  status: 'active',
  phase: 'waiting',
  generation: 1,
  specVersion: 1,
  controlVersion: 1,
  projectionVersion: 2,
  spec: { kind: 'goal', mode: 'goal', condition: 'done', budget: {} },
  runCount: 0,
  noProgressCount: 0,
  createdAt: '2026-08-30T00:00:00.000Z',
  updatedAt: '2026-08-30T00:00:00.000Z',
} as const;

const servers = new Set<Server>();
afterEach(async () => {
  await Promise.all([...servers].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  servers.clear();
});

async function setup(ownerUserId: string = user.sub) {
  const store = {
    setNotifier: vi.fn(),
    prepareCommandSession: vi.fn(async () => sessionId),
    latestEventCursor: vi.fn(async () => '1'),
    listEvents: vi.fn(async () => ({ events: [{ eventId: 'event-1', type: 'created' }], nextCursor: '1' })),
    list: vi.fn(async () => [{ ...snapshot, ownerUserId }]),
    get: vi.fn(async () => ({ ...snapshot, ownerUserId })),
    getByAutomationId: vi.fn(async () => ({ ...snapshot, ownerUserId })),
  };
  const service = {
    command: vi.fn(async () => ({ result: 'created', snapshot })),
    control: vi.fn(async () => ({ result: 'updated', snapshot })),
    edit: vi.fn(async () => ({ result: 'updated', snapshot })),
  };
  const createSession = vi.fn(async () => ({ tenantId: user.tenantId, ownerUserId: user.sub, sessionId }));
  const sessionCatalog = { get: vi.fn(async () => ({ sessionId, userId: user.sub, username: user.username, tenantId: user.tenantId })) };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use('/api', createSessionAutomationsRouter({ store: store as never, service: service as never, sessionCatalog: sessionCatalog as never, createSession }));
  const server = await new Promise<Server>(resolve => {
    const opened = app.listen(0, '127.0.0.1', () => resolve(opened));
  });
  servers.add(server);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { baseUrl: `http://127.0.0.1:${port}/api`, store, service, createSession };
}

describe('Session automation HTTP contract', () => {
  it('uses a durable prepared session id for a new-chat command', async () => {
    const rig = await setup();
    const response = await fetch(`${rig.baseUrl}/session-automations/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'message-1' },
      body: JSON.stringify({ clientMsgId: 'message-1', sessionId: null, rawCommand: '/goal -- done' }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'created', sessionId, automation: { automationId }, cursor: '1' });
    expect(rig.store.prepareCommandSession).toHaveBeenCalledWith(expect.objectContaining({ clientMessageId: 'message-1' }));
    expect(rig.createSession).toHaveBeenCalledWith(expect.anything(), sessionId);
    expect(rig.service.command).toHaveBeenCalledWith(expect.objectContaining({ sessionId }), expect.objectContaining({ command: '/goal -- done' }));
  });

  it('returns authoritative snapshot and cursor, then streams events after that cursor', async () => {
    const rig = await setup();
    const state = await fetch(`${rig.baseUrl}/sessions/${sessionId}/automation`);
    await expect(state.json()).resolves.toMatchObject({ automation: { automationId }, cursor: '1' });
    const events = await fetch(`${rig.baseUrl}/session-automations/${automationId}/events?cursor=1`);
    await expect(events.json()).resolves.toEqual({ events: [{ eventId: 'event-1', type: 'created' }], nextCursor: '1' });
    expect(rig.store.listEvents).toHaveBeenLastCalledWith(user.tenantId, sessionId, automationId, '1');
  });

  it('maps run_now and edit through the global fenced control endpoint', async () => {
    const rig = await setup();
    const base = { clientMsgId: 'control-1', expectedControlVersion: 1, expectedIncarnationId: snapshot.incarnationId };
    const run = await fetch(`${rig.baseUrl}/session-automations/${automationId}/control`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...base, action: 'run_now' }),
    });
    expect(run.status).toBe(200);
    expect(rig.service.control).toHaveBeenCalledWith(expect.anything(), automationId, expect.objectContaining({ action: 'run' }));
    const edit = await fetch(`${rig.baseUrl}/session-automations/${automationId}/control`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...base, clientMsgId: 'control-2', action: 'edit', payload: { condition: 'new' } }),
    });
    expect(edit.status).toBe(200);
    expect(rig.service.edit).toHaveBeenCalledWith(expect.anything(), automationId, expect.objectContaining({ payload: { condition: 'new' } }));
  });

  it('hides a global automation owned by another user before service invocation', async () => {
    const rig = await setup('user-b');
    const response = await fetch(`${rig.baseUrl}/session-automations/${automationId}/control`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientMsgId: 'x', action: 'pause', expectedControlVersion: 1, expectedIncarnationId: snapshot.incarnationId }),
    });
    expect(response.status).toBe(404);
    expect(rig.service.control).not.toHaveBeenCalled();
    expect(rig.service.edit).not.toHaveBeenCalled();
  });
});

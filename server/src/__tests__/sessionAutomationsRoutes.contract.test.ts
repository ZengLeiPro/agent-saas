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
    markCommandFileReady: vi.fn(async () => undefined),
    compensateCommand: vi.fn(async () => ({sessionMetaCreated:true})),
    getCommandReceipt: vi.fn(async () => undefined as {clientMessageId:string;sessionId:string;commandDigest:string;canonicalRequest:object;state:string;automationId:string;response:{result:string;snapshot:typeof snapshot};cursor:string}|undefined),
    getSessionAutomationView: vi.fn(async () => ({snapshot:{...snapshot,ownerUserId},cursor:'1'})),
    latestEventCursor: vi.fn(async () => '1'),
    listEvents: vi.fn(async () => ({ events: [{ eventId: 'event-1', type: 'created' }], nextCursor: '1' })),
    list: vi.fn(async () => [{ ...snapshot, ownerUserId }]),
    get: vi.fn(async () => ({ ...snapshot, ownerUserId })),
    getByAutomationId: vi.fn(async () => ({ ...snapshot, ownerUserId })),
  };
  const service = {
    command: vi.fn(async () => ({ result: 'created', snapshot, cursor: '1' })),
    control: vi.fn(async () => ({ result: 'updated', snapshot })),
    edit: vi.fn(async () => ({ result: 'updated', snapshot })),
  };
  const createSession = vi.fn(async () => ({ tenantId: user.tenantId, ownerUserId: user.sub, sessionId, sessionMetaCreated:true }));
  const compensateSession = vi.fn(async () => true);
  const sessionCatalog = { get: vi.fn(async () => ({ sessionId, userId: user.sub, username: user.username, tenantId: user.tenantId })) };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  const resolveAttachments=vi.fn(async (_sessionId:string,_clientMessageId:string,ids:string[])=>ids.map(attachmentId=>({attachmentId,originalName:'证据.txt',size:8,mimeType:'text/plain',isImage:false})));
  const releaseAttachments=vi.fn(async()=>undefined);
  app.use('/api', createSessionAutomationsRouter({ store: store as never, service: service as never, sessionCatalog: sessionCatalog as never, createSession, compensateSession, resolveAttachments, releaseAttachments }));
  const server = await new Promise<Server>(resolve => {
    const opened = app.listen(0, '127.0.0.1', () => resolve(opened));
  });
  servers.add(server);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { baseUrl: `http://127.0.0.1:${port}/api`, store, service, createSession, compensateSession, resolveAttachments, releaseAttachments };
}

describe('Session automation HTTP contract and creation recovery', () => {
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
    expect(rig.store.markCommandFileReady).toHaveBeenCalled();
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

  it('resolves owned attachments into the automation spec and scopes command receipts to the authenticated owner', async () => {
    const rig=await setup();
    const accepted=await fetch(`${rig.baseUrl}/session-automations/commands`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientMsgId:'with-file',rawCommand:'/goal -- done',attachments:[{attachmentId:'attachment-a'}]})});
    expect(accepted.status).toBe(200);
    expect(rig.resolveAttachments).toHaveBeenCalledWith(sessionId,'with-file',['attachment-a']);
    expect(rig.service.command).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({attachments:[expect.objectContaining({attachmentId:'attachment-a',originalName:'证据.txt'})]}));
    rig.store.getCommandReceipt.mockResolvedValueOnce({clientMessageId:'message-1',sessionId,commandDigest:'digest',canonicalRequest:{},state:'committed',automationId,response:{result:'created',snapshot},cursor:'1'});
    const receipt=await fetch(`${rig.baseUrl}/session-automations/commands/message-1`);
    expect(receipt.status).toBe(200);
    await expect(receipt.json()).resolves.toMatchObject({state:'committed',sessionId,cursor:'1'});
    rig.store.getCommandReceipt.mockResolvedValueOnce(undefined as never);
    expect((await fetch(`${rig.baseUrl}/session-automations/commands/other-owner`)).status).toBe(404);
  });

  it('replays a committed attachment command before resolving or compensating attachments', async () => {
    const rig=await setup();
    const body={clientMsgId:'replay-file',rawCommand:'/goal -- done',attachments:[{attachmentId:'attachment-a'}]};
    const canonical={command:'/goal -- done',sessionId:null,expectedControlVersion:null,expectedIncarnationId:null,attachments:['attachment-a']};
    const { commandDigest }=await import('../runtime/sessionAutomationStore.js');
    rig.store.getCommandReceipt.mockResolvedValueOnce({clientMessageId:'replay-file',sessionId,commandDigest:commandDigest(canonical),canonicalRequest:canonical,state:'committed',automationId,response:{result:'created',snapshot},cursor:'9'});
    const response=await fetch(`${rig.baseUrl}/session-automations/commands`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    expect(response.status).toBe(200);await expect(response.json()).resolves.toMatchObject({status:'idempotent_replay',replayed:true,cursor:'9'});
    expect(rig.resolveAttachments).not.toHaveBeenCalled();expect(rig.compensateSession).not.toHaveBeenCalled();expect(rig.service.command).not.toHaveBeenCalled();
  });

  it('releases the exact attachment binding when command persistence fails', async () => {
    const rig=await setup();rig.service.command.mockRejectedValueOnce(new Error('pg failed'));
    const response=await fetch(`${rig.baseUrl}/session-automations/commands`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientMsgId:'failed-file',rawCommand:'/goal -- done',attachments:[{attachmentId:'attachment-a'}]})});
    expect(response.status).toBe(500);
    expect(rig.releaseAttachments).toHaveBeenCalledWith(sessionId,'failed-file',[expect.objectContaining({attachmentId:'attachment-a'})]);
    expect(rig.compensateSession).toHaveBeenCalledWith(expect.anything(),sessionId);
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

  it('compensates exact intent-owned metadata even when mark file_ready never persisted its creation bit', async () => {
    const rig=await setup();
    rig.store.markCommandFileReady.mockRejectedValueOnce(new Error('pg write failed'));
    rig.store.compensateCommand.mockResolvedValueOnce({sessionMetaCreated:false});
    const response=await fetch(`${rig.baseUrl}/session-automations/commands`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientMsgId:'mark-failed',rawCommand:'/goal -- done'})});
    expect(response.status).toBe(500);
    expect(rig.store.compensateCommand).toHaveBeenCalledWith(expect.objectContaining({clientMessageId:'mark-failed',sessionId}));
    expect(rig.compensateSession).toHaveBeenCalledWith(expect.anything(),sessionId);
    expect(rig.service.command).not.toHaveBeenCalled();
  });

  it('persists a stable compensated failure and deletes only intent-owned orphan metadata after file_ready', async () => {
    const rig=await setup();
    rig.service.command.mockRejectedValueOnce(Object.assign(new Error('governance denied'),{code:'GOVERNANCE_DENIED'}));
    const response=await fetch(`${rig.baseUrl}/session-automations/commands`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientMsgId:'denied',rawCommand:'/goal -- done'})});
    expect(response.status).toBe(500);
    expect(rig.store.compensateCommand).toHaveBeenCalledWith(expect.objectContaining({clientMessageId:'denied',sessionId}));
    expect(rig.compensateSession).toHaveBeenCalledWith(expect.anything(),sessionId);
  });

  it('rejects owner-supplied reconcile before invoking the command service', async () => {
    const rig=await setup();
    const body={clientMsgId:'fake-receipt',action:'reconcile',expectedControlVersion:1,expectedIncarnationId:snapshot.incarnationId,reconciliation:{providerAttemptId:'p',receiptKey:'forged',observedState:'completed',receiptPayload:{}}};
    expect((await fetch(`${rig.baseUrl}/session-automations/${automationId}/control`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).status).toBe(400);
    expect((await fetch(`${rig.baseUrl}/sessions/${sessionId}/automations/${automationId}/control`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body,clientMessageId:'fake-nested'})})).status).toBe(400);
    expect(rig.service.control).not.toHaveBeenCalled();
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

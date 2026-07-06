import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDingtalkSessionRouter } from '../channels/dingtalk/protocol/sessionRouter.js';
import { appendLoginLog, queryLoginLogs } from '../data/login-logs/store.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';

const servers: Server[] = [];
const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('platform admin tenant slicing', () => {
  it('DingTalk sessions hide other tenants and legacy unowned sessions from org admin', async () => {
    const sendMessage = vi.fn(async () => undefined);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { sub: 'u-wain-admin', username: 'wain_admin', role: 'admin', tenantId: 'wain' };
      next();
    });
    app.use('/api/dingtalk', createDingtalkSessionRouter({
      sessionService: {
        loadSessions: () => ({
          c_wain: {
            agentSessionId: 's-wain',
            senderNick: 'Wain',
            senderId: 'staff-wain',
            conversationType: '1',
            lastUpdated: 1,
            lastUpdatedAt: '2026-07-06 10:00:00',
            createdAt: '2026-07-06 10:00:00',
            messageCount: 1,
            sessionWebhook: 'https://example.com/wain',
            tenantId: 'wain',
            userId: 'u-wain',
          },
          c_kaiyan: {
            agentSessionId: 's-kaiyan',
            senderNick: 'Kaiyan',
            senderId: 'staff-kaiyan',
            conversationType: '1',
            lastUpdated: 2,
            lastUpdatedAt: '2026-07-06 10:00:00',
            createdAt: '2026-07-06 10:00:00',
            messageCount: 1,
            sessionWebhook: 'https://example.com/kaiyan',
            tenantId: 'kaiyan',
            userId: 'u-kaiyan',
          },
          c_legacy: {
            agentSessionId: 's-legacy',
            senderNick: 'Legacy',
            senderId: 'staff-legacy',
            conversationType: '1',
            lastUpdated: 3,
            lastUpdatedAt: '2026-07-06 10:00:00',
            createdAt: '2026-07-06 10:00:00',
            messageCount: 1,
            sessionWebhook: 'https://example.com/legacy',
          },
        }),
      },
      deliveryService: { sendMessage },
    }));
    const server = await listen(app);
    const baseUrl = baseUrlOf(server);

    const list = await fetch(`${baseUrl}/api/dingtalk/sessions`);
    expect(list.status).toBe(200);
    expect((await list.json() as any).sessions.map((item: any) => item.conversationId)).toEqual(['c_wain']);

    const crossTenantTest = await fetch(`${baseUrl}/api/dingtalk/sessions/c_kaiyan/test`, { method: 'POST' });
    expect(crossTenantTest.status).toBe(404);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('login log query filters by tenantId', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'login-log-tenant-'));
    cleanupDirs.push(dir);
    const filePath = join(dir, 'login-logs.jsonl');
    await appendLoginLog({
      timestamp: '2026-07-06T10:00:00.000Z',
      event: 'login_success',
      username: 'alice',
      userId: 'u-alice',
      tenantId: 'wain',
      ip: '127.0.0.1',
      userAgent: 'test',
      channel: 'web',
    }, filePath);
    await appendLoginLog({
      timestamp: '2026-07-06T10:01:00.000Z',
      event: 'login_success',
      username: 'bob',
      userId: 'u-bob',
      tenantId: 'kaiyan',
      ip: '127.0.0.1',
      userAgent: 'test',
      channel: 'web',
    }, filePath);
    await appendLoginLog({
      timestamp: '2026-07-06T10:02:00.000Z',
      event: 'login_success',
      username: 'legacy',
      ip: '127.0.0.1',
      userAgent: 'test',
      channel: 'web',
    }, filePath);

    const result = await queryLoginLogs({ tenantId: 'wain' }, filePath);
    expect(result.entries.map((entry) => entry.username)).toEqual(['alice']);
  });

  it('DingTalk sessions remain fully visible to platform admin', async () => {
    const app = express();
    app.use((req, _res, next) => {
      req.user = { sub: 'root', username: 'admin', role: 'admin', tenantId: DEFAULT_TENANT_ID };
      next();
    });
    app.use('/api/dingtalk', createDingtalkSessionRouter({
      sessionService: {
        loadSessions: () => ({
          c_wain: {
            agentSessionId: 's-wain',
            senderNick: 'Wain',
            senderId: 'staff-wain',
            conversationType: '1',
            lastUpdated: 1,
            lastUpdatedAt: '2026-07-06 10:00:00',
            createdAt: '2026-07-06 10:00:00',
            messageCount: 1,
            tenantId: 'wain',
          },
          c_legacy: {
            agentSessionId: 's-legacy',
            senderNick: 'Legacy',
            senderId: 'staff-legacy',
            conversationType: '1',
            lastUpdated: 2,
            lastUpdatedAt: '2026-07-06 10:00:00',
            createdAt: '2026-07-06 10:00:00',
            messageCount: 1,
          },
        }),
      },
      deliveryService: { sendMessage: vi.fn(async () => undefined) },
    }));
    const server = await listen(app);
    const body = await fetch(`${baseUrlOf(server)}/api/dingtalk/sessions`).then((res) => res.json() as Promise<any>);
    expect(body.sessions.map((item: any) => item.conversationId)).toEqual(['c_legacy', 'c_wain']);
  });
});

async function listen(app: express.Express): Promise<Server> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  return server;
}

function baseUrlOf(server: Server): string {
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('failed to bind server');
  return `http://127.0.0.1:${addr.port}`;
}

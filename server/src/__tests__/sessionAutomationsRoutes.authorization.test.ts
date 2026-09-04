import express from 'express';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionAutomationsRouter } from '../routes/sessionAutomations.js';
import type { SessionAutomationCommandService } from '../runtime/sessionAutomationCommandService.js';
import type { PgSessionAutomationStore } from '../runtime/sessionAutomationStore.js';
import type { RuntimeSessionRecord, SessionCatalog } from '../runtime/sessionCatalog.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const AUTOMATION_ID = 'automation-a';
const USER = { sub: 'user-a', username: 'alice', role: 'user', tenantId: 'tenant-a' } as const;

type RouteCase = {
  name: string;
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, unknown>;
  dependency: 'list' | 'get' | 'command' | 'control';
};

const routeCases: RouteCase[] = [
  {
    name: 'list', method: 'GET', path: `/sessions/${SESSION_ID}/automations`, dependency: 'list',
  },
  {
    name: 'get', method: 'GET', path: `/sessions/${SESSION_ID}/automations/${AUTOMATION_ID}`, dependency: 'get',
  },
  {
    name: 'commands', method: 'POST', path: `/sessions/${SESSION_ID}/automations/commands`,
    body: { clientMessageId: 'message-a', command: '/automation status' }, dependency: 'command',
  },
  {
    name: 'control', method: 'POST', path: `/sessions/${SESSION_ID}/automations/${AUTOMATION_ID}/control`,
    body: {
      clientMessageId: 'message-a', action: 'pause', expectedControlVersion: 1,
      expectedIncarnationId: 'incarnation-a',
    },
    dependency: 'control',
  },
];

function session(overrides: Partial<RuntimeSessionRecord> = {}): RuntimeSessionRecord {
  return {
    sessionId: SESSION_ID,
    userId: USER.sub,
    username: USER.username,
    tenantId: USER.tenantId,
    channel: 'web',
    cwd: '/workspace',
    transcriptPath: '/workspace/session.jsonl',
    createdAt: '2026-08-30T10:00:00.000Z',
    updatedAt: '2026-08-30T10:00:00.000Z',
    ...overrides,
  };
}

async function listen(catalogResult: RuntimeSessionRecord | null) {
  const dependencies = {
    list: vi.fn(async () => [{ automationId: AUTOMATION_ID, ownerUserId: USER.sub }]),
    get: vi.fn(async () => ({ automationId: AUTOMATION_ID, ownerUserId: USER.sub })),
    command: vi.fn(async () => ({ result: 'status' as const, snapshot: null })),
    control: vi.fn(async () => ({ result: 'updated' as const, snapshot: null })),
  };
  const store = {
    list: dependencies.list,
    get: dependencies.get,
  } as unknown as PgSessionAutomationStore;
  const service = {
    command: dependencies.command,
    control: dependencies.control,
  } as unknown as SessionAutomationCommandService;
  const sessionCatalog: Pick<SessionCatalog, 'get'> = {
    get: vi.fn(async () => catalogResult),
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = USER;
    next();
  });
  app.use('/api', createSessionAutomationsRouter({ store, service, sessionCatalog }));
  const server = await new Promise<Server>(resolve => {
    const opened = app.listen(0, '127.0.0.1', () => resolve(opened));
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { server, baseUrl: `http://127.0.0.1:${port}/api`, dependencies, sessionCatalog };
}

async function request(baseUrl: string, route: RouteCase): Promise<Response> {
  return fetch(`${baseUrl}${route.path}`, {
    method: route.method,
    headers: route.body ? { 'content-type': 'application/json' } : undefined,
    body: route.body ? JSON.stringify(route.body) : undefined,
  });
}

const openServers = new Set<Server>();
async function close(server: Server): Promise<void> {
  openServers.delete(server);
  await new Promise<void>(resolve => server.close(() => resolve()));
}

afterEach(async () => {
  await Promise.all([...openServers].map(server => close(server)));
});

describe('Session automations route authorization', () => {
  it.each(routeCases)('$name allows the owning user only after session authorization', async route => {
    const opened = await listen(session());
    openServers.add(opened.server);

    const response = await request(opened.baseUrl, route);

    expect(response.status).toBe(200);
    expect(opened.sessionCatalog.get).toHaveBeenCalledWith(SESSION_ID);
    expect(opened.dependencies[route.dependency]).toHaveBeenCalledOnce();
  });

  it.each(routeCases)('$name hides other-owner, cross-tenant, and missing sessions', async route => {
    const deniedSessions = [
      session({ userId: 'user-b' }),
      session({ tenantId: 'tenant-b' }),
      null,
    ];

    for (const deniedSession of deniedSessions) {
      const opened = await listen(deniedSession);
      openServers.add(opened.server);

      const response = await request(opened.baseUrl, route);

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({ code: 'NOT_FOUND' });
      expect(opened.sessionCatalog.get).toHaveBeenCalledWith(SESSION_ID);
      expect(opened.dependencies.list).not.toHaveBeenCalled();
      expect(opened.dependencies.get).not.toHaveBeenCalled();
      expect(opened.dependencies.command).not.toHaveBeenCalled();
      expect(opened.dependencies.control).not.toHaveBeenCalled();
      await close(opened.server);
    }
  });
});

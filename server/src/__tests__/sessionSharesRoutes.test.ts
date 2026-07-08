import express from 'express';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type LoadedDeps = {
  InMemorySessionShareStore: typeof import('../data/sessionShares/store.js').InMemorySessionShareStore;
  getTranscriptPath: typeof import('../data/transcripts/store.js').getTranscriptPath;
  writeSessionMeta: typeof import('../data/transcripts/meta.js').writeSessionMeta;
  FileEventStore: typeof import('../runtime/fileEventStore.js').FileEventStore;
  getRuntimeEventLogPath: typeof import('../runtime/fileEventStore.js').getRuntimeEventLogPath;
  createSessionsRouter: typeof import('../routes/sessions.js').createSessionsRouter;
  resolveUserCwd: typeof import('../workspace/resolver.js').resolveUserCwd;
};

let deps: LoadedDeps;

const TEST_USER = {
  id: 'user-share-owner',
  username: 'alice',
  role: 'user',
  tenantId: 'kaiyan',
} as const;

const OTHER_USER = {
  id: 'user-share-other',
  username: 'bob',
  role: 'user',
  tenantId: 'kaiyan',
} as const;

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function startServer(agentCwd: string): Promise<{ server: Server; baseUrl: string; store: InstanceType<LoadedDeps['InMemorySessionShareStore']> }> {
  const store = new deps.InMemorySessionShareStore();
  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    if (!req.path.startsWith('/share/')) {
      const user = req.headers['x-test-user'] === 'other' ? OTHER_USER : TEST_USER;
      req.user = {
        sub: user.id,
        username: user.username,
        role: user.role,
        tenantId: user.tenantId,
      };
    }
    next();
  });
  app.use('/api', deps.createSessionsRouter({
    agentCwd,
    runtimeEventStoreFor: (transcriptPath) => new deps.FileEventStore(deps.getRuntimeEventLogPath(transcriptPath)),
    sessionShareStore: store,
  }));

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}`, store });
    });
  });
}

describe('session share routes', () => {
  let agentCwd = '';
  let originalHome: string | undefined;

  beforeEach(async () => {
    agentCwd = await mkdtemp(join(tmpdir(), 'session-shares-'));
    originalHome = process.env.HOME;
    process.env.HOME = agentCwd;
    vi.resetModules();
    const [
      sessionShares,
      transcriptStore,
      transcriptMeta,
      fileEventStore,
      sessionsRoute,
      workspaceResolver,
    ] = await Promise.all([
      import('../data/sessionShares/store.js'),
      import('../data/transcripts/store.js'),
      import('../data/transcripts/meta.js'),
      import('../runtime/fileEventStore.js'),
      import('../routes/sessions.js'),
      import('../workspace/resolver.js'),
    ]);
    deps = {
      InMemorySessionShareStore: sessionShares.InMemorySessionShareStore,
      getTranscriptPath: transcriptStore.getTranscriptPath,
      writeSessionMeta: transcriptMeta.writeSessionMeta,
      FileEventStore: fileEventStore.FileEventStore,
      getRuntimeEventLogPath: fileEventStore.getRuntimeEventLogPath,
      createSessionsRouter: sessionsRoute.createSessionsRouter,
      resolveUserCwd: workspaceResolver.resolveUserCwd,
    };
  });

  afterEach(async () => {
    await rm(agentCwd, { recursive: true, force: true });
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    vi.resetModules();
  });

  async function writeSharedSession(): Promise<{ sessionId: string; transcriptPath: string }> {
    const sessionId = randomUUID();
    const userCwd = deps.resolveUserCwd(agentCwd, TEST_USER);
    const transcriptPath = deps.getTranscriptPath(userCwd, sessionId, {
      tenantId: TEST_USER.tenantId,
      userId: TEST_USER.id,
    });
    await mkdir(dirname(transcriptPath), { recursive: true });
    const timestamp = new Date().toISOString();
    await deps.writeSessionMeta(transcriptPath, {
      userId: TEST_USER.id,
      username: TEST_USER.username,
      channel: 'web',
      createdAt: timestamp,
      updatedAt: timestamp,
      cwd: userCwd,
      transcriptPath,
    });
    const lines = [
      {
        type: 'user',
        sessionId,
        timestamp,
        message: { role: 'user', content: '帮我查一下订单' },
      },
      {
        type: 'assistant',
        sessionId,
        timestamp,
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '需要先读取订单数据。' },
            { type: 'tool_use', id: 'toolu_1', name: 'SearchOrders', input: { keyword: '订单' } },
          ],
        },
      },
      {
        type: 'user',
        sessionId,
        timestamp,
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: '订单 A 已完成' },
          ],
        },
      },
      {
        type: 'assistant',
        sessionId,
        timestamp,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '订单 A 已完成。' }],
        },
      },
    ];
    await writeFile(transcriptPath, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
    return { sessionId, transcriptPath };
  }

  it('creates a read-only public snapshot without filtering debug blocks', async () => {
    const { sessionId } = await writeSharedSession();
    const { server, baseUrl } = await startServer(agentCwd);
    try {
      const created = await fetch(`${baseUrl}/api/sessions/${sessionId}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ debugMode: true }),
      });
      expect(created.status).toBe(200);
      const createdJson = await created.json() as { enabled: boolean; url: string; debugMode: boolean };
      expect(createdJson.enabled).toBe(true);
      expect(createdJson.debugMode).toBe(true);
      expect(createdJson.url).toMatch(/^\/share\//);

      const token = createdJson.url.split('/').pop()!;
      const publicResponse = await fetch(`${baseUrl}/api/share/sessions/${token}`);
      expect(publicResponse.status).toBe(200);
      const publicJson = await publicResponse.json() as {
        share: { debugMode: boolean };
        detail: { blocks: Array<{ kind: string; content: string; toolName?: string }> };
      };
      expect(publicJson.share.debugMode).toBe(true);
      expect(publicJson.detail.blocks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'thinking', content: '需要先读取订单数据。' }),
          expect.objectContaining({ kind: 'tool_use', toolName: 'SearchOrders' }),
          expect.objectContaining({ kind: 'tool_result', toolName: 'SearchOrders', content: '订单 A 已完成' }),
        ]),
      );
    } finally {
      await stopServer(server);
    }
  });

  it('rejects non-owner share creation', async () => {
    const { sessionId } = await writeSharedSession();
    const { server, baseUrl } = await startServer(agentCwd);
    try {
      const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-user': 'other' },
        body: JSON.stringify({ debugMode: true }),
      });
      expect(response.status).toBe(403);
    } finally {
      await stopServer(server);
    }
  });

  it('revokes an active public share', async () => {
    const { sessionId } = await writeSharedSession();
    const { server, baseUrl } = await startServer(agentCwd);
    try {
      const created = await fetch(`${baseUrl}/api/sessions/${sessionId}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ debugMode: false }),
      });
      const createdJson = await created.json() as { url: string };
      const token = createdJson.url.split('/').pop()!;

      const revoked = await fetch(`${baseUrl}/api/sessions/${sessionId}/share`, { method: 'DELETE' });
      expect(revoked.status).toBe(200);

      const publicResponse = await fetch(`${baseUrl}/api/share/sessions/${token}`);
      expect(publicResponse.status).toBe(410);
    } finally {
      await stopServer(server);
    }
  });

  it('serves shared workspace files through the public share token', async () => {
    const { sessionId } = await writeSharedSession();
    const userCwd = deps.resolveUserCwd(agentCwd, TEST_USER);
    const relPath = 'assets/20260708/demo.html';
    await mkdir(join(userCwd, 'assets/20260708'), { recursive: true });
    await writeFile(join(userCwd, relPath), '<h1>Demo artifact</h1>');

    const { server, baseUrl } = await startServer(agentCwd);
    try {
      const created = await fetch(`${baseUrl}/api/sessions/${sessionId}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ debugMode: false }),
      });
      const createdJson = await created.json() as { url: string };
      const token = createdJson.url.split('/').pop()!;
      const fileUrl = `${baseUrl}/api/share/sessions/${token}/file?path=${encodeURIComponent(relPath)}`;

      const head = await fetch(fileUrl, { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(head.headers.get('content-length')).toBe(String('<h1>Demo artifact</h1>'.length));

      const file = await fetch(fileUrl);
      expect(file.status).toBe(200);
      expect(file.headers.get('content-type')).toContain('text/html');
      expect(await file.text()).toBe('<h1>Demo artifact</h1>');

      const blocked = await fetch(`${baseUrl}/api/share/sessions/${token}/file?path=${encodeURIComponent('../secret.txt')}`);
      expect(blocked.status).toBe(403);

      const sensitive = await fetch(`${baseUrl}/api/share/sessions/${token}/file?path=${encodeURIComponent('.env')}`);
      expect(sensitive.status).toBe(403);
    } finally {
      await stopServer(server);
    }
  });
});

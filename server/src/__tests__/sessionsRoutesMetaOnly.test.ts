import express from 'express';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSessionsRouter } from '../routes/sessions.js';
import { getTranscriptPath } from '../data/transcripts/store.js';
import { writeSessionMeta, type SessionMeta } from '../data/transcripts/meta.js';
import { FileEventStore, getRuntimeEventLogPath } from '../runtime/fileEventStore.js';
import { resolveUserCwd, type WorkspaceUser } from '../workspace/resolver.js';

const TEST_USER = {
  id: 'user-1',
  username: 'alice',
  role: 'user',
  tenantId: 'kaiyan',
} satisfies WorkspaceUser;

type SessionListResponse = {
  sessions: Array<{
    sessionId: string;
    title?: string;
    preview?: string;
    updatedAtMs: number;
  }>;
  hasMore: boolean;
};

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function startServer(agentCwd: string): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { sub: TEST_USER.id, username: TEST_USER.username, role: TEST_USER.role, tenantId: TEST_USER.tenantId };
    next();
  });
  app.use('/api', createSessionsRouter({
    agentCwd,
    runtimeEventStoreFor: (transcriptPath) => new FileEventStore(getRuntimeEventLogPath(transcriptPath)),
  }));

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

describe('sessions routes for meta-only runtime sessions', () => {
  let agentCwd = '';
  const cleanupPaths = new Set<string>();

  beforeEach(async () => {
    agentCwd = await mkdtemp(join(tmpdir(), 'sessions-meta-only-'));
    cleanupPaths.add(agentCwd);
  });

  afterEach(async () => {
    for (const target of cleanupPaths) {
      await rm(target, { recursive: true, force: true });
    }
    cleanupPaths.clear();
  });

  function userCwd(): string {
    return resolveUserCwd(agentCwd, TEST_USER);
  }

  async function writeRuntimeSession(options: {
    sessionId?: string;
    userId?: string;
    username?: string;
    content?: string;
    createdAt?: string;
    metaPatch?: Partial<SessionMeta>;
    metaMtimeMs?: number;
  } = {}): Promise<{ sessionId: string; transcriptPath: string }> {
    const sessionId = options.sessionId ?? randomUUID();
    const createdAt = options.createdAt ?? new Date().toISOString();
    const transcriptPath = getTranscriptPath(userCwd(), sessionId, {
      tenantId: TEST_USER.tenantId,
      userId: TEST_USER.id,
    });
    cleanupPaths.add(dirname(transcriptPath));

    await writeSessionMeta(transcriptPath, {
      userId: options.userId ?? TEST_USER.id,
      username: options.username ?? TEST_USER.username,
      channel: 'web',
      createdAt,
      cwd: userCwd(),
      transcriptPath,
      runtimeStatus: 'running',
      updatedAt: createdAt,
      ...options.metaPatch,
    });
    if (options.metaMtimeMs !== undefined) {
      const date = new Date(options.metaMtimeMs);
      await utimes(transcriptPath.replace(/\.jsonl$/, '.meta.json'), date, date);
    }

    if (options.content) {
      const eventStore = new FileEventStore(getRuntimeEventLogPath(transcriptPath));
      await eventStore.append({
        type: 'user_message_submitted',
        sessionId,
        runId: `${Date.now()}-${randomUUID()}`,
        userId: options.userId ?? TEST_USER.id,
        clientMsgId: randomUUID(),
        content: options.content,
      });
    }

    return { sessionId, transcriptPath };
  }

  async function listSessions(baseUrl: string, query = ''): Promise<SessionListResponse> {
    const response = await fetch(`${baseUrl}/api/sessions${query}`);
    expect(response.status).toBe(200);
    return response.json() as Promise<SessionListResponse>;
  }

  it('serves detail and stats before the legacy transcript is projected', async () => {
    const { sessionId } = await writeRuntimeSession({ content: 'hello before projection' });

    const { server, baseUrl } = await startServer(agentCwd);
    try {
      const detail = await fetch(`${baseUrl}/api/sessions/${sessionId}?silent=1`);
      expect(detail.status).toBe(200);
      const detailJson = await detail.json() as { blocks: Array<{ kind: string; content: string }> };
      expect(detailJson.blocks).toEqual([
        expect.objectContaining({ kind: 'prompt', content: 'hello before projection' }),
      ]);

      const stats = await fetch(`${baseUrl}/api/sessions/${sessionId}/stats`);
      expect(stats.status).toBe(200);
      await expect(stats.json()).resolves.toMatchObject({ tokenUsage: null });
    } finally {
      await stopServer(server);
    }
  });

  it('lists meta-only sessions before the transcript is projected', async () => {
    const { sessionId } = await writeRuntimeSession({ content: '调用浏览器skill，打开google' });

    const { server, baseUrl } = await startServer(agentCwd);
    try {
      const json = await listSessions(baseUrl, '?fresh=1');
      const listed = json.sessions.find((session) => session.sessionId === sessionId);
      expect(listed).toBeTruthy();
      expect(listed?.title).toContain('调用浏览器skill');
      expect(listed?.preview).toBe('调用浏览器skill，打开google');
    } finally {
      await stopServer(server);
    }
  });

  it('hides meta-only sessions owned by another user', async () => {
    const { sessionId } = await writeRuntimeSession({
      userId: 'user-2',
      username: 'bob',
      content: 'should not be visible',
    });

    const { server, baseUrl } = await startServer(agentCwd);
    try {
      const json = await listSessions(baseUrl, '?fresh=1');
      expect(json.sessions.some((session) => session.sessionId === sessionId)).toBe(false);
    } finally {
      await stopServer(server);
    }
  });

  it('hides deleted meta-only sessions', async () => {
    const { sessionId } = await writeRuntimeSession({
      content: 'deleted session',
      metaPatch: { deletedAt: new Date().toISOString(), deletedBy: TEST_USER.id },
    });

    const { server, baseUrl } = await startServer(agentCwd);
    try {
      const json = await listSessions(baseUrl, '?fresh=1');
      expect(json.sessions.some((session) => session.sessionId === sessionId)).toBe(false);
    } finally {
      await stopServer(server);
    }
  });

  it('blocks normal detail reads for deleted sessions but allows explicit trash preview', async () => {
    const { sessionId } = await writeRuntimeSession({
      content: 'deleted detail session',
      metaPatch: { deletedAt: new Date().toISOString(), deletedBy: TEST_USER.id },
    });

    const { server, baseUrl } = await startServer(agentCwd);
    try {
      const normalDetail = await fetch(`${baseUrl}/api/sessions/${sessionId}?silent=1`);
      expect(normalDetail.status).toBe(404);

      const trashPreview = await fetch(`${baseUrl}/api/sessions/${sessionId}?includeDeleted=1`);
      expect(trashPreview.status).toBe(200);
      const json = await trashPreview.json() as { blocks: Array<{ kind: string; content: string }> };
      expect(json.blocks).toEqual([
        expect.objectContaining({ kind: 'prompt', content: 'deleted detail session' }),
      ]);
    } finally {
      await stopServer(server);
    }
  });

  it('hides memory and heartbeat polling meta-only sessions for non-admin users', async () => {
    const memory = await writeRuntimeSession({
      content: 'memory poll',
      metaPatch: { channel: 'cron', cronJobName: '每日记忆轮询' },
    });
    const heartbeat = await writeRuntimeSession({
      content: 'heartbeat poll',
      metaPatch: { channel: 'cron', cronJobName: '服务心跳轮询' },
    });

    const { server, baseUrl } = await startServer(agentCwd);
    try {
      const json = await listSessions(baseUrl, '?fresh=1');
      expect(json.sessions.some((session) => session.sessionId === memory.sessionId)).toBe(false);
      expect(json.sessions.some((session) => session.sessionId === heartbeat.sessionId)).toBe(false);
    } finally {
      await stopServer(server);
    }
  });

  it('de-duplicates sessions that have both transcript and meta files', async () => {
    const { sessionId, transcriptPath } = await writeRuntimeSession({ content: 'metadata prompt' });
    await mkdir(dirname(transcriptPath), { recursive: true });
    await writeFile(transcriptPath, JSON.stringify({ type: 'user', message: { content: 'transcript prompt' } }) + '\n');

    const { server, baseUrl } = await startServer(agentCwd);
    try {
      const json = await listSessions(baseUrl, '?fresh=1');
      const matches = json.sessions.filter((session) => session.sessionId === sessionId);
      expect(matches).toHaveLength(1);
    } finally {
      await stopServer(server);
    }
  });

  it('sorts and paginates merged meta-only sessions', async () => {
    const older = await writeRuntimeSession({
      content: 'older prompt',
      metaMtimeMs: Date.now() - 10_000,
    });
    const newer = await writeRuntimeSession({
      content: 'newer prompt',
      metaMtimeMs: Date.now(),
    });

    const { server, baseUrl } = await startServer(agentCwd);
    try {
      const firstPage = await listSessions(baseUrl, '?fresh=1&limit=1');
      expect(firstPage.hasMore).toBe(true);
      expect(firstPage.sessions).toHaveLength(1);
      expect(firstPage.sessions[0]?.sessionId).toBe(newer.sessionId);

      const secondPage = await listSessions(baseUrl, `?fresh=1&limit=1&before=${firstPage.sessions[0]!.updatedAtMs}`);
      expect(secondPage.sessions[0]?.sessionId).toBe(older.sessionId);
    } finally {
      await stopServer(server);
    }
  });
});

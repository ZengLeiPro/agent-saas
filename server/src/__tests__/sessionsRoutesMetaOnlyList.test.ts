import express from 'express';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionsRouter, type SessionsRouterOptions } from '../routes/sessions.js';
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

async function startServer(
  agentCwd: string,
  sessionProjectionStore?: SessionsRouterOptions['sessionProjectionStore'],
): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      sub: TEST_USER.id,
      username: TEST_USER.username,
      role: TEST_USER.role,
      tenantId: TEST_USER.tenantId,
    };
    next();
  });
  app.use('/api', createSessionsRouter({
    agentCwd,
    runtimeEventStoreFor: (transcriptPath) => new FileEventStore(getRuntimeEventLogPath(transcriptPath), TEST_USER.tenantId),
    sessionProjectionStore,
  }));

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

describe('meta-only session list merging and projection', () => {
  let agentCwd = '';
  const cleanupPaths = new Set<string>();

  beforeEach(async () => {
    agentCwd = await mkdtemp(join(tmpdir(), 'sessions-meta-only-list-'));
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
    content?: string;
    metaPatch?: Partial<SessionMeta>;
    metaMtimeMs?: number;
  } = {}): Promise<{ sessionId: string; transcriptPath: string }> {
    const sessionId = randomUUID();
    const createdAt = new Date().toISOString();
    const transcriptPath = getTranscriptPath(userCwd(), sessionId, {
      tenantId: TEST_USER.tenantId,
      userId: TEST_USER.id,
    });
    cleanupPaths.add(dirname(transcriptPath));

    await writeSessionMeta(transcriptPath, {
      userId: TEST_USER.id,
      username: TEST_USER.username,
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
      const eventStore = new FileEventStore(getRuntimeEventLogPath(transcriptPath), TEST_USER.tenantId);
      await eventStore.append({
        type: 'user_message_submitted',
        sessionId,
        runId: `${Date.now()}-${randomUUID()}`,
        userId: TEST_USER.id,
        clientMsgId: randomUUID(),
        content: options.content,
      }, { tenantId: TEST_USER.tenantId });
    }
    return { sessionId, transcriptPath };
  }

  async function listSessions(baseUrl: string, query = ''): Promise<SessionListResponse> {
    const response = await fetch(`${baseUrl}/api/sessions${query}`);
    expect(response.status).toBe(200);
    return response.json() as Promise<SessionListResponse>;
  }

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

  it('hides memory consolidation sessions from the file-backed list', async () => {
    const normal = await writeRuntimeSession({ content: 'normal prompt' });
    const hidden = await writeRuntimeSession({
      content: 'memory digest',
      metaPatch: { sessionSource: 'memory_consolidation', memoryAutomationEligible: false },
    });
    const legacyHidden = await writeRuntimeSession({
      content: 'legacy memory digest',
      metaPatch: { profileBindingKey: 'memory_poll' },
    });

    const { server, baseUrl } = await startServer(agentCwd);
    try {
      const response = await listSessions(baseUrl, '?fresh=1');
      expect(response.sessions.map((session) => session.sessionId)).toContain(normal.sessionId);
      expect(response.sessions.map((session) => session.sessionId)).not.toContain(hidden.sessionId);
      expect(response.sessions.map((session) => session.sessionId)).not.toContain(legacyHidden.sessionId);
    } finally {
      await stopServer(server);
    }
  });

  it('uses the runtime session projection instead of scanning every transcript', async () => {
    const sessionId = randomUUID();
    const updatedAt = '2026-07-21T00:30:00.000Z';
    const list = vi.fn(async () => ({
      items: [{
        sessionId: randomUUID(),
        tenantId: TEST_USER.tenantId,
        userId: TEST_USER.id,
        username: TEST_USER.username,
        channel: 'web',
        kind: 'user' as const,
        createdAt: updatedAt,
        updatedAt,
        metaJson: {
          userId: TEST_USER.id,
          username: TEST_USER.username,
          tenantId: TEST_USER.tenantId,
          channel: 'web',
          createdAt: updatedAt,
          updatedAt,
          sessionSource: 'memory_consolidation' as const,
          memoryAutomationEligible: false,
        },
      }, {
        sessionId,
        tenantId: TEST_USER.tenantId,
        userId: TEST_USER.id,
        username: TEST_USER.username,
        channel: 'web',
        kind: 'user' as const,
        title: '投影会话',
        createdAt: updatedAt,
        updatedAt,
        metaJson: {
          userId: TEST_USER.id,
          username: TEST_USER.username,
          tenantId: TEST_USER.tenantId,
          channel: 'web',
          createdAt: updatedAt,
          updatedAt,
          customTitle: '投影会话',
        },
      }],
    }));

    const { server, baseUrl } = await startServer(agentCwd, { list });
    try {
      const response = await listSessions(baseUrl, '?fresh=1&limit=50');
      expect(response.sessions).toEqual([
        expect.objectContaining({ sessionId, title: '投影会话' }),
      ]);
      expect(list).toHaveBeenCalledWith(expect.objectContaining({
        tenantId: TEST_USER.tenantId,
        userId: TEST_USER.id,
        kind: 'user',
        includeDeleted: false,
      }));
    } finally {
      await stopServer(server);
    }
  });
});

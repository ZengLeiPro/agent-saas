import express from 'express';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GroupStore } from '../data/groups/index.js';
import { getTranscriptPath } from '../data/transcripts/store.js';
import { writeSessionMeta } from '../data/transcripts/meta.js';
import { createGroupsRouter } from '../routes/groups.js';

const TEST_USER = {
  id: 'user-1',
  username: 'alice',
  role: 'user',
  tenantId: 'kaiyan',
} as const;

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function startServer(
  agentCwd: string,
  groupStore: GroupStore,
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
  app.use('/api', createGroupsRouter({ groupStore, agentCwd }));

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

describe('groups routes', () => {
  let agentCwd = '';
  let groupStore: GroupStore;
  const cleanupPaths = new Set<string>();

  beforeEach(async () => {
    agentCwd = await mkdtemp(join(tmpdir(), 'groups-routes-'));
    cleanupPaths.add(agentCwd);
    groupStore = new GroupStore(join(agentCwd, 'groups.json'));
  });

  afterEach(async () => {
    for (const target of cleanupPaths) {
      await rm(target, { recursive: true, force: true });
    }
    cleanupPaths.clear();
  });

  async function writeTranscriptSession(options: {
    title: string;
    deleted?: boolean;
  }): Promise<{ sessionId: string; transcriptPath: string }> {
    const sessionId = randomUUID();
    const transcriptPath = getTranscriptPath(agentCwd, sessionId);
    cleanupPaths.add(dirname(transcriptPath));
    await mkdir(dirname(transcriptPath), { recursive: true });
    await writeFile(
      transcriptPath,
      JSON.stringify({
        type: 'user',
        sessionId,
        timestamp: new Date().toISOString(),
        message: { content: [{ type: 'text', text: options.title }] },
      }) + '\n',
    );
    await writeSessionMeta(transcriptPath, {
      userId: TEST_USER.id,
      username: TEST_USER.username,
      channel: 'web',
      createdAt: new Date().toISOString(),
      cwd: agentCwd,
      transcriptPath,
      ...(options.deleted
        ? { deletedAt: new Date().toISOString(), deletedBy: TEST_USER.username }
        : {}),
    });
    return { sessionId, transcriptPath };
  }

  it('excludes soft-deleted sessions from group session lists', async () => {
    const visible = await writeTranscriptSession({ title: 'visible session' });
    const deleted = await writeTranscriptSession({
      title: 'deleted session',
      deleted: true,
    });
    const group = await groupStore.create({
      name: 'Work',
      userId: TEST_USER.id,
      sessionIds: [visible.sessionId, deleted.sessionId],
    });

    const { server, baseUrl } = await startServer(agentCwd, groupStore);
    try {
      const response = await fetch(`${baseUrl}/api/groups/${group.id}/sessions`);
      expect(response.status).toBe(200);
      const json = await response.json() as { sessions: Array<{ sessionId: string }> };
      expect(json.sessions.map((session) => session.sessionId)).toEqual([
        visible.sessionId,
      ]);
    } finally {
      await stopServer(server);
    }
  });
});

import express from 'express';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTranscriptPath } from '../data/transcripts/store.js';
import { writeSessionMeta } from '../data/transcripts/meta.js';
import { createSessionsRouter } from '../routes/sessions.js';
import { resolveUserCwd, type WorkspaceUser } from '../workspace/resolver.js';

const TEST_USER = {
  id: 'user-1',
  username: 'alice',
  role: 'user',
  tenantId: 'kaiyan',
} satisfies WorkspaceUser;

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function startServer(agentCwd: string, sandboxWarmup: (sessionId: string) => void) {
  const app = express();
  app.use((req, _res, next) => {
    req.user = {
      sub: TEST_USER.id,
      username: TEST_USER.username,
      role: TEST_USER.role,
      tenantId: TEST_USER.tenantId,
    };
    next();
  });
  app.use('/api', createSessionsRouter({ agentCwd, sandboxWarmup }));

  return new Promise<{ server: Server; baseUrl: string }>((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

describe('session Sandbox warmup routes', () => {
  let agentCwd = '';

  beforeEach(async () => {
    agentCwd = await mkdtemp(join(tmpdir(), 'session-warmup-routes-'));
  });

  afterEach(async () => {
    await rm(agentCwd, { recursive: true, force: true });
  });

  async function writeRuntimeSession(owner: { id: string; username: string } = TEST_USER) {
    const sessionId = randomUUID();
    const cwd = resolveUserCwd(agentCwd, TEST_USER);
    const transcriptPath = getTranscriptPath(cwd, sessionId, {
      tenantId: TEST_USER.tenantId,
      userId: TEST_USER.id,
    });
    const createdAt = new Date().toISOString();
    await writeSessionMeta(transcriptPath, {
      userId: owner.id,
      username: owner.username,
      channel: 'web',
      createdAt,
      cwd,
      transcriptPath,
      runtimeStatus: 'running',
      updatedAt: createdAt,
    });
    return sessionId;
  }

  it('silent and non-silent detail reads never trigger warmup', async () => {
    const sessionId = await writeRuntimeSession();
    const sandboxWarmup = vi.fn();
    const { server, baseUrl } = await startServer(agentCwd, sandboxWarmup);

    try {
      expect((await fetch(`${baseUrl}/api/sessions/${sessionId}`)).status).toBe(200);
      expect((await fetch(`${baseUrl}/api/sessions/${sessionId}?silent=1`)).status).toBe(200);
      expect(sandboxWarmup).not.toHaveBeenCalled();
    } finally {
      await stopServer(server);
    }
  });

  it('authorized warmup requests return 202 and invoke the service once', async () => {
    const sessionId = await writeRuntimeSession();
    const sandboxWarmup = vi.fn();
    const { server, baseUrl } = await startServer(agentCwd, sandboxWarmup);

    try {
      const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/warmup`, { method: 'POST' });
      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toEqual({ status: 'accepted' });
      expect(sandboxWarmup).toHaveBeenCalledOnce();
      expect(sandboxWarmup).toHaveBeenCalledWith(sessionId);
    } finally {
      await stopServer(server);
    }
  });

  it('does not allow another user session to be warmed up', async () => {
    const sessionId = await writeRuntimeSession({ id: 'user-2', username: 'bob' });
    const sandboxWarmup = vi.fn();
    const { server, baseUrl } = await startServer(agentCwd, sandboxWarmup);

    try {
      const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/warmup`, { method: 'POST' });
      expect(response.status).toBe(403);
      expect(sandboxWarmup).not.toHaveBeenCalled();
    } finally {
      await stopServer(server);
    }
  });
});

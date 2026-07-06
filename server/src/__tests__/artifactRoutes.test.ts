import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';

import { createArtifactsRouter } from '../routes/artifacts.js';
import { InMemoryArtifactStore, LocalArtifactBlobStore } from '../runtime/artifactStore.js';
import { ArtifactService, type RuntimeArtifactUser } from '../runtime/artifactService.js';
import { getTranscriptPath } from '../data/transcripts/store.js';
import { writeSessionMeta } from '../data/transcripts/meta.js';

const SESSION_ID = '11111111-2222-4333-8444-555555555555';

async function startServer(service: ArtifactService, user?: RuntimeArtifactUser): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = user;
    next();
  });
  app.use('/api', createArtifactsRouter({ artifactService: service, defaultReadUrlTtlSeconds: 60 }));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('artifact routes', () => {
  let agentCwd = '';
  let blobRoot = '';
  let service: ArtifactService;
  const cleanupPaths = new Set<string>();

  beforeEach(async () => {
    agentCwd = await mkdtemp(join(tmpdir(), 'artifact-agent-'));
    blobRoot = await mkdtemp(join(tmpdir(), 'artifact-blob-'));
    cleanupPaths.add(agentCwd);
    cleanupPaths.add(blobRoot);
    service = new ArtifactService({
      artifactStore: new InMemoryArtifactStore(),
      blobStore: new LocalArtifactBlobStore({ rootDir: blobRoot }),
      agentCwd,
      signingSecret: 'test-artifact-signing-secret',
    });
    // 多组织路径布局：<agentCwd>/<tenantSlug>/<userId>/
    const transcriptPath = getTranscriptPath(join(agentCwd, 'kaiyan', 'user-1'), SESSION_ID);
    cleanupPaths.add(dirname(transcriptPath));
    await writeSessionMeta(transcriptPath, {
      userId: 'user-1',
      username: 'alice',
      channel: 'web',
      createdAt: new Date().toISOString(),
    });
  });

  afterEach(async () => {
    for (const target of cleanupPaths) {
      await rm(target, { recursive: true, force: true });
    }
    cleanupPaths.clear();
  });

  it('creates, lists, signs, and reads an artifact for the session owner', async () => {
    const { server, baseUrl } = await startServer(service, { sub: 'user-1', username: 'alice', role: 'user', tenantId: 'kaiyan' });
    try {
      const create = await fetch(`${baseUrl}/api/sessions/${SESSION_ID}/artifacts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: 'hello artifact',
          fileName: 'hello.txt',
          mimeType: 'text/plain',
          kind: 'file',
        }),
      });
      expect(create.status).toBe(201);
      const created = await create.json() as { artifact: { artifactId: string } };

      const list = await fetch(`${baseUrl}/api/sessions/${SESSION_ID}/artifacts`);
      expect(list.status).toBe(200);
      const listed = await list.json() as { artifacts: Array<{ artifactId: string }> };
      expect(listed.artifacts.map((artifact) => artifact.artifactId)).toEqual([created.artifact.artifactId]);

      const readUrl = await fetch(`${baseUrl}/api/artifacts/${created.artifact.artifactId}/read-url?expiresInSeconds=60`);
      expect(readUrl.status).toBe(200);
      const signed = await readUrl.json() as { url: string; direct: boolean };
      expect(signed.direct).toBe(false);

      const content = await fetch(signed.url);
      expect(content.status).toBe(200);
      await expect(content.text()).resolves.toBe('hello artifact');
    } finally {
      await stopServer(server);
    }
  });

  it('serves signed artifact content with non-ASCII filenames', async () => {
    const { server, baseUrl } = await startServer(service, { sub: 'user-1', username: 'alice', role: 'user', tenantId: 'kaiyan' });
    try {
      const create = await fetch(`${baseUrl}/api/sessions/${SESSION_ID}/artifacts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: '中文 artifact',
          fileName: '客户交付前AI助手验收报告.md',
          mimeType: 'text/markdown',
          kind: 'file',
        }),
      });
      expect(create.status).toBe(201);
      const created = await create.json() as { artifact: { artifactId: string } };

      const readUrl = await fetch(`${baseUrl}/api/artifacts/${created.artifact.artifactId}/read-url?expiresInSeconds=60`);
      expect(readUrl.status).toBe(200);
      const signed = await readUrl.json() as { url: string };

      const content = await fetch(signed.url);
      expect(content.status).toBe(200);
      expect(content.headers.get('content-disposition')).toContain("filename*=UTF-8''%E5%AE%A2%E6%88%B7");
      await expect(content.text()).resolves.toBe('中文 artifact');
    } finally {
      await stopServer(server);
    }
  });

  it('hides artifacts from users who do not own the session', async () => {
    const artifact = await service.createFromBytes({
      sessionId: SESSION_ID,
      data: 'private',
      fileName: 'private.txt',
    });
    const { server, baseUrl } = await startServer(service, { sub: 'user-2', username: 'bob', role: 'user', tenantId: 'kaiyan' });
    try {
      const res = await fetch(`${baseUrl}/api/artifacts/${artifact.artifactId}`);
      expect(res.status).toBe(404);
    } finally {
      await stopServer(server);
    }
  });

  it('rejects invalid signed artifact content tokens', async () => {
    const artifact = await service.createFromBytes({
      sessionId: SESSION_ID,
      data: 'private',
      fileName: 'private.txt',
    });
    const { server, baseUrl } = await startServer(service);
    try {
      const res = await fetch(`${baseUrl}/api/artifacts/${artifact.artifactId}/content?token=bad`);
      expect(res.status).toBe(401);
    } finally {
      await stopServer(server);
    }
  });
});

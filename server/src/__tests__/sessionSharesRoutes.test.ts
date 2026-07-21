import express from 'express';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type LoadedDeps = {
  InMemorySessionShareStore: typeof import('../data/sessionShares/store.js').InMemorySessionShareStore;
  projectSessionShareSnapshot: typeof import('../data/sessionShares/publicProjection.js').projectSessionShareSnapshot;
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
      sessionShareProjection,
      transcriptStore,
      transcriptMeta,
      fileEventStore,
      sessionsRoute,
      workspaceResolver,
    ] = await Promise.all([
      import('../data/sessionShares/store.js'),
      import('../data/sessionShares/publicProjection.js'),
      import('../data/transcripts/store.js'),
      import('../data/transcripts/meta.js'),
      import('../runtime/fileEventStore.js'),
      import('../routes/sessions.js'),
      import('../workspace/resolver.js'),
    ]);
    deps = {
      InMemorySessionShareStore: sessionShares.InMemorySessionShareStore,
      projectSessionShareSnapshot: sessionShareProjection.projectSessionShareSnapshot,
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

  async function writeSharedSession(options: { includeFileMarkers?: boolean; sensitiveContent?: string } = {}): Promise<{ sessionId: string; transcriptPath: string }> {
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
        message: { role: 'user', content: options.sensitiveContent ?? '帮我查一下订单' },
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
          content: [{
            type: 'text',
            text: options.includeFileMarkers
              ? '订单 A 已完成。\n[FILE]{"filePath":"assets/20260708/demo.html"}[/FILE]\n[FILE]{"filePath":"assets/20260708/demo.pdf"}[/FILE]\n[FILE]{"filePath":"assets/20260708/escape.txt"}[/FILE]'
              : '订单 A 已完成。',
          }],
        },
      },
    ];
    await writeFile(transcriptPath, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
    return { sessionId, transcriptPath };
  }

  it('公开快照只保留对话正文并强制关闭调试细节', async () => {
    const { sessionId } = await writeSharedSession();
    const { server, baseUrl } = await startServer(agentCwd);
    try {
      const created = await fetch(`${baseUrl}/api/sessions/${sessionId}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmPublicText: true, filePaths: [] }),
      });
      expect(created.status).toBe(200);
      const createdJson = await created.json() as { enabled: boolean; url: string; debugMode: boolean };
      expect(createdJson.enabled).toBe(true);
      expect(createdJson.debugMode).toBe(false);
      expect(createdJson.url).toMatch(/^\/share\//);

      const token = createdJson.url.split('/').pop()!;
      const publicResponse = await fetch(`${baseUrl}/api/share/sessions/${token}`);
      expect(publicResponse.status).toBe(200);
      const publicJson = await publicResponse.json() as {
        share: { debugMode: boolean };
        detail: {
          sessionId: string;
          owner?: { userId: string; username: string; realName?: string };
          source?: unknown;
          blocks: Array<Record<string, unknown> & { kind: string; content: string }>;
          lastRunState?: unknown;
        };
      };
      expect(publicJson.share.debugMode).toBe(false);
      expect(publicJson.detail.sessionId).toBe('shared-session');
      expect(publicJson.detail.owner).toEqual({
        userId: 'shared-user',
        username: '用户',
        realName: '用户',
      });
      expect(publicJson.detail).not.toHaveProperty('source');
      expect(publicJson.detail.blocks.map((block) => block.kind)).toEqual(['prompt', 'text']);
      expect(publicJson.detail.blocks.map((block) => block.content)).toEqual([
        '帮我查一下订单',
        '订单 A 已完成。',
      ]);
      for (const block of publicJson.detail.blocks) {
        expect(block).not.toHaveProperty('raw');
        expect(block).not.toHaveProperty('toolName');
        expect(block).not.toHaveProperty('toolId');
        expect(block).not.toHaveProperty('runId');
      }
      expect(publicJson.detail).not.toHaveProperty('lastRunState');
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
        body: JSON.stringify({ confirmPublicText: true, filePaths: [] }),
      });
      expect(response.status).toBe(403);
    } finally {
      await stopServer(server);
    }
  });

  it('强制正文确认，并把有效期限制为默认 7 天、最长 30 天', async () => {
    const { sessionId } = await writeSharedSession();
    const { server, baseUrl } = await startServer(agentCwd);
    try {
      const missingConfirmation = await fetch(`${baseUrl}/api/sessions/${sessionId}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePaths: [] }),
      });
      expect(missingConfirmation.status).toBe(400);

      const before = Date.now();
      const created = await fetch(`${baseUrl}/api/sessions/${sessionId}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmPublicText: true, filePaths: [] }),
      });
      expect(created.status).toBe(200);
      const createdJson = await created.json() as { expiresAt: string };
      const ttl = Date.parse(createdJson.expiresAt) - before;
      expect(ttl).toBeGreaterThanOrEqual(7 * 24 * 60 * 60 * 1_000 - 2_000);
      expect(ttl).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1_000 + 2_000);

      const tooLong = await fetch(`${baseUrl}/api/sessions/${sessionId}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirmPublicText: true,
          filePaths: [],
          expiresAt: new Date(Date.now() + 31 * 24 * 60 * 60 * 1_000).toISOString(),
        }),
      });
      expect(tooLong.status).toBe(400);
    } finally {
      await stopServer(server);
    }
  });

  it('正文包含凭据或个人敏感信息时拒绝创建匿名分享', async () => {
    const { sessionId } = await writeSharedSession({ sensitiveContent: '请联系 13800138000' });
    const { server, baseUrl } = await startServer(agentCwd);
    try {
      const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmPublicText: true, filePaths: [] }),
      });
      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({ code: 'SESSION_SHARE_SENSITIVE_CONTENT' });
    } finally {
      await stopServer(server);
    }
  });

  it('正文包含内部运行标识、真实错误码或技术归因时 fail closed', async () => {
    const diagnosticContents = [
      'runId=run_01HXYZ',
      'request ID: req_01HXYZ',
      'tenantId=tenant-kaiyan',
      '错误码：E_PROVIDER_502',
      'E_PROVIDER_502',
      'PROVIDER_BAD_GATEWAY',
      'UPSTREAM_TIMEOUT',
      '请求失败，HTTP 502',
      'ERROR_GATEWAY_TIMEOUT',
      '上游模型返回失败',
    ];
    const sessions = await Promise.all(
      diagnosticContents.map(async (sensitiveContent) => writeSharedSession({ sensitiveContent })),
    );
    const { server, baseUrl } = await startServer(agentCwd);
    try {
      for (const { sessionId } of sessions) {
        const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/share`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirmPublicText: true, filePaths: [] }),
        });
        expect(response.status).toBe(422);
        await expect(response.json()).resolves.toMatchObject({
          code: 'SESSION_SHARE_SENSITIVE_CONTENT',
        });
      }
    } finally {
      await stopServer(server);
    }
  });

  it('旧快照的标题也必须经过诊断信息门禁', () => {
    expect(() => deps.projectSessionShareSnapshot({
      sessionId: 'private-session',
      stats: { lines: 1, parsedLines: 1, parseErrors: 0 },
      blocks: [{
        id: 'block-1',
        kind: 'text',
        title: '失败详情 requestId=req_01HXYZ',
        defaultOpen: true,
        content: '请稍后重试',
      }],
    })).toThrow('内部运行标识');
  });

  it('revokes an active public share', async () => {
    const { sessionId } = await writeSharedSession();
    const { server, baseUrl } = await startServer(agentCwd);
    try {
      const created = await fetch(`${baseUrl}/api/sessions/${sessionId}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmPublicText: true, filePaths: [] }),
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

  it('只允许读取快照显式引用且未越出工作区的文件', async () => {
    const { sessionId } = await writeSharedSession({ includeFileMarkers: true });
    const userCwd = deps.resolveUserCwd(agentCwd, TEST_USER);
    const relPath = 'assets/20260708/demo.html';
    const pdfRelPath = 'assets/20260708/demo.pdf';
    await mkdir(join(userCwd, 'assets/20260708'), { recursive: true });
    await writeFile(join(userCwd, relPath), '<h1>Demo artifact</h1>');
    await writeFile(join(userCwd, pdfRelPath), 'PDF_BYTES');
    await writeFile(join(userCwd, 'assets/20260708/private.txt'), 'PRIVATE');
    const outsideFile = join(agentCwd, 'outside-secret.txt');
    await writeFile(outsideFile, 'OUTSIDE_SECRET');
    await symlink(outsideFile, join(userCwd, 'assets/20260708/escape.txt'));

    const { server, baseUrl } = await startServer(agentCwd);
    try {
      const created = await fetch(`${baseUrl}/api/sessions/${sessionId}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirmPublicText: true,
          filePaths: [relPath, pdfRelPath],
        }),
      });
      const createdJson = await created.json() as { url: string };
      const token = createdJson.url.split('/').pop()!;
      const publicShare = await fetch(`${baseUrl}/api/share/sessions/${token}`);
      expect(publicShare.status).toBe(200);
      const publicShareJson = await publicShare.json() as {
        detail: { allowedFiles: Array<Record<string, unknown>> };
      };
      expect(publicShareJson.detail.allowedFiles).toHaveLength(2);
      for (const publicFile of publicShareJson.detail.allowedFiles) {
        expect(publicFile).not.toHaveProperty('sha256');
        expect(publicFile).not.toHaveProperty('contentBase64');
      }
      const fileUrl = `${baseUrl}/api/share/sessions/${token}/file?path=${encodeURIComponent(relPath)}`;

      const head = await fetch(fileUrl, { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(head.headers.get('content-length')).toBe(String('<h1>Demo artifact</h1>'.length));

      const file = await fetch(fileUrl);
      expect(file.status).toBe(200);
      expect(file.headers.get('content-type')).toContain('text/html');
      expect(await file.text()).toBe('<h1>Demo artifact</h1>');

      await writeFile(join(userCwd, relPath), '<h1>Overwritten after sharing</h1>');
      const immutableFile = await fetch(fileUrl);
      expect(await immutableFile.text()).toBe('<h1>Demo artifact</h1>');

      const pdfUrl = `${baseUrl}/api/share/sessions/${token}/file?path=${encodeURIComponent(pdfRelPath)}`;
      const inlinePdf = await fetch(pdfUrl, { method: 'HEAD' });
      expect(inlinePdf.status).toBe(200);
      expect(inlinePdf.headers.get('content-disposition')).toMatch(/^inline;/);

      const forcedDownload = await fetch(`${pdfUrl}&download=1`, { method: 'HEAD' });
      expect(forcedDownload.status).toBe(200);
      expect(forcedDownload.headers.get('content-disposition')).toMatch(/^attachment;/);

      const blocked = await fetch(`${baseUrl}/api/share/sessions/${token}/file?path=${encodeURIComponent('../secret.txt')}`);
      expect(blocked.status).toBe(403);

      const sensitive = await fetch(`${baseUrl}/api/share/sessions/${token}/file?path=${encodeURIComponent('.env')}`);
      expect(sensitive.status).toBe(403);

      const unreferenced = await fetch(`${baseUrl}/api/share/sessions/${token}/file?path=${encodeURIComponent('assets/20260708/private.txt')}`);
      expect(unreferenced.status).toBe(403);

      const symlinkEscape = await fetch(`${baseUrl}/api/share/sessions/${token}/file?path=${encodeURIComponent('assets/20260708/escape.txt')}`);
      expect(symlinkEscape.status).toBe(403);
    } finally {
      await stopServer(server);
    }
  });
});

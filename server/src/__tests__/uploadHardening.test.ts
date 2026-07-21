import express from 'express';
import { request as httpRequest, type Server } from 'node:http';
import { mkdtemp, readFile, readdir, stat, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createUploadRouter } from '../routes/upload.js';
import {
  DEFAULT_STAGED_RETENTION_MS,
  MAX_UPLOAD_FILE_BYTES,
  MAX_UPLOAD_FILES_PER_REQUEST,
  UploadDrainingError,
  UploadManager,
} from '../uploads/manager.js';

const USER = { sub: 'user-1', username: 'alice', role: 'user' as const, tenantId: 'tenant-a' };

describe('attachment upload hardening', () => {
  const roots: string[] = [];
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function createRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'agent-upload-hardening-'));
    roots.push(root);
    return root;
  }

  async function startUploadServer(root: string, manager: UploadManager): Promise<string> {
    const app = express();
    app.use((req, _res, next) => {
      req.user = USER;
      next();
    });
    app.use('/api', createUploadRouter({ agentCwd: root, uploadManager: manager }));
    const server = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test server address');
    return `http://127.0.0.1:${address.port}`;
  }

  it('uses the approved 2 GiB per-file and 20-file per-request limits', () => {
    expect(MAX_UPLOAD_FILE_BYTES).toBe(2 * 1024 * 1024 * 1024);
    expect(MAX_UPLOAD_FILES_PER_REQUEST).toBe(20);
  });

  it('moves completed files atomically out of .partial and keeps repeated names distinct', async () => {
    const root = await createRoot();
    const manager = new UploadManager({ agentCwd: root });
    const baseUrl = await startUploadServer(root, manager);
    const form = new FormData();
    form.append('files', new Blob(['first']), '重复.txt');
    form.append('files', new Blob(['second']), '重复.txt');

    const response = await fetch(`${baseUrl}/api/upload`, { method: 'POST', body: form });
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(body.files).toHaveLength(2);
    expect(body.files[0].relativePath).not.toBe(body.files[1].relativePath);
    const userCwd = join(root, USER.tenantId, USER.sub);
    expect(await readFile(join(userCwd, body.files[0].relativePath), 'utf8')).toBe('first');
    expect(await readFile(join(userCwd, body.files[1].relativePath), 'utf8')).toBe('second');
    expect(await readdir(join(userCwd, 'uploads', '.partial'))).toEqual([]);
    expect(manager.getMetricsSnapshot()).toMatchObject({
      activeUploads: 0,
      completedRequests: 1,
      uploadedBytes: 11,
    });
  });

  it('rejects a 21-file request and removes its partial request directory', async () => {
    const root = await createRoot();
    const manager = new UploadManager({ agentCwd: root });
    const baseUrl = await startUploadServer(root, manager);
    const form = new FormData();
    for (let index = 0; index < 21; index += 1) {
      form.append('files', new Blob([String(index)]), `${index}.txt`);
    }

    const response = await fetch(`${baseUrl}/api/upload`, { method: 'POST', body: form });
    const body = await response.json() as any;

    expect(response.status).toBe(413);
    expect(body.error).toContain('20');
    expect(manager.getActiveUploadCount()).toBe(0);
    const partialRoot = join(root, USER.tenantId, USER.sub, 'uploads', '.partial');
    expect(await readdir(partialRoot)).toEqual([]);
  });

  it('removes an aborted request from .partial and releases the drain counter', async () => {
    const root = await createRoot();
    const manager = new UploadManager({ agentCwd: root });
    const baseUrl = new URL(await startUploadServer(root, manager));
    const boundary = '----agent-upload-abort-test';
    const preamble = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="large.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    );
    const req = httpRequest({
      host: baseUrl.hostname,
      port: Number(baseUrl.port),
      path: '/api/upload',
      method: 'POST',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': preamble.length + 1024 * 1024,
      },
    });
    req.on('error', () => undefined);
    req.write(preamble);
    req.write(Buffer.alloc(64 * 1024, 1));
    await waitFor(() => manager.getActiveUploadCount() === 1);
    req.destroy();
    await waitFor(() => manager.getActiveUploadCount() === 0);

    const partialRoot = join(root, USER.tenantId, USER.sub, 'uploads', '.partial');
    expect(await readdir(partialRoot)).toEqual([]);
    expect(manager.getMetricsSnapshot().abortedRequests).toBe(1);
  });

  it('cleans expired staged files but never deletes referenced or legacy files', async () => {
    let now = Date.UTC(2026, 6, 21, 0, 0, 0);
    const root = await createRoot();
    const userCwd = join(root, 'tenant-a', 'user-1');
    const manager = new UploadManager({ agentCwd: root, now: () => now });
    const requestId = 'request-1';
    const partialDir = await manager.beginRequest(userCwd, requestId);
    const stagedId = '11111111-1111-4111-8111-111111111111';
    const referencedId = '22222222-2222-4222-8222-222222222222';
    await writeFile(join(partialDir, `${stagedId}_staged.txt`), 'staged');
    await writeFile(join(partialDir, `${referencedId}_referenced.txt`), 'referenced');
    const finalized = await manager.completeRequest(requestId, [
      {
        attachmentId: stagedId,
        filename: `${stagedId}_staged.txt`,
        partialPath: join(partialDir, `${stagedId}_staged.txt`),
        originalName: 'staged.txt',
        size: 6,
        mimeType: 'text/plain',
        isImage: false,
        isVoiceUpload: false,
      },
      {
        attachmentId: referencedId,
        filename: `${referencedId}_referenced.txt`,
        partialPath: join(partialDir, `${referencedId}_referenced.txt`),
        originalName: 'referenced.txt',
        size: 10,
        mimeType: 'text/plain',
        isImage: false,
        isVoiceUpload: false,
      },
    ]);
    await manager.markReferenced(userCwd, [finalized[1].info], {
      sessionId: 'session-1',
      clientMessageId: 'message-1',
    });
    const legacyPath = join(userCwd, 'uploads', 'legacy.txt');
    await writeFile(legacyPath, 'legacy');

    now += DEFAULT_STAGED_RETENTION_MS + 1;
    const cleanup = await manager.cleanupUserStaged(userCwd, DEFAULT_STAGED_RETENTION_MS);

    expect(cleanup).toEqual({ deletedFiles: 1, deletedBytes: 6 });
    await expect(stat(finalized[0].absolutePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(finalized[1].absolutePath)).isFile()).toBe(true);
    expect((await stat(legacyPath)).isFile()).toBe(true);
    const referencedState = JSON.parse(await readFile(join(userCwd, 'uploads', '.state', `${referencedId}.json`), 'utf8'));
    expect(referencedState).toMatchObject({
      status: 'referenced',
      sessionIds: ['session-1'],
      clientMessageIds: ['message-1'],
    });
  });

  it('rejects new uploads while draining without affecting an existing active upload', async () => {
    const root = await createRoot();
    const manager = new UploadManager({ agentCwd: root });
    const activeDir = await manager.beginRequest(join(root, 'tenant-a', 'user-1'), 'active');
    manager.setDraining(true);

    await expect(manager.beginRequest(join(root, 'tenant-b', 'user-2'), 'new')).rejects.toBeInstanceOf(UploadDrainingError);
    expect(manager.getActiveUploadCount()).toBe(1);
    expect((await stat(activeDir)).isDirectory()).toBe(true);

    await manager.finishFailedRequest('active', 'aborted');
    expect(manager.getActiveUploadCount()).toBe(0);
  });

  it('cleans staged files only inside the requesting user workspace', async () => {
    const root = await createRoot();
    const manager = new UploadManager({ agentCwd: root });
    const userA = join(root, 'tenant-a', 'user-a');
    const userB = join(root, 'tenant-b', 'user-b');
    const idA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const idB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    for (const [requestId, userCwd, attachmentId] of [
      ['request-a', userA, idA],
      ['request-b', userB, idB],
    ] as const) {
      const partialDir = await manager.beginRequest(userCwd, requestId);
      const filename = `${attachmentId}_tenant.txt`;
      const partialPath = join(partialDir, filename);
      await writeFile(partialPath, requestId);
      await manager.completeRequest(requestId, [{
        attachmentId,
        filename,
        partialPath,
        originalName: 'tenant.txt',
        size: requestId.length,
        mimeType: 'text/plain',
        isImage: false,
        isVoiceUpload: false,
      }]);
    }

    await manager.cleanupUserStaged(userA);

    await expect(stat(join(userA, 'uploads', `${idA}_tenant.txt`))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(join(userB, 'uploads', `${idB}_tenant.txt`))).isFile()).toBe(true);
  });

  it('ships nginx upload streaming with a NAS fallback temp path', async () => {
    const configPath = new URL('../../../daemon-packaging/nginx/agent-api-kaiyan.conf.example', import.meta.url);
    const config = await readFile(configPath, 'utf8');

    expect(config).toContain('location = /api/upload');
    expect(config).toContain('proxy_request_buffering off;');
    expect(config).toContain('client_body_temp_path /mnt/agent-saas/runtime/nginx-client-body');
    expect(config).toContain('client_max_body_size 41000m;');
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

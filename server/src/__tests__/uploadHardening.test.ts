import express from 'express';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server } from 'node:http';
import { copyFile, lstat, mkdtemp, mkdir, readFile, readdir, rename, stat, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createUploadRouter } from '../routes/upload.js';
import { resolveRuntimeInboundAttachments } from '../runtime/runtimeAttachmentResolution.js';
import type { RawRuntimeRunDispatchConfig } from '../runtime/rawRuntimeRunDispatchTypes.js';
import type { SessionCatalog } from '../runtime/sessionCatalog.js';
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

  async function startUploadServer(
    root: string,
    manager: UploadManager,
    sessionCatalog?: Pick<SessionCatalog, 'get'>,
  ): Promise<string> {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = USER;
      next();
    });
    app.use('/api', createUploadRouter({
      agentCwd: root,
      uploadManager: manager,
      sessionCatalog,
    }));
    const server = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test server address');
    return `http://127.0.0.1:${address.port}`;
  }

  it('keeps the approved 2 GiB per-file and 20-file per-request limits', () => {
    expect(MAX_UPLOAD_FILE_BYTES).toBe(2 * 1024 * 1024 * 1024);
    expect(MAX_UPLOAD_FILES_PER_REQUEST).toBe(20);
  });

  it('rejects an upload session that is not owned by the current user', async () => {
    const root = await createRoot();
    const manager = new UploadManager({ agentCwd: root });
    const sessionCatalog = {
      get: async (sessionId: string) => sessionId === 'other-session'
        ? ({ userId: 'user-2', tenantId: USER.tenantId } as any)
        : null,
    } as unknown as Pick<SessionCatalog, 'get'>;
    const baseUrl = await startUploadServer(root, manager, sessionCatalog);

    const response = await fetch(`${baseUrl}/api/upload?sessionId=other-session`, { method: 'POST' });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: '上传会话不属于当前用户' });
    expect(manager.getActiveUploadCount()).toBe(0);
  });

  it('references selected assets without creating a duplicate upload', async () => {
    const root = await createRoot();
    const manager = new UploadManager({ agentCwd: root });
    const userCwd = join(root, USER.tenantId, USER.sub);
    const assetPath = 'assets/20260822/方案.pdf';
    await mkdir(join(userCwd, 'assets', '20260822'), { recursive: true });
    await writeFile(join(userCwd, assetPath), '%PDF-1.4\nfixture');
    const baseUrl = await startUploadServer(root, manager);

    const response = await fetch(`${baseUrl}/api/upload/assets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: [assetPath] }),
    });
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(body.files).toHaveLength(1);
    expect(body.files[0]).toMatchObject({
      originalName: '方案.pdf',
      relativePath: assetPath,
      mimeType: 'application/pdf',
      isImage: false,
    });
    expect(await readFile(join(userCwd, assetPath), 'utf8')).toBe('%PDF-1.4\nfixture');
    expect(await readdir(join(userCwd, 'uploads'))).toEqual(['.state']);
    expect((await readdir(join(userCwd, 'uploads'))).filter((name) => !name.startsWith('.'))).toEqual([]);
    expect(await manager.resolveAttachments(userCwd, [body.files[0].attachmentId])).toEqual(body.files);
  });

  it('resolves canonical cloud text and image references through the Web runtime without upload copies', async () => {
    const root = await createRoot();
    const manager = new UploadManager({ agentCwd: root });
    const userCwd = join(root, USER.tenantId, USER.sub);
    const textPath = 'assets/20260825/cloud.txt';
    const imagePath = 'assets/20260825/cloud.png';
    await mkdir(join(userCwd, 'assets', '20260825'), { recursive: true });
    await writeFile(join(userCwd, textPath), 'cloud-content');
    await copyFile(resolve(process.cwd(), '../web/public/favicon-32x32.png'), join(userCwd, imagePath));

    const references = await manager.registerAssetReferences(
      userCwd,
      [textPath, imagePath],
      { sessionId: 'session-a' },
    );
    await manager.markReferenced(userCwd, references, { sessionId: 'session-a' });
    const runtimeConfig: RawRuntimeRunDispatchConfig = {
      agentCwd: root,
      sharedDir: root,
      uploadManager: manager,
    };
    const resolved = await resolveRuntimeInboundAttachments(runtimeConfig, userCwd, 'session-a', {
      channel: 'web',
      attachments: references.map((reference) => ({
        ...reference,
        relativePath: 'uploads/伪造路径',
      })),
    });

    expect(resolved.map((attachment) => attachment.relativePath)).toEqual([textPath, imagePath]);
    expect(resolved[0]).toMatchObject({ isImage: false, mimeType: 'text/plain' });
    expect(resolved[1]).toMatchObject({ isImage: true, mimeType: 'image/png' });
    expect((await readdir(join(userCwd, 'uploads'))).filter((name) => !name.startsWith('.'))).toEqual([]);
    await expect(resolveRuntimeInboundAttachments(runtimeConfig, userCwd, 'session-b', {
      channel: 'web',
      attachments: references,
    })).rejects.toThrow('Attachment does not belong to session');
    await expect(resolveRuntimeInboundAttachments(runtimeConfig, userCwd, 'session-a', {
      channel: 'web',
      attachments: [{ ...references[0], attachmentId: randomUUID() }],
    })).rejects.toThrow('Attachment not found');

    await rm(join(userCwd, textPath));
    await expect(manager.resolveAttachments(
      userCwd,
      [references[0].attachmentId!],
      { sessionId: 'session-a' },
    )).rejects.toMatchObject({ code: 'ATTACHMENT_DELETED' });
  });

  it('cleans an unused asset reference without deleting the source asset', async () => {
    const root = await createRoot();
    const manager = new UploadManager({ agentCwd: root });
    const userCwd = join(root, USER.tenantId, USER.sub);
    const assetPath = 'assets/20260822/保留.txt';
    await mkdir(join(userCwd, 'assets', '20260822'), { recursive: true });
    await writeFile(join(userCwd, assetPath), 'keep-me');

    const [reference] = await manager.registerAssetReferences(userCwd, [assetPath]);
    await manager.cleanupUserStaged(userCwd, 0);

    expect(await readFile(join(userCwd, assetPath), 'utf8')).toBe('keep-me');
    await expect(readFile(join(userCwd, 'uploads', '.state', `${reference.attachmentId}.json`), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects paths outside assets when importing library files', async () => {
    const root = await createRoot();
    const manager = new UploadManager({ agentCwd: root });
    const userCwd = join(root, USER.tenantId, USER.sub);
    await mkdir(join(userCwd, 'assets'), { recursive: true });
    await writeFile(join(userCwd, 'secret.txt'), 'secret');
    const baseUrl = await startUploadServer(root, manager);

    const response = await fetch(`${baseUrl}/api/upload/assets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: ['assets/../secret.txt'] }),
    });

    expect(response.status).toBe(400);
    expect(manager.getActiveUploadCount()).toBe(0);
  });

  it('rolls back only the exact failed automation attachment reference', async () => {const root=await createRoot();const manager=new UploadManager({agentCwd:root});const userCwd=join(root,USER.tenantId,USER.sub);const assetPath='assets/20260904/evidence.txt';await mkdir(join(userCwd,'assets','20260904'),{recursive:true});await writeFile(join(userCwd,assetPath),'evidence');const [attachment]=await manager.registerAssetReferences(userCwd,[assetPath]);await manager.markReferenced(userCwd,[attachment!],{sessionId:'session-a',clientMessageId:'message-a'});await expect(manager.resolveAttachments(userCwd,[attachment!.attachmentId!],{sessionId:'session-a'})).resolves.toHaveLength(1);await manager.releaseReference(userCwd,[attachment!],{sessionId:'session-a',clientMessageId:'message-a'});await expect(manager.resolveAttachments(userCwd,[attachment!.attachmentId!],{sessionId:'session-a'})).rejects.toThrow('does not belong');await expect(manager.resolveAttachments(userCwd,[attachment!.attachmentId!])).resolves.toHaveLength(1);});
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

  it('多附件任务复制中途失败时清理本次已复制文件', async () => {
    const root = await createRoot();
    const manager = new UploadManager({ agentCwd: root });
    const userCwd = join(root, USER.tenantId, USER.sub);
    await mkdir(join(userCwd, 'uploads'), { recursive: true });
    await writeFile(join(userCwd, 'uploads', 'first.txt'), 'a');
    const first = {
      attachmentId: '11111111-1111-4111-8111-111111111111',
      originalName: 'first.txt', relativePath: 'uploads/first.txt', size: 1,
      mimeType: 'text/plain', isImage: false,
    } as const;
    const second = { ...first, attachmentId: '22222222-2222-4222-8222-222222222222', relativePath: 'uploads/missing.txt' };

    await expect(manager.materializeTaskAttachments(userCwd, userCwd, 'task-1', [first, second]))
      .rejects.toThrow('ENOENT');
    await expect(readdir(join(userCwd, 'taskboard', 'attachments', 'task-1'))).resolves.toEqual([]);
    const materialized = await manager.materializeTaskAttachments(userCwd, userCwd, 'task-1', [first]);
    const repeated = await manager.materializeTaskAttachments(userCwd, userCwd, 'task-1', [first]);
    expect(repeated[0]!.relativePath).not.toBe(materialized[0]!.relativePath);
    await manager.cleanupTaskAttachments(userCwd, 'task-1', repeated);
    await expect(stat(join(userCwd, materialized[0]!.relativePath))).resolves.toBeTruthy();
    await manager.cleanupTaskAttachments(userCwd, 'task-1', materialized);
    await expect(readdir(join(userCwd, 'taskboard', 'attachments', 'task-1'))).resolves.toEqual([]);
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

  it('binds attachment IDs to the upload session and copies task-scope files', async () => {
    const root = await createRoot();
    const sourceCwd = join(root, 'tenant-a', 'user-1');
    const targetCwd = join(root, 'tenant-a', 'board-owner');
    const attachmentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const manager = new UploadManager({ agentCwd: root });
    const partialDir = await manager.beginRequest(sourceCwd, 'request-session');
    const sourcePath = join(partialDir, `${attachmentId}_evidence.pdf`);
    await writeFile(sourcePath, 'evidence');
    const [finalized] = await manager.completeRequest('request-session', [{
      attachmentId,
      filename: `${attachmentId}_evidence.pdf`,
      partialPath: sourcePath,
      originalName: 'evidence.pdf',
      size: 8,
      mimeType: 'application/pdf',
      isImage: false,
      isVoiceUpload: false,
    }], { sessionId: 'session-a' });

    await expect(manager.resolveAttachments(sourceCwd, [attachmentId], { sessionId: 'session-a' }))
      .resolves.toHaveLength(1);
    await expect(manager.resolveAttachments(sourceCwd, [attachmentId], { sessionId: 'session-b' }))
      .rejects.toThrow('does not belong to session');

    const sourceAttachment = { ...finalized.info, attachmentId };
    const [scoped] = await manager.materializeTaskAttachments(sourceCwd, targetCwd, 'task-1', [sourceAttachment]);
    expect(scoped.relativePath).toBe(`taskboard/attachments/task-1/${attachmentId}-evidence.pdf`);
    expect(await readFile(join(targetCwd, scoped.relativePath), 'utf8')).toBe('evidence');
    const opened = await manager.resolveTaskAttachment(targetCwd, 'task-1', scoped);
    await expect(opened.handle.readFile('utf8')).resolves.toBe('evidence');
    await opened.handle.close();

    await manager.markReferenced(sourceCwd, [sourceAttachment], { sessionId: 'session-a' });
    await expect(manager.markReferenced(sourceCwd, [sourceAttachment], { sessionId: 'session-b' }))
      .rejects.toThrow('already bound to another session');
    const state = JSON.parse(await readFile(join(sourceCwd, 'uploads', '.state', `${attachmentId}.json`), 'utf8'));
    expect(state.sessionIds).toEqual(['session-a']);
  });

  it('keeps a task download bound to the opened inode across directory replacement', async () => {
    const root = await createRoot();
    const manager = new UploadManager({ agentCwd: root });
    const userCwd = join(root, 'tenant-a', 'user-1');
    const attachmentId = 'abababab-abab-4bab-8bab-abababababab';
    await mkdir(join(userCwd, 'uploads'), { recursive: true });
    await writeFile(join(userCwd, 'uploads', 'evidence.txt'), 'trusted');
    const [scoped] = await manager.materializeTaskAttachments(userCwd, userCwd, 'task-race', [{
      attachmentId,
      originalName: 'evidence.txt',
      relativePath: 'uploads/evidence.txt',
      size: 7,
      mimeType: 'text/plain',
      isImage: false,
    }]);

    const opened = await manager.resolveTaskAttachment(userCwd, 'task-race', scoped);
    const taskDirectory = join(userCwd, 'taskboard', 'attachments', 'task-race');
    await rename(taskDirectory, `${taskDirectory}-old`);
    await mkdir(taskDirectory, { recursive: true });
    await writeFile(join(userCwd, scoped.relativePath), 'attacker');

    await expect(opened.handle.readFile('utf8')).resolves.toBe('trusted');
    await opened.handle.close();
  });

  it('rejects ancestor symlinks and cross-root task attachment deletion', async () => {
    const root = await createRoot();
    const manager = new UploadManager({ agentCwd: root });
    const userCwd = join(root, 'tenant-a', 'user-1');
    const outside = join(root, 'outside');
    const attachmentId = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
    await mkdir(userCwd, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'source.txt'), 'outside');
    await symlink(outside, join(userCwd, 'uploads'));

    await expect(manager.materializeTaskAttachments(userCwd, userCwd, 'task-safe', [{
      attachmentId,
      originalName: 'source.txt',
      relativePath: 'uploads/source.txt',
      size: 7,
      mimeType: 'text/plain',
      isImage: false,
    }])).rejects.toThrow();

    const protectedPath = join(outside, `${attachmentId}-protected.txt`);
    await writeFile(protectedPath, 'keep');
    await expect(manager.cleanupTaskAttachments(userCwd, 'task-safe', [{
      attachmentId,
      relativePath: `taskboard/attachments/task-safe/../../../../outside/${attachmentId}-protected.txt`,
    }])).rejects.toThrow('not in its task scope');
    await expect(readFile(protectedPath, 'utf8')).resolves.toBe('keep');
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
    await waitFor(async () => (await readdir(partialRoot)).length === 0);
    expect(manager.getMetricsSnapshot().abortedRequests).toBe(1);
  });

  it('closes pinned request handles and drops active state when partial removal fails', async () => {
    const root = await createRoot();
    const manager = new UploadManager({ agentCwd: root });
    const userCwd = join(root, USER.tenantId, USER.sub);
    const requestId = 'request-remove-error';
    const partialDir = await manager.beginRequest(userCwd, requestId);
    const active = (manager as unknown as {
      activeRequests: Map<string, {
        partialHandle: { fd: number };
        uploadsHandle: { fd: number };
      }>;
    }).activeRequests.get(requestId)!;
    const movedPartialDir = `${partialDir}-moved`;
    await rename(partialDir, movedPartialDir);
    await symlink(movedPartialDir, partialDir, 'dir');

    await expect(manager.finishFailedRequest(requestId, 'aborted')).resolves.toBeUndefined();

    expect(manager.getActiveUploadCount()).toBe(0);
    expect(active.partialHandle.fd).toBe(-1);
    expect(active.uploadsHandle.fd).toBe(-1);
    expect((await lstat(partialDir)).isSymbolicLink()).toBe(true);
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

  it('failStaleUploads releases only hung requests past the grace threshold (drain deadlock fix)', async () => {
    const root = await createRoot();
    let now = Date.UTC(2026, 7, 17, 12, 0, 0);
    const manager = new UploadManager({ agentCwd: root, now: () => now });
    const hungDir = await manager.beginRequest(join(root, 'tenant-a', 'user-1'), 'req-hung');
    expect(manager.getActiveUploadCount()).toBe(1);

    // 宽限期内（1h）不清理
    now += 30 * 60_000;
    expect(manager.failStaleUploads(3_600_000)).toBe(0);
    expect(manager.getActiveUploadCount()).toBe(1);

    // 新请求开始得更晚，不应被误杀
    now += 2 * 3_600_000;
    await manager.beginRequest(join(root, 'tenant-a', 'user-1'), 'req-fresh');
    expect(manager.getActiveUploadCount()).toBe(2);

    expect(manager.failStaleUploads(3_600_000)).toBe(1);
    expect(manager.getActiveUploadCount()).toBe(1);
    // failStaleUploads 内部 rm 是异步 fire-and-forget，轮询等待目录清理完成
    await waitFor(async () => {
      try { await stat(hungDir); return false; } catch { return true; }
    });
    expect(manager.getMetricsSnapshot().failedRequests).toBe(1);

    await manager.finishFailedRequest('req-fresh', 'aborted');
    expect(manager.getActiveUploadCount()).toBe(0);
  });

  it('closes an upload whose connection disappears before completion (close-event fallback)', async () => {
    const root = await createRoot();
    const manager = new UploadManager({ agentCwd: root });
    const baseUrl = new URL(await startUploadServer(root, manager));
    const boundary = '----agent-upload-close-test';
    const preamble = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="stuck.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
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
    // 客户端消失（socket 半开/destroy 均覆盖：aborted 或 close 兜底至少一条生效）
    req.destroy();
    await waitFor(() => manager.getActiveUploadCount() === 0, 15_000);

    const partialRoot = join(root, USER.tenantId, USER.sub, 'uploads', '.partial');
    await waitFor(async () => (await readdir(partialRoot)).length === 0);
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

  it('purges every attachment of one user but keeps in-flight partials and other workspaces', async () => {
    const root = await createRoot();
    const manager = new UploadManager({ agentCwd: root });
    const userA = join(root, 'tenant-a', 'user-a');
    const userB = join(root, 'tenant-b', 'user-b');
    const stagedId = '33333333-3333-4333-8333-333333333333';
    const referencedId = '44444444-4444-4444-8444-444444444444';
    const otherId = '55555555-5555-4555-8555-555555555555';

    const partialDir = await manager.beginRequest(userA, 'request-a');
    await writeFile(join(partialDir, `${stagedId}_staged.txt`), 'staged');
    await writeFile(join(partialDir, `${referencedId}_referenced.txt`), 'referenced');
    const finalized = await manager.completeRequest('request-a', [
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
    await manager.markReferenced(userA, [finalized[1].info], { sessionId: 'session-1' });
    const legacyPath = join(userA, 'uploads', 'legacy.txt');
    await writeFile(legacyPath, 'legacy');

    // 另一个用户的附件，以及 userA 一个仍在传输中的请求
    const otherPartialDir = await manager.beginRequest(userB, 'request-b');
    await writeFile(join(otherPartialDir, `${otherId}_other.txt`), 'other');
    await manager.completeRequest('request-b', [{
      attachmentId: otherId,
      filename: `${otherId}_other.txt`,
      partialPath: join(otherPartialDir, `${otherId}_other.txt`),
      originalName: 'other.txt',
      size: 5,
      mimeType: 'text/plain',
      isImage: false,
      isVoiceUpload: false,
    }]);
    const inFlightDir = await manager.beginRequest(userA, 'request-in-flight');
    const inFlightPath = join(inFlightDir, 'uploading.bin');
    await writeFile(inFlightPath, 'streaming');

    const purge = await manager.purgeUserUploads(userA);

    expect(purge).toEqual({ deletedFiles: 3, deletedBytes: 22 });
    for (const path of [finalized[0].absolutePath, finalized[1].absolutePath, legacyPath]) {
      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    await expect(stat(join(userA, 'uploads', '.state'))).rejects.toMatchObject({ code: 'ENOENT' });
    // 传输中的请求与其它用户不受影响
    expect((await stat(inFlightPath)).isFile()).toBe(true);
    expect((await stat(join(userB, 'uploads', `${otherId}_other.txt`))).isFile()).toBe(true);

    const usage = await manager.getUsage(userA);
    expect(usage).toMatchObject({ totalFiles: 0, totalBytes: 0, stagedFiles: 0, referencedFiles: 0, legacyFiles: 0 });
  });

  it('accepts broad attachment types and downgrades unsafe preview classifications', async () => {
    const root = await createRoot();
    const manager = new UploadManager({ agentCwd: root });
    const baseUrl = await startUploadServer(root, manager);
    const cases = [
      { name: '文档 V2.5.pdf', type: 'application/pdf', body: '%PDF-1.4\nvalid', mimeType: 'application/pdf' },
      { name: 'Demo-V2.7 (1).html', type: 'text/html', body: '<!doctype html><h1>Demo</h1>', mimeType: 'text/html' },
      { name: 'install.exe', type: 'application/x-msdownload', body: Buffer.from([0x4d, 0x5a, 0, 0]), mimeType: 'application/octet-stream' },
      { name: 'photo.png', type: 'image/png', body: 'not-a-png', mimeType: 'application/octet-stream' },
    ];
    for (const fixture of cases) {
      const form = new FormData();
      form.append('files', new Blob([fixture.body], { type: fixture.type }), fixture.name);
      const response = await fetch(`${baseUrl}/api/upload`, { method: 'POST', body: form });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        success: true,
        files: [{ originalName: fixture.name, mimeType: fixture.mimeType, isImage: false }],
      });
    }
  });

  it('enforces the 5 item/20 MB incoming-share envelope and server content inspection', async () => {
    const root = await createRoot();
    const manager = new UploadManager({ agentCwd: root });
    const baseUrl = await startUploadServer(root, manager);

    const valid = new FormData();
    valid.append('files', new Blob(['%PDF-1.7\nvalid'], { type: 'application/pdf' }), 'valid.pdf');
    const ok = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST', headers: { 'X-Upload-Source': 'incoming-share', 'X-Upload-Request-Id': randomUUID() }, body: valid,
    });
    expect(ok.status).toBe(200);

    const active = new FormData();
    active.append('files', new Blob(['%PDF-1.7<script>bad'], { type: 'application/pdf' }), 'active.pdf');
    const rejected = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST', headers: { 'X-Upload-Source': 'incoming-share', 'X-Upload-Request-Id': randomUUID() }, body: active,
    });
    expect(rejected.status).toBe(422);
    expect(await rejected.json()).toMatchObject({ code: 'UPLOAD_EXECUTABLE_CONTENT' });

    const six = new FormData();
    for (let index = 0; index < 6; index += 1) six.append('files', new Blob(['%PDF-1.7\n'], { type: 'application/pdf' }), `${index}.pdf`);
    const tooMany = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST', headers: { 'X-Upload-Source': 'incoming-share', 'X-Upload-Request-Id': randomUUID() }, body: six,
    });
    expect(tooMany.status).toBe(413);
  });

  it('replays the same uploadRequestId idempotently and makes completed server result win cancel', async () => {
    const root = await createRoot();
    const manager = new UploadManager({ agentCwd: root });
    const baseUrl = await startUploadServer(root, manager);
    const requestId = randomUUID();
    const upload = async () => {
      const form = new FormData();
      form.append('files', new Blob(['same'], { type: 'text/plain' }), 'same.txt');
      const response = await fetch(`${baseUrl}/api/upload`, {
        method: 'POST', headers: { 'X-Upload-Request-Id': requestId }, body: form,
      });
      return { response, body: await response.json() as any };
    };
    const first = await upload();
    const status = await fetch(`${baseUrl}/api/uploads/requests/${requestId}`);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ success: true, requestId, files: [{ attachmentId: first.body.files[0].attachmentId }] });
    const replay = await upload();
    expect(first.response.status).toBe(200);
    expect(replay.body).toMatchObject({ success: true, requestId, idempotentReplay: true });
    expect(replay.body.files[0].attachmentId).toBe(first.body.files[0].attachmentId);
    const userCwd = join(root, USER.tenantId, USER.sub);
    expect((await readdir(join(userCwd, 'uploads'))).filter((name) => !name.startsWith('.'))).toHaveLength(1);

    const cancel = await fetch(`${baseUrl}/api/upload/${requestId}/cancel`, { method: 'POST' });
    expect(await cancel.json()).toMatchObject({ success: true, outcome: 'uploaded' });
  });

  it('serves only owned attachmentId routes with safe headers and structured expired/deleted failures', async () => {
    let now = Date.now();
    const root = await createRoot();
    const manager = new UploadManager({ agentCwd: root, now: () => now });
    const baseUrl = await startUploadServer(root, manager);
    const requestId = randomUUID();
    const form = new FormData();
    form.append('files', new Blob(['safe'], { type: 'text/plain' }), 'safe.txt');
    const upload = await fetch(`${baseUrl}/api/upload`, { method: 'POST', headers: { 'X-Upload-Request-Id': requestId }, body: form });
    const body = await upload.json() as any;
    const attachmentId = body.files[0].attachmentId as string;

    const content = await fetch(`${baseUrl}/api/attachments/${attachmentId}/content`);
    expect(content.status).toBe(200);
    expect(content.headers.get('content-disposition')).toContain('attachment');
    expect(content.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(content.headers.get('x-content-type-options')).toBe('nosniff');
    expect(content.headers.get('cross-origin-resource-policy')).toBe('same-origin');

    const forged = await fetch(`${baseUrl}/api/attachments/${randomUUID()}/content`);
    expect(await forged.json()).toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' });

    const otherCwd = join(root, 'tenant-b', 'user-2');
    const otherRequestId = randomUUID();
    const otherAttachmentId = randomUUID();
    const otherPartial = await manager.beginRequest(otherCwd, otherRequestId);
    const otherFilename = `${otherAttachmentId}_secret.txt`;
    await writeFile(join(otherPartial, otherFilename), 'secret');
    await manager.completeRequest(otherRequestId, [{
      attachmentId: otherAttachmentId, filename: otherFilename,
      partialPath: join(otherPartial, otherFilename), originalName: 'secret.txt', size: 6,
      mimeType: 'text/plain', isImage: false, isVoiceUpload: false,
    }]);
    const crossTenant = await fetch(`${baseUrl}/api/attachments/${otherAttachmentId}/content`);
    expect(crossTenant.status).toBe(404);
    expect(await crossTenant.json()).toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' });

    now += DEFAULT_STAGED_RETENTION_MS + 1;
    const expired = await fetch(`${baseUrl}/api/attachments/${attachmentId}/content`);
    expect(expired.status).toBe(410);
    expect(await expired.json()).toMatchObject({ code: 'ATTACHMENT_EXPIRED' });

    now = Date.now();
    const managerDeleted = new UploadManager({ agentCwd: root, now: () => now });
    const deletedPath = join(root, USER.tenantId, USER.sub, body.files[0].relativePath);
    await rm(deletedPath);
    const deletedBase = await startUploadServer(root, managerDeleted);
    const deleted = await fetch(`${deletedBase}/api/attachments/${attachmentId}/content`);
    expect(deleted.status).toBe(410);
    expect(await deleted.json()).toMatchObject({ code: 'ATTACHMENT_DELETED' });
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

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

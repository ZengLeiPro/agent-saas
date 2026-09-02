import express from 'express';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createUploadRouter } from '../routes/upload.js';
import { UploadManager } from '../uploads/manager.js';

const USER = { sub: 'user-1', username: 'alice', role: 'user' as const, tenantId: 'tenant-a' };

describe('authenticated attachment audio ranges', () => {
  const roots: string[] = [];
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function createRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'agent-upload-audio-range-'));
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

  it('serves authenticated audio with MIME, HEAD and RFC byte range boundaries', async () => {
    const root = await createRoot();
    const manager = new UploadManager({ agentCwd: root });
    const baseUrl = await startUploadServer(root, manager);
    const userCwd = join(root, USER.tenantId, USER.sub);
    const requestId = randomUUID();
    const attachmentId = randomUUID();
    const partial = await manager.beginRequest(userCwd, requestId);
    const filename = `${attachmentId}_voice.wav`;
    const bytes = Buffer.from(Array.from({ length: 100 }, (_, index) => index));
    await writeFile(join(partial, filename), bytes);
    await manager.completeRequest(requestId, [{
      attachmentId, filename, partialPath: join(partial, filename), originalName: 'voice.wav',
      size: bytes.length, mimeType: 'audio/wav', isImage: false, isVoiceUpload: true,
    }]);

    const partialResponse = await fetch(`${baseUrl}/api/attachments/${attachmentId}/content`, {
      headers: { Range: 'bytes=10-19' },
    });
    expect(partialResponse.status).toBe(206);
    expect(partialResponse.headers.get('content-type')).toContain('audio/wav');
    expect(partialResponse.headers.get('content-disposition')).toContain('inline');
    expect(partialResponse.headers.get('x-content-type-options')).toBe('nosniff');
    expect(partialResponse.headers.get('accept-ranges')).toBe('bytes');
    expect(partialResponse.headers.get('content-range')).toBe('bytes 10-19/100');
    expect(Buffer.from(await partialResponse.arrayBuffer())).toEqual(bytes.subarray(10, 20));

    const head = await fetch(`${baseUrl}/api/attachments/${attachmentId}/content`, {
      method: 'HEAD', headers: { Range: 'bytes=-8' },
    });
    expect(head.status).toBe(206);
    expect(head.headers.get('content-range')).toBe('bytes 92-99/100');
    expect(head.headers.get('content-length')).toBe('8');
    expect(await head.text()).toBe('');

    const invalid = await fetch(`${baseUrl}/api/attachments/${attachmentId}/content`, {
      headers: { Range: 'bytes=100-110' },
    });
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get('content-range')).toBe('bytes */100');
  });
});

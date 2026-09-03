import express from 'express';
import { afterEach, beforeEach, describe, expect, vi, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';

import { createArtifactsRouter } from '../routes/artifacts.js';
import { InMemoryArtifactStore, LocalArtifactBlobStore } from '../runtime/artifactStore.js';
import { ArtifactService, type RuntimeArtifactUser } from '../runtime/artifactService.js';
import { getTranscriptPath } from '../data/transcripts/store.js';
import { getMetaPath, writeSessionMeta } from '../data/transcripts/meta.js';

const SESSION_ID = '11111111-2222-4333-8444-555555555555';

async function startServer(service: ArtifactService, user?: RuntimeArtifactUser): Promise<{ server: Server; baseUrl: string; setUser: (next?: RuntimeArtifactUser) => void }> {
  let currentUser = user;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = currentUser;
    next();
  });
  app.use('/api', createArtifactsRouter({ artifactService: service, defaultReadUrlTtlSeconds: 60 }));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}`, setUser: (next) => { currentUser = next; } });
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
  let artifactStore: InMemoryArtifactStore;
  const cleanupPaths = new Set<string>();

  beforeEach(async () => {
    agentCwd = await mkdtemp(join(tmpdir(), 'artifact-agent-'));
    blobRoot = await mkdtemp(join(tmpdir(), 'artifact-blob-'));
    cleanupPaths.add(agentCwd);
    cleanupPaths.add(blobRoot);
    artifactStore = new InMemoryArtifactStore();
    service = new ArtifactService({
      artifactStore,
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
    const { server, baseUrl, setUser } = await startServer(service, { sub: 'user-1', username: 'alice', role: 'user', tenantId: 'kaiyan' });
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

      // Production leaves req.user unset for this public signed-capability route.
      setUser(undefined);
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

  it('uses attachment-only proxy URLs for explicit downloads of previewable files', async () => {
    const pdf = await service.createFromBytes({
      sessionId: SESSION_ID,
      data: '%PDF-1.4',
      fileName: '验收报告.pdf',
      mimeType: 'application/pdf',
    });
    const image = await service.createFromBytes({
      sessionId: SESSION_ID,
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      fileName: '截图.png',
      mimeType: 'image/png',
    });
    const { server, baseUrl } = await startServer(service, { sub: 'user-1', username: 'alice', role: 'user', tenantId: 'kaiyan' });
    try {
      const previewUrl = await fetch(`${baseUrl}/api/artifacts/${pdf.artifactId}/read-url?proxy=true`);
      const preview = await previewUrl.json() as { url: string };
      const previewContent = await fetch(preview.url);
      expect(previewContent.headers.get('content-disposition')).toMatch(/^inline;/);

      for (const artifact of [pdf, image]) {
        const downloadUrl = await fetch(`${baseUrl}/api/artifacts/${artifact.artifactId}/read-url?download=true`);
        expect(downloadUrl.status).toBe(200);
        const download = await downloadUrl.json() as { url: string; direct: boolean };
        expect(download.direct).toBe(false);
        expect(download.url).not.toContain('download=true'); // disposition is signed, never mutable query state
        const content = await fetch(download.url);
        expect(content.headers.get('content-disposition')).toMatch(/^attachment;/);
      }
    } finally {
      await stopServer(server);
    }
  });

  it('serves active signed content inline only with a restrictive response sandbox', async () => {
    const artifact = await service.createFromBytes({
      sessionId: SESSION_ID,
      data: '<!doctype html><script>top.location="https://example.test"</script>',
      fileName: 'active.html',
      mimeType: 'text/html',
    });
    const { server, baseUrl } = await startServer(service, { sub: 'user-1', username: 'alice', role: 'user', tenantId: 'kaiyan' });
    try {
      const readUrl = await fetch(`${baseUrl}/api/artifacts/${artifact.artifactId}/read-url?proxy=true&viewPolicyVersion=2`);
      const signed = await readUrl.json() as { url: string; direct: boolean };
      expect(signed.direct).toBe(false);
      const content = await fetch(signed.url);
      expect(content.headers.get('content-disposition')).toMatch(/^inline;/);
      expect(content.headers.get('x-content-type-options')).toBe('nosniff');
      expect(content.headers.get('content-security-policy')).toContain('sandbox');
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

  it('binds grants to owner, tenant, disposition, expiry, digest, version and latest nonce', async () => {
    const artifact = await service.createFromBytes({ sessionId: SESSION_ID, data: 'private', fileName: 'private.txt', mimeType: 'text/plain' });
    const owner = { sub: 'user-1', username: 'alice', role: 'user' as const, tenantId: 'kaiyan' };
    const { server, baseUrl, setUser } = await startServer(service, owner);
    try {
      const firstRes = await fetch(`${baseUrl}/api/artifacts/${artifact.artifactId}/read-url?expiresInSeconds=1`);
      const first = await firstRes.json() as { readUrl: string; descriptor: { artifactId: string; digest: string; viewKind: string } };
      expect(first.descriptor).toMatchObject({ artifactId: artifact.artifactId, digest: artifact.sha256, viewKind: 'text' });

      setUser({ ...owner, sub: 'user-2', username: 'bob' });
      expect((await fetch(first.readUrl)).status).toBe(403);
      setUser({ ...owner, tenantId: 'other' });
      expect((await fetch(first.readUrl)).status).toBe(403);
      expect((await fetch(`${baseUrl}/api/artifacts/${artifact.artifactId}/read-url`)).status).toBe(404);
      setUser(owner);

      const second = await (await fetch(`${baseUrl}/api/artifacts/${artifact.artifactId}/read-url?expiresInSeconds=60`)).json() as { readUrl: string };
      expect((await fetch(first.readUrl)).status).toBe(401); // superseded nonce cannot be replayed
      expect((await fetch(`${second.readUrl.slice(0, -1)}x`)).status).toBe(401); // tampered signature

      const signedUrl = new URL(second.readUrl);
      const [encoded] = signedUrl.searchParams.get('token')!.split('.');
      const malformedPayload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>;
      malformedPayload.exp = 'not-a-date';
      const malformedEncoded = Buffer.from(JSON.stringify(malformedPayload)).toString('base64url');
      const malformedSignature = createHmac('sha256', 'test-artifact-signing-secret').update(malformedEncoded).digest('base64url');
      signedUrl.searchParams.set('token', `${malformedEncoded}.${malformedSignature}`);
      expect((await fetch(signedUrl)).status).toBe(401);

      const expiring = await (await fetch(`${baseUrl}/api/artifacts/${artifact.artifactId}/read-url?expiresInSeconds=1&download=true`)).json() as { readUrl: string };
      await new Promise(resolve => setTimeout(resolve, 1_050));
      expect((await fetch(expiring.readUrl)).status).toBe(401);
    } finally { await stopServer(server); }
  });

  it('re-authorizes on refresh and does not extend access revoked between grants', async () => {
    const artifact = await service.createFromBytes({ sessionId: SESSION_ID, data: 'private', fileName: 'private.txt', mimeType: 'text/plain' });
    const owner = { sub: 'user-1', username: 'alice', role: 'user' as const, tenantId: 'kaiyan' };
    const { server, baseUrl } = await startServer(service, owner);
    try {
      expect((await fetch(`${baseUrl}/api/artifacts/${artifact.artifactId}/read-url`)).status).toBe(200);
      const transcriptPath = getTranscriptPath(join(agentCwd, 'kaiyan', 'user-1'), SESSION_ID);
      await rm(getMetaPath(transcriptPath), { force: true });
      expect((await fetch(`${baseUrl}/api/artifacts/${artifact.artifactId}/read-url`)).status).toBe(404);
    } finally { await stopServer(server); }
  });

  it('returns canonical deleted and quarantine failures on every signed request', async () => {
    const deleted = await service.createFromBytes({ sessionId: SESSION_ID, data: 'gone', fileName: 'gone.txt', mimeType: 'text/plain' });
    const quarantined = await service.createFromBytes({ sessionId: SESSION_ID, data: 'bad', fileName: 'bad.txt', mimeType: 'text/plain' });
    const owner = { sub: 'user-1', username: 'alice', role: 'user' as const, tenantId: 'kaiyan' };
    const { server, baseUrl } = await startServer(service, owner);
    try {
      const deletedGrant = await (await fetch(`${baseUrl}/api/artifacts/${deleted.artifactId}/read-url`)).json() as { readUrl: string };
      await artifactStore.delete(deleted.artifactId);
      const deletedResponse = await fetch(deletedGrant.readUrl);
      expect(deletedResponse.status).toBe(410);
      await expect(deletedResponse.json()).resolves.toMatchObject({ code: 'artifact_deleted' });

      const quarantineGrant = await (await fetch(`${baseUrl}/api/artifacts/${quarantined.artifactId}/read-url`)).json() as { readUrl: string };
      const current = await artifactStore.get(quarantined.artifactId);
      current!.metadata.quarantined = true;
      const quarantineResponse = await fetch(quarantineGrant.readUrl);
      expect(quarantineResponse.status).toBe(423);
      await expect(quarantineResponse.json()).resolves.toMatchObject({ code: 'artifact_quarantined' });
    } finally { await stopServer(server); }
  });

  it('serves valid PDF and text byte ranges plus HEAD/304', async () => {
    const pdfData = Buffer.from('%PDF-1.7\n0123456789abcdefghijklmnopqrstuvwxyz');
    const pdf = await service.createFromBytes({ sessionId: SESSION_ID, data: pdfData, fileName: 'safe.pdf', mimeType: 'application/pdf' });
    const text = await service.createFromBytes({ sessionId: SESSION_ID, data: 'plain', fileName: 'safe.txt', mimeType: 'text/plain' });
    const owner = { sub: 'user-1', username: 'alice', role: 'user' as const, tenantId: 'kaiyan' };
    const { server, baseUrl } = await startServer(service, owner);
    try {
      const pdfGrant = await (await fetch(`${baseUrl}/api/artifacts/${pdf.artifactId}/read-url`)).json() as { readUrl: string };
      const partial = await fetch(pdfGrant.readUrl, { headers: { Range: 'bytes=5-12' } });
      expect(partial.status).toBe(206);
      expect(partial.headers.get('content-range')).toBe(`bytes 5-12/${pdfData.byteLength}`);
      expect(Number(partial.headers.get('content-length'))).toBe(8);
      expect((await partial.arrayBuffer()).byteLength).toBe(8);

      const head = await fetch(pdfGrant.readUrl, { method: 'HEAD', headers: { Range: 'bytes=-4' } });
      expect(head.status).toBe(206);
      expect(head.headers.get('content-range')).toBe(`bytes ${pdfData.byteLength - 4}-${pdfData.byteLength - 1}/${pdfData.byteLength}`);
      expect((await fetch(pdfGrant.readUrl, { headers: { Range: 'bytes=999-1000' } })).status).toBe(416);

      const full = await fetch(pdfGrant.readUrl);
      const etag = full.headers.get('etag')!;
      expect(etag).toContain(pdf.sha256!);
      expect(etag).not.toContain(owner.sub);
      expect((await fetch(pdfGrant.readUrl, { headers: { 'If-None-Match': etag } })).status).toBe(304);

      const textGrant = await (await fetch(`${baseUrl}/api/artifacts/${text.artifactId}/read-url`)).json() as { readUrl: string };
      const textPartial = await fetch(textGrant.readUrl, { headers: { Range: 'bytes=0-1' } });
      expect(textPartial.status).toBe(206);
      await expect(textPartial.text()).resolves.toBe('pl');
    } finally { await stopServer(server); }
  });

  it('forces spoofed, double-extension and scripted PDF files to warned attachment descriptors', async () => {
    const cases = [
      { data: '<svg><script>alert(1)</script></svg>', fileName: 'photo.png', mimeType: 'image/png' },
      { data: Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), fileName: 'invoice.html.png', mimeType: 'image/png' },
      { data: '%PDF-1.7 /JavaScript /JS', fileName: 'x.pdf', mimeType: 'application/pdf' },
    ];
    const owner = { sub: 'user-1', username: 'alice', role: 'user' as const, tenantId: 'kaiyan' };
    const { server, baseUrl } = await startServer(service, owner);
    try {
      for (const input of cases) {
        const artifact = await service.createFromBytes({ sessionId: SESSION_ID, ...input });
        const response = await fetch(`${baseUrl}/api/artifacts/${artifact.artifactId}/read-url`);
        const grant = await response.json() as { readUrl: string; descriptor: { viewKind: string; activeContent: boolean; requiresWarning: boolean } };
        expect(grant.descriptor).toMatchObject({ viewKind: 'download-only', requiresWarning: true });
        const content = await fetch(grant.readUrl);
        expect(content.headers.get('content-disposition')).toMatch(/^attachment;/);
        expect(content.headers.get('x-content-type-options')).toBe('nosniff');
        expect(content.headers.get('content-security-policy')).toContain('sandbox');
      }
    } finally { await stopServer(server); }
  });

  it('infers Markdown MIME and grants active text only to the matching safe renderer', async () => {
    const markdown = await service.createFromBytes({ sessionId: SESSION_ID, data: '# 安全预览', fileName: 'readme.md' });
    const html = await service.createFromBytes({ sessionId: SESSION_ID, data: '<!doctype html><script>document.body.dataset.ran="1"</script>', fileName: 'demo.html' });
    const svg = await service.createFromBytes({ sessionId: SESSION_ID, data: '<svg><script>alert(1)</script></svg>', fileName: 'icon.svg' });
    expect(markdown.mimeType).toBe('text/markdown');
    expect(html.mimeType).toBe('text/html');
    expect(svg.mimeType).toBe('image/svg+xml');

    const owner = { sub: 'user-1', username: 'alice', role: 'user' as const, tenantId: 'kaiyan' };
    const { server, baseUrl } = await startServer(service, owner);
    try {
      const markdownGrant = await (await fetch(`${baseUrl}/api/artifacts/${markdown.artifactId}/read-url?viewPolicyVersion=2`)).json() as { descriptor: { viewKind: string; requiresWarning: boolean } };
      expect(markdownGrant.descriptor).toMatchObject({ viewKind: 'markdown', requiresWarning: false });

      const legacyMarkdownGrant = await (await fetch(`${baseUrl}/api/artifacts/${markdown.artifactId}/read-url`)).json() as { descriptor: { viewKind: string } };
      expect(legacyMarkdownGrant.descriptor.viewKind).toBe('text');

      const htmlGrant = await (await fetch(`${baseUrl}/api/artifacts/${html.artifactId}/read-url?viewPolicyVersion=2`)).json() as { readUrl: string; descriptor: { viewKind: string; activeContent: boolean; requiresWarning: boolean } };
      expect(htmlGrant.descriptor).toMatchObject({ viewKind: 'html', activeContent: true, requiresWarning: true });
      const htmlContent = await fetch(htmlGrant.readUrl);
      expect(htmlContent.headers.get('content-disposition')).toMatch(/^inline;/);
      expect(htmlContent.headers.get('content-security-policy')).toContain("default-src 'none'");

      const legacyHtmlGrant = await (await fetch(`${baseUrl}/api/artifacts/${html.artifactId}/read-url`)).json() as { descriptor: { viewKind: string } };
      expect(legacyHtmlGrant.descriptor.viewKind).toBe('download-only');

      const svgGrant = await (await fetch(`${baseUrl}/api/artifacts/${svg.artifactId}/read-url?viewPolicyVersion=2`)).json() as { readUrl: string; descriptor: { viewKind: string; activeContent: boolean } };
      expect(svgGrant.descriptor).toMatchObject({ viewKind: 'source', activeContent: true });
      const svgContent = await fetch(svgGrant.readUrl);
      expect(svgContent.headers.get('content-type')).toContain('text/plain');
    } finally { await stopServer(server); }
  });

  it('sanitizes header-injection filenames and never emits signed URL/token to logs', async () => {
    const artifact = await service.createFromBytes({ sessionId: SESSION_ID, data: 'safe', fileName: 'evil\r\nX-Owned: yes.txt', mimeType: 'text/plain' });
    const owner = { sub: 'user-1', username: 'alice', role: 'user' as const, tenantId: 'kaiyan' };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { server, baseUrl } = await startServer(service, owner);
    try {
      const grant = await (await fetch(`${baseUrl}/api/artifacts/${artifact.artifactId}/read-url`)).json() as { readUrl: string };
      const content = await fetch(grant.readUrl);
      expect(content.status).toBe(200);
      const disposition = content.headers.get('content-disposition')!;
      expect(disposition).not.toMatch(/[\r\n]/);
      expect(disposition.toLowerCase()).not.toContain('%0d');
      expect(disposition.toLowerCase()).not.toContain('%0a');
      expect([...logSpy.mock.calls, ...errorSpy.mock.calls].flat().join(' ')).not.toContain('token=');
    } finally {
      logSpy.mockRestore(); errorSpy.mockRestore(); await stopServer(server);
    }
  });


  it('fails closed in production when persistent signing configuration is absent', () => {
    expect(() => new ArtifactService({
      artifactStore: new InMemoryArtifactStore(),
      blobStore: new LocalArtifactBlobStore({ rootDir: blobRoot }),
      agentCwd,
      runtimeEnvironment: 'production',
    })).toThrow(/signedUrlSecret/);
  });

});

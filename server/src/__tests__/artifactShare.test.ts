import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { writeSessionMeta } from '../data/transcripts/meta.js';
import { getTranscriptPath } from '../data/transcripts/store.js';
import { createArtifactsRouter } from '../routes/artifacts.js';
import { permanentlyDeleteSession } from '../routes/sessionPermanentDeletion.js';
import { ArtifactService, type RuntimeArtifactUser } from '../runtime/artifactService.js';
import { ArtifactShareService } from '../runtime/artifactShareService.js';
import { InMemoryArtifactShareStore, PgArtifactShareStore } from '../runtime/artifactShareStore.js';
import { createSessionArtifactLifecycle } from '../runtime/sessionArtifactLifecycle.js';
import { InMemoryArtifactStore, LocalArtifactBlobStore } from '../runtime/artifactStore.js';

const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const SESSION_2 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OWNER: RuntimeArtifactUser = { sub: 'user-1', username: 'alice', role: 'user', tenantId: 'kaiyan' };
const SECRET = 'persistent-artifact-share-test-secret';

async function startServer(
  artifactService: ArtifactService,
  artifactShareService: ArtifactShareService,
  user?: RuntimeArtifactUser,
): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use('/api', createArtifactsRouter({ artifactService, artifactShareService }));
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}` });
    });
  });
}

function stopServer(server: Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

function createStrictSingleConnectionLockPool() {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  let leased = false;
  const release = vi.fn(() => { leased = false; });
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
    release,
  };
  const connect = vi.fn(async () => {
    if (leased) throw new Error('strict lockPool max=1 re-entry');
    leased = true;
    return client;
  });
  return { calls, connect, release, lockPool: { connect } };
}

describe('ArtifactShare backend', () => {
  let agentCwd: string;
  let blobRoot: string;
  let artifactStore: InMemoryArtifactStore;
  let blobStore: LocalArtifactBlobStore;
  let shareStore: InMemoryArtifactShareStore;
  let artifactService: ArtifactService;
  let shareService: ArtifactShareService;
  let now: Date;

  beforeEach(async () => {
    agentCwd = await mkdtemp(join(tmpdir(), 'artifact-share-agent-'));
    blobRoot = await mkdtemp(join(tmpdir(), 'artifact-share-blob-'));
    artifactStore = new InMemoryArtifactStore();
    blobStore = new LocalArtifactBlobStore({ rootDir: blobRoot });
    now = new Date('2026-08-22T08:00:00.000Z');
    shareStore = new InMemoryArtifactShareStore(() => new Date(now));
    artifactService = new ArtifactService({
      artifactStore,
      blobStore,
      agentCwd,
      signingSecret: 'artifact-read-test-secret',
      isArtifactPinned: artifactId => shareStore.isArtifactPinned(artifactId),
      withBlobLock: (uri, operation) => shareStore.withBlobLock(uri, operation),
    });
    shareService = new ArtifactShareService({
      store: shareStore,
      artifactService,
      signingSecret: SECRET,
      now: () => new Date(now),
    });
    const transcriptPath = getTranscriptPath(join(agentCwd, 'kaiyan', OWNER.sub), SESSION_ID);
    await writeSessionMeta(transcriptPath, {
      userId: OWNER.sub,
      username: OWNER.username,
      tenantId: OWNER.tenantId,
      channel: 'web',
      createdAt: now.toISOString(),
    });
  });

  afterEach(async () => {
    await Promise.all([
      rm(agentCwd, { recursive: true, force: true }),
      rm(blobRoot, { recursive: true, force: true }),
    ]);
  });

  it('is owner-only and fails closed for cross-user, cross-tenant, and admins acting for an owner', async () => {
    const artifact = await artifactService.createFromBytes({ sessionId: SESSION_ID, data: 'private', fileName: 'private.txt' });
    const deniedUsers: RuntimeArtifactUser[] = [
      { sub: 'user-2', username: 'bob', role: 'user', tenantId: 'kaiyan' },
      { sub: OWNER.sub, username: OWNER.username, role: 'user', tenantId: 'other-tenant' },
      { sub: 'admin-1', username: 'admin', role: 'admin', tenantId: 'kaiyan' },
      { sub: 'platform-admin', username: 'root', role: 'admin', tenantId: 'pantheon' },
    ];
    for (const user of deniedUsers) {
      await expect(shareService.upsert(artifact.artifactId, user, {})).rejects.toMatchObject({ statusCode: 404 });
    }
    await expect(shareService.upsert(artifact.artifactId, undefined, {})).rejects.toMatchObject({ statusCode: 401 });

    const share = await shareService.upsert(artifact.artifactId, OWNER, {});
    expect(share.publicPath).toBe(`/public/artifacts/${encodeURIComponent(share.token)}`);
    expect(Date.parse(share.expiresAt) - now.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('serializes soft deletion with share upsert so a deleted session cannot regain an active link', async () => {
    const artifact = await artifactService.createFromBytes({ sessionId: SESSION_ID, data: 'race', fileName: 'race.txt' });
    const lifecycle = createSessionArtifactLifecycle(shareStore, artifactService)!;
    let releaseDelete!: () => void;
    let signalDeleteStarted!: () => void;
    const deleteStarted = new Promise<void>(resolve => { signalDeleteStarted = resolve; });
    const deleteGate = new Promise<void>(resolve => { releaseDelete = resolve; });
    const transcriptPath = getTranscriptPath(join(agentCwd, 'kaiyan', OWNER.sub), SESSION_ID);
    const deletion = lifecycle.withRevoked(SESSION_ID, OWNER.sub, async () => {
      signalDeleteStarted();
      await deleteGate;
      await writeSessionMeta(transcriptPath, {
        userId: OWNER.sub, username: OWNER.username, tenantId: OWNER.tenantId, channel: 'web',
        createdAt: now.toISOString(), deletedAt: now.toISOString(),
      });
    });
    await deleteStarted;
    const upsert = shareService.upsert(artifact.artifactId, OWNER, {}).then(
      value => ({ value }), error => ({ error }),
    );
    await new Promise(resolve => setImmediate(resolve));
    releaseDelete();
    await deletion;

    const outcome = await upsert;
    expect(outcome).toMatchObject({ error: { statusCode: 404 } });
    expect(await shareStore.getCurrent(artifact.artifactId, OWNER.sub)).toBeNull();
  });

  it('stores only the token hash, rebuilds a stable token, and enforces the 30-day TTL', async () => {
    const artifact = await artifactService.createFromBytes({ sessionId: SESSION_ID, data: 'token', fileName: 'token.txt' });
    const created = await shareService.upsert(artifact.artifactId, OWNER, { allowDownload: true });
    expect(await shareStore.getByTokenHash(created.token)).toBeNull();

    const internalRecords = [...((shareStore as unknown as { records: Map<string, Record<string, unknown>> }).records).values()];
    expect(internalRecords).toHaveLength(1);
    expect(internalRecords[0]!.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(internalRecords[0]).not.toHaveProperty('token');
    expect((await shareService.getCurrent(artifact.artifactId, OWNER))?.token).toBe(created.token);
    const updated = await shareService.upsert(artifact.artifactId, OWNER, {});
    expect(updated).toMatchObject({ token: created.token, expiresAt: created.expiresAt, allowDownload: true });

    await expect(shareService.upsert(artifact.artifactId, OWNER, {
      expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000 + 1).toISOString(),
    })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('returns minimal metadata, counts visits, serves active HTML safely, then returns 410 after revoke', async () => {
    const artifact = await artifactService.createFromBytes({
      sessionId: SESSION_ID,
      data: '<script>alert(1)</script>',
      fileName: 'unsafe.html',
      mimeType: 'text/html',
      metadata: { privateNote: 'must-not-leak' },
    });
    const ownerServer = await startServer(artifactService, shareService, OWNER);
    try {
      const missingConfirmation = await fetch(`${ownerServer.baseUrl}/api/artifacts/${artifact.artifactId}/share`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ allowDownload: false }),
      });
      expect(missingConfirmation.status).toBe(400);

      const create = await fetch(`${ownerServer.baseUrl}/api/artifacts/${artifact.artifactId}/share`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmPublicArtifact: true, allowDownload: false }),
      });
      expect(create.status).toBe(200);
      const { share } = await create.json() as { share: { token: string } };

      const first = await fetch(`${ownerServer.baseUrl}/api/share/artifacts/${share.token}`);
      expect(first.status).toBe(200);
      const firstBody = await first.json() as Record<string, any>;
      expect(firstBody.share.accessCount).toBe(1);
      expect(firstBody.artifact).toEqual(expect.objectContaining({
        kind: 'file', fileName: 'unsafe.html', mimeType: 'text/html', sizeBytes: 25,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }));
      expect(JSON.stringify(firstBody)).not.toContain('privateNote');
      expect(JSON.stringify(firstBody)).not.toContain(SESSION_ID);

      const second = await fetch(`${ownerServer.baseUrl}/api/share/artifacts/${share.token}`);
      expect((await second.json() as { share: { accessCount: number } }).share.accessCount).toBe(2);

      const content = await fetch(`${ownerServer.baseUrl}/api/share/artifacts/${share.token}/content`);
      expect(content.status).toBe(200);
      expect(content.headers.get('content-disposition')).toMatch(/^attachment;/);
      expect(content.headers.get('x-content-type-options')).toBe('nosniff');
      expect(content.headers.get('content-security-policy')).toContain('sandbox');
      await expect(content.text()).resolves.toContain('<script>');

      const blobRead = vi.spyOn(blobStore, 'get');
      const head = await fetch(`${ownerServer.baseUrl}/api/share/artifacts/${share.token}/content`, { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(head.headers.get('content-length')).toBe('25');
      expect(blobRead).not.toHaveBeenCalled();

      const revoke = await fetch(`${ownerServer.baseUrl}/api/artifacts/${artifact.artifactId}/share`, { method: 'DELETE' });
      expect(revoke.status).toBe(200);
      expect((await fetch(`${ownerServer.baseUrl}/api/share/artifacts/${share.token}`)).status).toBe(410);
      expect((await fetch(`${ownerServer.baseUrl}/api/share/artifacts/not-a-token`)).status).toBe(404);
    } finally {
      await stopServer(ownerServer.server);
    }
  });

  it('returns 410 after expiry and releases the GC pin after expiry or revoke', async () => {
    const artifact = await artifactService.createFromBytes({ sessionId: SESSION_ID, data: 'pinned', fileName: 'pinned.txt' });
    artifact.createdAt = '2020-01-01T00:00:00.000Z';
    const share = await shareService.upsert(artifact.artifactId, OWNER, {
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    });

    expect(await artifactService.pruneExpiredArtifacts(1)).toEqual({ scanned: 1, deleted: 0 });
    now = new Date(now.getTime() + 60_001);
    await expect(shareService.resolvePublicShare(share.token)).rejects.toMatchObject({ statusCode: 410 });
    expect(await artifactService.pruneExpiredArtifacts(1)).toEqual({ scanned: 1, deleted: 1 });
  });

  it('keeps a shared blob URI until its final artifact metadata reference is deleted', async () => {
    const first = await artifactService.createFromBytes({ sessionId: SESSION_ID, data: 'same-blob', fileName: 'one.txt' });
    const second = await artifactStore.create({
      sessionId: SESSION_2,
      kind: 'file',
      uri: first.uri,
      mimeType: first.mimeType,
      sizeBytes: first.sizeBytes,
      sha256: first.sha256,
      metadata: { fileName: 'two.txt' },
    });

    await Promise.all([
      artifactService.deleteArtifactsForSessions([SESSION_ID]),
      artifactService.deleteArtifactsForSessions([SESSION_2]),
    ]);
    await expect(blobStore.get(second.uri)).rejects.toThrow();
  });

  it('reuses the PG lock transaction for nested artifact-to-blob GC locks', async () => {
    const strict = createStrictSingleConnectionLockPool();
    const pgPool = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
    const pgStore = new PgArtifactShareStore({
      pool: pgPool as never,
      lockPool: strict.lockPool as never,
      tablePrefix: 'test',
    });
    const store = new InMemoryArtifactStore();
    const service = new ArtifactService({
      artifactStore: store,
      blobStore,
      agentCwd,
      isArtifactPinned: artifactId => pgStore.isArtifactPinned(artifactId),
      withArtifactLock: (artifactId, operation) => pgStore.withArtifactLock(artifactId, operation),
      withBlobLock: (uri, operation) => pgStore.withBlobLock(uri, operation),
    });
    const created = await service.createFromBytes({ sessionId: SESSION_ID, data: 'stale' });
    created.createdAt = '2020-01-01T00:00:00.000Z';

    await expect(service.pruneExpiredArtifacts(1)).resolves.toEqual({ scanned: 1, deleted: 1 });
    expect(strict.connect).toHaveBeenCalledOnce();
    expect(strict.release).toHaveBeenCalledOnce();
    expect(strict.calls.filter(call => call.sql.includes('pg_advisory_xact_lock')).map(call => call.params?.[0])).toEqual([
      `artifact-share:artifact:${created.artifactId}`,
      `artifact-share:blob:${created.uri}`,
    ]);
  });

  it('reuses the PG lock transaction for nested session-to-blob permanent deletion locks', async () => {
    const strict = createStrictSingleConnectionLockPool();
    const pgPool = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
    const pgStore = new PgArtifactShareStore({
      pool: pgPool as never,
      lockPool: strict.lockPool as never,
      tablePrefix: 'test',
    });
    const store = new InMemoryArtifactStore();
    const service = new ArtifactService({
      artifactStore: store,
      blobStore,
      agentCwd,
      withBlobLock: (uri, operation) => pgStore.withBlobLock(uri, operation),
    });
    const created = await service.createFromBytes({ sessionId: SESSION_ID, data: 'deleted' });
    const lifecycle = createSessionArtifactLifecycle(pgStore, service)!;

    await expect(permanentlyDeleteSession({
      sessionId: SESSION_ID,
      ownerUserId: OWNER.sub,
      hasTranscript: true,
      artifactLifecycle: lifecycle,
      isStillDeleted: async () => true,
      deleteTranscriptPreservingMeta: async () => true,
      deleteMetaAndSidecar: async () => true,
    })).resolves.toBe(true);
    expect(strict.connect).toHaveBeenCalledOnce();
    expect(strict.release).toHaveBeenCalledOnce();
    expect(await store.get(created.artifactId)).toBeNull();
    expect(strict.calls.filter(call => call.sql.includes('pg_advisory_xact_lock')).map(call => call.params?.[0])).toEqual([
      `artifact-share:session:${SESSION_ID}`,
      `artifact-share:blob:${created.uri}`,
    ]);
  });

  it('acquires artifact and session advisory locks on one PG connection in stable order', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: async (sql: string, params?: unknown[]) => { calls.push({ sql, params }); return { rows: [] }; },
      release: vi.fn(),
    };
    const store = new PgArtifactShareStore({
      pool: { query: vi.fn() } as never,
      lockPool: { connect: async () => client } as never,
      tablePrefix: 'test',
    });
    await expect(store.withArtifactSessionLock('artifact-1', SESSION_ID, async () => 'done')).resolves.toBe('done');
    expect(calls.filter(call => call.sql.includes('pg_advisory_xact_lock')).map(call => call.params?.[0])).toEqual([
      'artifact-share:artifact:artifact-1',
      `artifact-share:session:${SESSION_ID}`,
    ]);
    expect(calls.map(call => call.sql)).toEqual(expect.arrayContaining(['BEGIN', 'COMMIT']));
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('PG schema and writes contain token_hash but no plaintext token column', async () => {
    const sql: string[] = [];
    const fakePool = {
      query: async (statement: string) => { sql.push(statement); return { rows: [], rowCount: 0 }; },
    };
    const store = new PgArtifactShareStore({ pool: fakePool as never, lockPool: fakePool as never, tablePrefix: 'test' });
    await store.init();
    const schemaSql = sql.join('\n');
    expect(schemaSql).toContain('token_hash TEXT UNIQUE NOT NULL');
    expect(schemaSql).not.toMatch(/\btoken\s+TEXT/i);
  });
});

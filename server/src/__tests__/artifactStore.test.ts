import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const trustedFileHooks = vi.hoisted(() => ({
  afterOpen: undefined as undefined | (() => Promise<void>),
}));

vi.mock('../security/trustedFile.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../security/trustedFile.js')>();
  return {
    ...actual,
    openTrustedFile: async (...args: Parameters<typeof actual.openTrustedFile>) => {
      const opened = await actual.openTrustedFile(...args);
      try {
        await trustedFileHooks.afterOpen?.();
        return opened;
      } catch (error) {
        await opened.handle.close();
        throw error;
      }
    },
  };
});

import { InMemoryArtifactStore, LocalArtifactBlobStore } from '../runtime/artifactStore.js';
import { InMemoryArtifactShareStore } from '../runtime/artifactShareStore.js';
import { ArtifactService } from '../runtime/artifactService.js';
import { getTranscriptPath } from '../data/transcripts/store.js';
import { writeSessionMeta } from '../data/transcripts/meta.js';
import { PlatformToolRuntime } from '../agent/toolRuntime.js';

afterEach(() => {
  trustedFileHooks.afterOpen = undefined;
});

describe('LocalArtifactBlobStore', () => {
  it('stores immutable blobs under unique keys and returns checksum metadata', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'artifact-blob-'));
    try {
      const store = new LocalArtifactBlobStore({ rootDir: root });
      const put = await store.put({ data: 'hello artifact', contentType: 'text/plain', extension: 'txt' });
      const second = await store.put({ data: 'hello artifact', contentType: 'text/plain', extension: 'txt' });

      expect(put.uri).toMatch(/^local:\/\//);
      expect(second.uri).not.toBe(put.uri);
      expect(second.sha256).toBe(put.sha256);
      expect(put.sizeBytes).toBe(Buffer.byteLength('hello artifact'));
      expect(put.sha256).toMatch(/^[a-f0-9]{64}$/);
      await expect(store.get(put.uri)).resolves.toEqual(Buffer.from('hello artifact'));
      await expect(store.createReadUrl(put.uri)).resolves.toBe(put.uri);
      await store.delete(put.uri);
      await expect(store.get(put.uri)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });



  it('uses publicBaseUrl for local read URLs without signing semantics', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'artifact-blob-'));
    try {
      const store = new LocalArtifactBlobStore({ rootDir: root, publicBaseUrl: 'https://artifacts.example.test/base/' });
      const put = await store.put({ data: 'public', extension: 'bad/slash' });
      const url = await store.createReadUrl(put.uri, { expiresInSeconds: 60 });
      expect(url).toMatch(/^https:\/\/artifacts\.example\.test\/base\//);
      expect(url).not.toContain('bad/slash');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects path traversal local artifact URIs', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'artifact-blob-'));
    try {
      const store = new LocalArtifactBlobStore({ rootDir: root });
      await expect(store.get('local://../secret')).rejects.toThrow(/unsafe local artifact uri/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('createFromWorkspaceFile rejects an ancestor symlink instead of reading outside the workspace', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'artifact-boundary-'));
    const root = path.join(base, 'workspace');
    const outside = path.join(base, 'outside');
    const blobRoot = path.join(base, 'blobs');
    try {
      await mkdir(root, { recursive: true });
      await mkdir(outside);
      await writeFile(path.join(outside, 'secret.txt'), 'outside secret');
      await symlink(outside, path.join(root, 'linked'));
      const service = new ArtifactService({
        artifactStore: new InMemoryArtifactStore(),
        blobStore: new LocalArtifactBlobStore({ rootDir: blobRoot }),
        agentCwd: root,
      });

      await expect(service.createFromWorkspaceFile({
        sessionId: 'session-1', workspaceRoot: root, filePath: 'linked/secret.txt',
      })).rejects.toThrow(/Symbolic links|trusted root/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('createFromWorkspaceFile keeps reading the trusted inode across an ancestor rename swap', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'artifact-swap-'));
    const root = path.join(base, 'workspace');
    const outside = path.join(base, 'outside');
    const blobRoot = path.join(base, 'blobs');
    try {
      await mkdir(path.join(root, 'active'), { recursive: true });
      await mkdir(outside);
      await writeFile(path.join(root, 'active', 'result.txt'), 'trusted result');
      await writeFile(path.join(outside, 'result.txt'), 'outside replacement');
      const blobStore = new LocalArtifactBlobStore({ rootDir: blobRoot });
      const service = new ArtifactService({
        artifactStore: new InMemoryArtifactStore(),
        blobStore,
        agentCwd: root,
      });
      const afterOpen = vi.fn(async () => {
        await rename(path.join(root, 'active'), path.join(root, 'active-pinned'));
        await symlink(outside, path.join(root, 'active'));
      });
      trustedFileHooks.afterOpen = afterOpen;

      const artifact = await service.createFromWorkspaceFile({
        sessionId: 'session-1', workspaceRoot: root, filePath: 'active/result.txt',
      });

      expect(afterOpen).toHaveBeenCalledOnce();
      await expect(blobStore.get(artifact.uri)).resolves.toEqual(Buffer.from('trusted result'));
      await expect(readFile(path.join(root, 'active', 'result.txt'), 'utf8')).resolves.toBe('outside replacement');
    } finally {
      trustedFileHooks.afterOpen = undefined;
      await rm(base, { recursive: true, force: true });
    }
  });

  it('createFromWorkspaceFile rejects an absolute path in a different root', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'artifact-cross-root-'));
    const root = path.join(base, 'workspace');
    const outside = path.join(base, 'outside');
    try {
      await mkdir(root, { recursive: true });
      await mkdir(outside);
      const secret = path.join(outside, 'secret.txt');
      await writeFile(secret, 'outside secret');
      const service = new ArtifactService({
        artifactStore: new InMemoryArtifactStore(),
        blobStore: new LocalArtifactBlobStore({ rootDir: path.join(base, 'blobs') }),
        agentCwd: root,
      });

      await expect(service.createFromWorkspaceFile({
        sessionId: 'session-1', workspaceRoot: root, filePath: secret,
      })).rejects.toThrow(/outside workspace/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('platform admin 可按 owner 权限读取自己的会话 artifact', async () => {
    const blobRoot = await mkdtemp(path.join(os.tmpdir(), 'artifact-blob-'));
    try {
      const authorizeContentAccess = vi.fn(async () => false);
      const service = new ArtifactService({
        artifactStore: new InMemoryArtifactStore(),
        blobStore: new LocalArtifactBlobStore({ rootDir: blobRoot }),
        agentCwd: blobRoot,
        resolveSessionTenantId: async () => 'pantheon',
        authorizeContentAccess,
        auditContentAccess: async () => undefined,
      });
      const sessionId = 'session-platform-admin';
      const transcriptPath = getTranscriptPath(path.join(blobRoot, 'pantheon', 'platform-admin'), sessionId);
      await writeSessionMeta(transcriptPath, {
        userId: 'platform-admin',
        username: 'root',
        tenantId: 'pantheon',
        channel: 'web',
        createdAt: new Date().toISOString(),
      });
      const artifact = await service.createFromBytes({ sessionId, data: 'owned' });
      const platformAdmin = { sub: 'platform-admin', username: 'root', role: 'admin' as const, tenantId: 'pantheon' };

      await expect(service.getForUser(artifact.artifactId, platformAdmin)).resolves.toEqual(artifact);
      expect(authorizeContentAccess).not.toHaveBeenCalled();
    } finally {
      await rm(blobRoot, { recursive: true, force: true });
    }
  });

  it('platform admin 跨组织读取无 Grant、有效 Grant、过期 Grant时分别拒绝、放行、拒绝', async () => {
    const blobRoot = await mkdtemp(path.join(os.tmpdir(), 'artifact-blob-'));
    try {
      let grantExpiresAt: number | undefined;
      const auditContentAccess = vi.fn(async () => undefined);
      const service = new ArtifactService({
        artifactStore: new InMemoryArtifactStore(),
        blobStore: new LocalArtifactBlobStore({ rootDir: blobRoot }),
        agentCwd: blobRoot,
        resolveSessionTenantId: async () => 'tenant-customer',
        authorizeContentAccess: async input => Boolean(
          input.tenantId === 'tenant-customer'
          && input.scope === 'session_export'
          && grantExpiresAt
          && grantExpiresAt > Date.now()
        ),
        auditContentAccess,
      });
      const artifact = await service.createFromBytes({ sessionId: 'session-customer', data: 'sensitive' });
      const platformAdmin = { sub: 'platform-admin', username: 'root', role: 'admin' as const, tenantId: 'pantheon' };

      await expect(service.getForUser(artifact.artifactId, platformAdmin)).rejects.toThrow('Artifact not found');
      grantExpiresAt = Date.now() + 60_000;
      await expect(service.getForUser(artifact.artifactId, platformAdmin)).resolves.toEqual(artifact);
      grantExpiresAt = Date.now() - 1;
      await expect(service.getForUser(artifact.artifactId, platformAdmin)).rejects.toThrow('Artifact not found');
      expect(auditContentAccess).toHaveBeenCalledTimes(1);
    } finally {
      await rm(blobRoot, { recursive: true, force: true });
    }
  });

  it('serializes creation with permanent deletion and rejects the post-delete write', async () => {
    const blobRoot = await mkdtemp(path.join(os.tmpdir(), 'artifact-blob-'));
    try {
      const artifactStore = new InMemoryArtifactStore();
      const shareStore = new InMemoryArtifactShareStore();
      let active = true;
      const service = new ArtifactService({
        artifactStore,
        blobStore: new LocalArtifactBlobStore({ rootDir: blobRoot }),
        agentCwd: blobRoot,
        withSessionLock: (sessionId, operation) => shareStore.withSessionLock(sessionId, operation),
        assertSessionActive: async () => active,
      });
      let releaseDelete!: () => void;
      let signalDeleteStarted!: () => void;
      const deleteStarted = new Promise<void>(resolve => { signalDeleteStarted = resolve; });
      const deletion = shareStore.withSessionLock('session-1', async () => {
        signalDeleteStarted();
        await new Promise<void>(resolve => { releaseDelete = resolve; });
        active = false;
      });
      await deleteStarted;
      const creation = service.createFromBytes({ sessionId: 'session-1', data: 'late' });
      releaseDelete();
      await deletion;

      await expect(creation).rejects.toMatchObject({ statusCode: 409 });
      await expect(artifactStore.listForSession('session-1')).resolves.toEqual([]);
    } finally {
      await rm(blobRoot, { recursive: true, force: true });
    }
  });

  it('GC rechecks deliveredAt under the Artifact lock before deleting a stale candidate', async () => {
    const blobRoot = await mkdtemp(path.join(os.tmpdir(), 'artifact-blob-'));
    try {
      const artifactStore = new InMemoryArtifactStore();
      const shareStore = new InMemoryArtifactShareStore();
      const service = new ArtifactService({
        artifactStore,
        blobStore: new LocalArtifactBlobStore({ rootDir: blobRoot }),
        agentCwd: blobRoot,
        isArtifactPinned: id => shareStore.isArtifactPinned(id),
        withArtifactLock: (id, operation) => shareStore.withArtifactLock(id, operation),
      });
      const created = await service.createFromBytes({ sessionId: 'session-1', data: 'durable' });
      await service.markDelivered(created.artifactId);
      vi.spyOn(artifactStore, 'listOlderThan').mockResolvedValue([created]);

      await expect(service.pruneExpiredArtifacts(0)).resolves.toEqual({ scanned: 1, deleted: 0 });
      await expect(artifactStore.get(created.artifactId)).resolves.toMatchObject({ deliveredAt: expect.any(String) });
    } finally {
      await rm(blobRoot, { recursive: true, force: true });
    }
  });

  it('Artifact(create|deliver) registers an immutable file and emits durable delivery metadata', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'artifact-tool-'));
    const blobRoot = await mkdtemp(path.join(os.tmpdir(), 'artifact-blob-'));
    try {
      await mkdir(path.join(root, 'logs'), { recursive: true });
      await writeFile(path.join(root, 'logs', 'result.log'), 'tool artifact');
      const artifactStore = new InMemoryArtifactStore();
      const service = new ArtifactService({
        artifactStore,
        blobStore: new LocalArtifactBlobStore({ rootDir: blobRoot }),
        agentCwd: root,
        signingSecret: 'tool-artifact-signing-secret',
      });
      const tools = new PlatformToolRuntime({ artifactService: service });
      const result = await tools.invoke(
        {
          toolId: 'Artifact',
          input: { action: 'create', file_path: 'logs/result.log', kind: 'log', mime_type: 'text/plain' },
          authorization: { approved: true, source: 'policy_auto' },
        },
        {
          channelContext: { channel: 'web', user: { id: 'u1', username: 'alice', role: 'user' } },
          workspace: {
            root,
            sessionId: '11111111-2222-4333-8444-555555555555',
            id: 'workspace-1',
            executionTarget: 'server-local',
          },
        },
      );
      const parsed = JSON.parse(result?.content ?? '{}') as {
        artifactId?: string;
        kind?: string;
        fileName?: string;
        sourcePath?: string;
        mimeType?: string;
        userVisible?: boolean;
        deliveryInstruction?: string;
      };
      expect(parsed.artifactId).toMatch(/^artifact_/);
      expect(parsed.kind).toBe('log');
      expect(parsed.fileName).toBe('result.log');
      expect(parsed.sourcePath).toBe('logs/result.log');
      expect(parsed.mimeType).toBe('text/plain');
      expect(parsed.userVisible).toBe(false);
      expect(parsed).not.toHaveProperty('fileCardMarker');
      expect(parsed.deliveryInstruction).toContain('Artifact(action="deliver"');

      const delivered = await tools.invoke(
        {
          toolId: 'Artifact',
          input: { action: 'deliver', artifact_id: parsed.artifactId },
          authorization: { approved: true, source: 'policy_auto' },
        },
        {
          channelContext: { channel: 'web', user: { id: 'u1', username: 'alice', role: 'user' } },
          workspace: {
            root,
            sessionId: '11111111-2222-4333-8444-555555555555',
            id: 'workspace-1',
            executionTarget: 'server-local',
          },
        },
      );
      expect(JSON.parse(delivered?.content ?? '{}')).toMatchObject({
        action: 'deliver',
        artifactId: parsed.artifactId,
        fileName: 'result.log',
        userVisible: true,
      });
      expect(delivered?.metadata).toMatchObject({
        artifactAction: 'deliver',
        artifactId: parsed.artifactId,
        artifactKind: 'log',
        fileName: 'result.log',
      });
      expect((await artifactStore.get(parsed.artifactId!))?.deliveredAt).toEqual(expect.any(String));
      await expect(artifactStore.listOlderThan('9999-12-31T23:59:59.999Z')).resolves.toEqual([]);
      await expect(tools.invoke(
        {
          toolId: 'Artifact',
          input: { action: 'deliver', artifact_id: parsed.artifactId },
          authorization: { approved: true, source: 'policy_auto' },
        },
        {
          channelContext: { channel: 'web', user: { id: 'u1', username: 'alice', role: 'user' } },
          workspace: {
            root,
            sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            id: 'workspace-2',
            executionTarget: 'server-local',
          },
        },
      )).rejects.toThrow(/does not belong to the current session/);
      await expect(service.getContentBySignedToken(parsed.artifactId!, 'bad')).rejects.toThrow(/Invalid artifact token/);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(blobRoot, { recursive: true, force: true });
    }
  });
});

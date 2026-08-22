import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { InMemoryArtifactStore, LocalArtifactBlobStore } from '../runtime/artifactStore.js';
import { InMemoryArtifactShareStore } from '../runtime/artifactShareStore.js';
import { ArtifactService } from '../runtime/artifactService.js';
import { PlatformToolRuntime } from '../agent/toolRuntime.js';

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

  it('platform admin 读取跨组织 artifact 必须持有 session_export Grant', async () => {
    const blobRoot = await mkdtemp(path.join(os.tmpdir(), 'artifact-blob-'));
    try {
      let grantActive = false;
      const service = new ArtifactService({
        artifactStore: new InMemoryArtifactStore(),
        blobStore: new LocalArtifactBlobStore({ rootDir: blobRoot }),
        agentCwd: blobRoot,
        resolveSessionTenantId: async () => 'tenant-customer',
        authorizeContentAccess: async input => grantActive
          && input.tenantId === 'tenant-customer'
          && input.scope === 'session_export',
        auditContentAccess: async () => undefined,
      });
      const artifact = await service.createFromBytes({ sessionId: 'session-customer', data: 'sensitive' });
      const platformAdmin = { sub: 'platform-admin', username: 'root', role: 'admin' as const, tenantId: 'pantheon' };
      await expect(service.getForUser(artifact.artifactId, platformAdmin)).rejects.toThrow('Artifact not found');
      grantActive = true;
      await expect(service.getForUser(artifact.artifactId, platformAdmin)).resolves.toEqual(artifact);
      grantActive = false;
      await expect(service.getForUser(artifact.artifactId, platformAdmin)).rejects.toThrow('Artifact not found');
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

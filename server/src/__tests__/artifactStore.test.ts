import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { InMemoryArtifactStore, LocalArtifactBlobStore } from '../runtime/artifactStore.js';
import { ArtifactService } from '../runtime/artifactService.js';
import { PlatformToolRuntime } from '../agent/toolRuntime.js';

describe('LocalArtifactBlobStore', () => {
  it('stores blobs content-addressably and returns checksum metadata', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'artifact-blob-'));
    try {
      const store = new LocalArtifactBlobStore({ rootDir: root });
      const put = await store.put({ data: 'hello artifact', contentType: 'text/plain', extension: 'txt' });

      expect(put.uri).toMatch(/^local:\/\//);
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

  it('CreateArtifact registers a workspace file through the artifact service', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'artifact-tool-'));
    const blobRoot = await mkdtemp(path.join(os.tmpdir(), 'artifact-blob-'));
    try {
      await mkdir(path.join(root, 'logs'), { recursive: true });
      await writeFile(path.join(root, 'logs', 'result.log'), 'tool artifact');
      const service = new ArtifactService({
        artifactStore: new InMemoryArtifactStore(),
        blobStore: new LocalArtifactBlobStore({ rootDir: blobRoot }),
        agentCwd: root,
        signingSecret: 'tool-artifact-signing-secret',
      });
      const tools = new PlatformToolRuntime({ artifactService: service });
      const result = await tools.invoke(
        {
          toolId: 'CreateArtifact',
          input: { file_path: 'logs/result.log', kind: 'log', mime_type: 'text/plain' },
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
        fileCardMarker?: string;
        deliveryInstruction?: string;
      };
      expect(parsed.artifactId).toMatch(/^artifact_/);
      expect(parsed.kind).toBe('log');
      expect(parsed.fileName).toBe('result.log');
      expect(parsed.sourcePath).toBe('logs/result.log');
      expect(parsed.mimeType).toBe('text/plain');
      expect(parsed.userVisible).toBe(false);
      expect(parsed.fileCardMarker).toBe('[FILE]{"filePath":"logs/result.log"}[/FILE]');
      expect(parsed.deliveryInstruction).toContain('not automatically shown to the user');
      await expect(service.getContentBySignedToken(parsed.artifactId!, 'bad')).rejects.toThrow(/Invalid artifact token/);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(blobRoot, { recursive: true, force: true });
    }
  });
});

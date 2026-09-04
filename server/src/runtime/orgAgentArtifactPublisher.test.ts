import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  copyTrustedFile,
  moveTrustedDirectoryIfAbsent,
  openTrustedDirectory,
  readTrustedFile,
  readdir,
  withTrustedFile,
  writeTrustedFileIfAbsent,
} = vi.hoisted(() => ({
  copyTrustedFile: vi.fn(),
  moveTrustedDirectoryIfAbsent: vi.fn(),
  openTrustedDirectory: vi.fn(),
  readTrustedFile: vi.fn(),
  readdir: vi.fn(),
  withTrustedFile: vi.fn(),
  writeTrustedFileIfAbsent: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  readdir,
}));
vi.mock('../security/trustedFile.js', () => ({
  copyTrustedFile,
  moveTrustedDirectoryIfAbsent,
  openTrustedDirectory,
  readTrustedFile,
  withTrustedFile,
  writeTrustedFileIfAbsent,
}));

import {
  collectOrgAgentArtifactManifest,
  parseOrgAgentArtifactManifest,
  publishOrgAgentArtifacts,
} from './orgAgentArtifactPublisher.js';

function entry(name: string, kind: 'file' | 'directory' | 'symlink') {
  return {
    name,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'directory',
    isSymbolicLink: () => kind === 'symlink',
  };
}

describe('组织 Agent 任务产物', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openTrustedDirectory.mockResolvedValue({ fdPath: '/proc/mock', handle: { close: vi.fn() } });
  });

  it('递归生成稳定 manifest，并拒绝路径逃逸', async () => {
    readdir
      .mockResolvedValueOnce([entry('报告.txt', 'file'), entry('数据', 'directory')])
      .mockResolvedValueOnce([entry('明细.csv', 'file')]);
    withTrustedFile.mockImplementation(async (_root, path, operation) => {
      const content = Buffer.from(path);
      const stats = { size: content.byteLength, mtimeMs: 1, ino: 2 };
      return await operation({
        handle: { readFile: async () => content, stat: async () => stats },
        stats,
      });
    });

    const manifest = await collectOrgAgentArtifactManifest('/task');
    expect(manifest.files.map((file) => file.path)).toEqual(['报告.txt', '数据/明细.csv']);
    expect(manifest.totalBytes).toBe(Buffer.byteLength('报告.txt数据/明细.csv'));
    expect(() =>
      parseOrgAgentArtifactManifest({
        ...manifest,
        files: [{ ...manifest.files[0], path: '../越界.txt' }],
        totalBytes: manifest.files[0].size,
      }),
    ).toThrow('ORG_AGENT_ARTIFACT_MANIFEST_INVALID');
  });

  it('完整 staging 校验通过后才原子暴露，多次发布相同内容保持幂等', async () => {
    const content = Buffer.from('artifact');
    const digest = `sha256:${await import('node:crypto').then(({ createHash }) =>
      createHash('sha256').update(content).digest('hex'),
    )}`;
    const manifest = {
      version: 1 as const,
      files: [{ path: 'a.txt', digest, size: content.length }],
      totalBytes: content.length,
      capturedAt: '2026-09-04T00:00:00.000Z',
    };
    let markerReads = 0;
    readTrustedFile.mockImplementation(async (_root, path, encoding) => {
      if (String(path).endsWith('.ky-publish-manifest.json')) {
        markerReads += 1;
        if (markerReads === 1) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return encoding === 'utf8'
          ? JSON.stringify(manifest)
          : Buffer.from(JSON.stringify(manifest));
      }
      return content;
    });
    writeTrustedFileIfAbsent.mockResolvedValue(true);
    await expect(
      publishOrgAgentArtifacts({
        taskRoot: '/task',
        stagingRoot: '/staging',
        sharedRoot: '/shared',
        publishedRoot: 'published/work/attempt',
        manifest,
      }),
    ).resolves.toMatchObject({
      publishedRoot: 'published/work/attempt',
    });
    expect(moveTrustedDirectoryIfAbsent).toHaveBeenCalledOnce();

    vi.clearAllMocks();
    readTrustedFile.mockImplementation(async (_root, path, encoding) =>
      String(path).endsWith('.ky-publish-manifest.json')
        ? encoding === 'utf8'
          ? JSON.stringify(manifest)
          : Buffer.from(JSON.stringify(manifest))
        : content,
    );
    await expect(
      publishOrgAgentArtifacts({
        taskRoot: '/task',
        stagingRoot: '/staging',
        sharedRoot: '/shared',
        publishedRoot: 'published/work/attempt',
        manifest,
      }),
    ).resolves.toMatchObject({
      publishedRoot: 'published/work/attempt',
    });
    expect(copyTrustedFile).not.toHaveBeenCalled();
    expect(moveTrustedDirectoryIfAbsent).not.toHaveBeenCalled();

    readTrustedFile.mockImplementation(async (_root, path, encoding) =>
      String(path).endsWith('.ky-publish-manifest.json')
        ? encoding === 'utf8'
          ? JSON.stringify(manifest)
          : Buffer.from(JSON.stringify(manifest))
        : Buffer.from('different'),
    );
    await expect(
      publishOrgAgentArtifacts({
        taskRoot: '/task',
        stagingRoot: '/staging',
        sharedRoot: '/shared',
        publishedRoot: 'published/work/attempt',
        manifest,
      }),
    ).rejects.toThrow('ORG_AGENT_ARTIFACT_PUBLISH_INTEGRITY_FAILED');
  });

  it('多文件 staging 中途失败时不暴露 final published 目录', async () => {
    const content = Buffer.from('artifact');
    const digest = `sha256:${await import('node:crypto').then(({ createHash }) =>
      createHash('sha256').update(content).digest('hex'),
    )}`;
    const manifest = {
      version: 1 as const,
      files: [
        { path: 'a.txt', digest, size: content.length },
        { path: 'b.txt', digest, size: content.length },
      ],
      totalBytes: content.length * 2,
      capturedAt: '2026-09-04T00:00:00.000Z',
    };
    readTrustedFile
      .mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }))
      .mockResolvedValue(content);
    copyTrustedFile
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('copy failed'));
    await expect(
      publishOrgAgentArtifacts({
        taskRoot: '/task',
        stagingRoot: '/staging',
        sharedRoot: '/shared',
        publishedRoot: 'published/work/attempt',
        manifest,
      }),
    ).rejects.toThrow('copy failed');
    expect(writeTrustedFileIfAbsent).not.toHaveBeenCalled();
    expect(moveTrustedDirectoryIfAbsent).not.toHaveBeenCalled();
  });

  it('并发发布相同 manifest 使用独立 staging，并共同收敛到同一原子结果', async () => {
    const content = Buffer.from('artifact');
    const digest = `sha256:${await import('node:crypto').then(({ createHash }) =>
      createHash('sha256').update(content).digest('hex'),
    )}`;
    const manifest = {
      version: 1 as const,
      files: [{ path: 'a.txt', digest, size: content.length }],
      totalBytes: content.length,
      capturedAt: '2026-09-04T00:00:00.000Z',
    };
    let finalPublished = false;
    let initialReads = 0;
    readTrustedFile.mockImplementation(async (root, path, encoding) => {
      if (root === '/shared' && String(path).endsWith('.ky-publish-manifest.json')) {
        if (!finalPublished && initialReads++ < 2)
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return encoding === 'utf8'
          ? JSON.stringify(manifest)
          : Buffer.from(JSON.stringify(manifest));
      }
      return content;
    });
    copyTrustedFile.mockResolvedValue(undefined);
    writeTrustedFileIfAbsent.mockResolvedValue(true);
    moveTrustedDirectoryIfAbsent.mockImplementation(async () => {
      if (finalPublished) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      finalPublished = true;
    });
    const input = {
      taskRoot: '/task',
      stagingRoot: '/staging',
      sharedRoot: '/shared',
      publishedRoot: 'published/work/attempt',
      manifest,
    };

    await expect(
      Promise.all([publishOrgAgentArtifacts(input), publishOrgAgentArtifacts(input)]),
    ).resolves.toHaveLength(2);

    const stagingDestinations = copyTrustedFile.mock.calls.map((call) => String(call[3]));
    expect(stagingDestinations).toHaveLength(2);
    expect(stagingDestinations[0].split('/')[0]).not.toBe(stagingDestinations[1].split('/')[0]);
  });
});

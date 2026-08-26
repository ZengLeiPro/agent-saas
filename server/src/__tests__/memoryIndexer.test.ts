import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryIndexer } from '../memory/index/indexer.js';
import type { MemoryIndexConfig } from '../memory/index/types.js';

const originalFetch = globalThis.fetch;

function testConfig(dbDir: string): MemoryIndexConfig {
  return {
    enabled: true,
    dbDir,
    embedding: {
      baseUrl: 'https://embedding.example.invalid',
      apiKey: 'sk-test',
      model: 'text-embedding-test',
      dimensions: 3,
    },
    chunking: { tokens: 80, overlap: 10 },
    search: {
      vectorWeight: 0.2,
      textWeight: 0.8,
      maxResults: 5,
      minScore: 0,
    },
    temporalDecay: { enabled: false, halfLifeDays: 30 },
    sync: { debounceMs: 10 },
  };
}

describe('MemoryIndexer', () => {
  const cleanupDirs = new Set<string>();

  beforeEach(() => {
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { input?: string[] };
      const inputs = Array.isArray(body.input) ? body.input : [];
      return new Response(JSON.stringify({
        data: inputs.map(() => ({ embedding: [1, 0, 0] })),
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    for (const dir of cleanupDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    cleanupDirs.clear();
  });

  it('indexes root MEMORY.md for MemorySearch', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'memory-index-workspace-'));
    cleanupDirs.add(workspace);
    await mkdir(join(workspace, 'memory'), { recursive: true });
    await writeFile(join(workspace, 'MEMORY.md'), [
      '# 长期记忆',
      '',
      '- 曾磊：开沿科技创始人、CEO。',
      '- 销售团队：陈育新、黄思霖、许锐宏、彭一宁。',
    ].join('\n'));
    await writeFile(join(workspace, 'memory', 'questions.md'), '# Agent 提问记录\n');

    const dbDir = join(workspace, '.memory-index');
    const indexer = new MemoryIndexer(workspace, testConfig(dbDir), undefined, { skipWatch: true });
    try {
      await indexer.forceSync();
      const result = await indexer.search('曾磊在开沿科技担任什么角色，销售团队有哪些成员', {
        keywords: '曾磊 CEO 陈育新 黄思霖 许锐宏 彭一宁',
        maxResults: 5,
        minScore: 0,
      });

      const memoryResult = result.results.find((item) => item.path === 'MEMORY.md');
      expect(memoryResult?.snippet).toContain('曾磊');
      expect(memoryResult?.snippet).toContain('陈育新');
    } finally {
      await indexer.close();
    }
  });

  it('isolates same-named workspaces by tenant in separate SQLite files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memory-index-tenants-'));
    cleanupDirs.add(root);
    const workspaceA = join(root, 'tenant-a', 'shared-workspace');
    const workspaceB = join(root, 'tenant-b', 'shared-workspace');
    const dbDir = join(root, 'indexes');
    await mkdir(join(workspaceA, 'memory'), { recursive: true });
    await mkdir(join(workspaceB, 'memory'), { recursive: true });
    await writeFile(join(workspaceA, 'MEMORY.md'), '甲租户专属记忆：青铜齿轮。\n');
    await writeFile(join(workspaceB, 'MEMORY.md'), '乙租户专属记忆：银色罗盘。\n');

    const indexerA = new MemoryIndexer(workspaceA, testConfig(dbDir), undefined, { skipWatch: true });
    const indexerB = new MemoryIndexer(workspaceB, testConfig(dbDir), undefined, { skipWatch: true });
    try {
      await Promise.all([indexerA.forceSync(), indexerB.forceSync()]);
      expect(indexerA.getStatus().dbPath).toMatch(new RegExp(`${dbDir}/v2/[a-f0-9]{64}\\.sqlite$`));
      expect(indexerB.getStatus().dbPath).toMatch(new RegExp(`${dbDir}/v2/[a-f0-9]{64}\\.sqlite$`));
      expect(indexerA.getStatus().dbPath).not.toBe(indexerB.getStatus().dbPath);

      const resultA = await indexerA.search('青铜齿轮', { keywords: '青铜齿轮', minScore: 0 });
      const resultB = await indexerB.search('银色罗盘', { keywords: '银色罗盘', minScore: 0 });
      expect(resultA.results.some((item) => item.snippet.includes('青铜齿轮'))).toBe(true);
      expect(resultA.results.some((item) => item.snippet.includes('银色罗盘'))).toBe(false);
      expect(resultB.results.some((item) => item.snippet.includes('银色罗盘'))).toBe(true);
      expect(resultB.results.some((item) => item.snippet.includes('青铜齿轮'))).toBe(false);
    } finally {
      await Promise.all([indexerA.close(), indexerB.close()]);
    }
  });

  it('serializes concurrent syncs for the same workspace across indexer instances', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memory-index-lease-'));
    cleanupDirs.add(root);
    const workspace = join(root, 'tenant-a', 'shared-workspace');
    const dbDir = join(root, 'indexes');
    await mkdir(join(workspace, 'memory'), { recursive: true });
    await writeFile(join(workspace, 'MEMORY.md'), '并发同步记忆：紫色沙漏。\n');

    const indexerA = new MemoryIndexer(workspace, testConfig(dbDir), undefined, { skipWatch: true });
    const indexerB = new MemoryIndexer(workspace, testConfig(dbDir), undefined, { skipWatch: true });
    try {
      await Promise.all([indexerA.forceSync(), indexerB.forceSync()]);
      expect(indexerA.getStatus().dbPath).toBe(indexerB.getStatus().dbPath);
      expect(indexerA.getStatus().fileCount).toBe(1);
      expect(indexerA.getStatus().chunkCount).toBe(1);
      expect(indexerB.getStatus().chunkCount).toBe(1);
    } finally {
      await Promise.all([indexerA.close(), indexerB.close()]);
    }
  });

  it('fails closed when a memory source changes during embedding and succeeds on retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memory-index-source-race-'));
    cleanupDirs.add(root);
    const workspace = join(root, 'tenant-a', 'workspace-a');
    const memoryPath = join(workspace, 'MEMORY.md');
    const dbDir = join(root, 'indexes');
    await mkdir(join(workspace, 'memory'), { recursive: true });
    await writeFile(memoryPath, '初始记忆：黑色方舟。\n');

    const indexer = new MemoryIndexer(workspace, testConfig(dbDir), undefined, { skipWatch: true });
    try {
      await indexer.forceSync();
      await writeFile(memoryPath, '待提交记忆：白色灯塔。\n');

      let signalStarted!: () => void;
      let releaseEmbedding!: () => void;
      const started = new Promise<void>((resolveStarted) => { signalStarted = resolveStarted; });
      const gate = new Promise<void>((resolveGate) => { releaseEmbedding = resolveGate; });
      globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        signalStarted();
        await gate;
        const body = JSON.parse(String(init?.body ?? '{}')) as { input?: string[] };
        const inputs = Array.isArray(body.input) ? body.input : [];
        return new Response(JSON.stringify({
          data: inputs.map(() => ({ embedding: [1, 0, 0] })),
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;

      const staleSync = indexer.forceSync();
      await started;
      await writeFile(memoryPath, '最终记忆：金色罗盘。\n');
      releaseEmbedding();
      await expect(staleSync).rejects.toThrow('memory source changed during indexing');

      await indexer.forceSync();
      const result = await indexer.search('金色罗盘', { keywords: '金色罗盘', minScore: 0 });
      expect(result.results.some((item) => item.snippet.includes('金色罗盘'))).toBe(true);
      expect(indexer.getStatus().chunkCount).toBe(1);
    } finally {
      await indexer.close();
    }
  });

  it('keeps an exact FTS-only hit above the production hybrid threshold', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'memory-index-hybrid-'));
    cleanupDirs.add(workspace);
    await mkdir(join(workspace, 'memory'), { recursive: true });
    const distractors = Array.from({ length: 20 }, (_, index) => [
      `## 干扰项 ${index}`,
      `普通语义内容 ${index} ${'x'.repeat(120)}`,
    ].join('\n'));
    await writeFile(join(workspace, 'MEMORY.md'), [
      '# 长期记忆',
      ...distractors,
      '## 唯一事实',
      `Verdance（翠境生图 SaaS）已完全不推 ${'y'.repeat(120)}`,
    ].join('\n'));

    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { input?: string[] };
      const inputs = Array.isArray(body.input) ? body.input : [];
      return new Response(JSON.stringify({
        data: inputs.map((text) => ({
          embedding: text === 'Verdance' || !text.includes('Verdance') ? [1, 0, 0] : [0, 1, 0],
        })),
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const config = testConfig(join(workspace, '.memory-index'));
    config.search = { vectorWeight: 0.7, textWeight: 0.3, maxResults: 5, minScore: 0.3 };
    const indexer = new MemoryIndexer(workspace, config, undefined, { skipWatch: true });
    try {
      await indexer.forceSync();
      const result = await indexer.search('Verdance', { keywords: 'Verdance' });
      const exactHit = result.results.find((item) => item.snippet.includes('已完全不推'));
      expect(exactHit?.score).toBeCloseTo(0.3, 6);
      expect(result.results[0]!.score).toBeCloseTo(0.7, 6);
    } finally {
      await indexer.close();
    }
  });

  it('falls back to normalized FTS results when query embeddings are unavailable', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'memory-index-keyword-fallback-'));
    cleanupDirs.add(workspace);
    await mkdir(join(workspace, 'memory'), { recursive: true });
    await writeFile(join(workspace, 'MEMORY.md'), '唯一代号：青铜齿轮。\n');

    const config = testConfig(join(workspace, '.memory-index'));
    config.search = { vectorWeight: 0.7, textWeight: 0.3, maxResults: 5, minScore: 0.3 };
    const indexer = new MemoryIndexer(workspace, config, undefined, { skipWatch: true });
    try {
      await indexer.forceSync();
      globalThis.fetch = vi.fn(async () => { throw new Error('embedding unavailable'); }) as typeof fetch;
      const result = await indexer.search('青铜齿轮', { keywords: '青铜齿轮' });
      expect(result.results.find((item) => item.snippet.includes('青铜齿轮'))?.score).toBeCloseTo(0.3, 6);

      config.search = { ...config.search, vectorWeight: 0, textWeight: 0, minScore: 0 };
      await expect(indexer.search('青铜齿轮', { keywords: '青铜齿轮' }))
        .resolves.toMatchObject({ results: [] });
    } finally {
      await indexer.close();
    }
  });

  it('syncIfStale builds and refreshes the index with bounded search-path sync', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'memory-index-stale-'));
    cleanupDirs.add(workspace);
    await mkdir(join(workspace, 'memory'), { recursive: true });
    await writeFile(join(workspace, 'MEMORY.md'), '第一版记忆：青铜齿轮。\n');

    const dbDir = join(workspace, '.memory-index');
    const indexer = new MemoryIndexer(workspace, testConfig(dbDir), undefined, { skipWatch: true });
    try {
      await indexer.syncIfStale({ emptyIndexMaxWaitMs: 2_000, manifestCheckIntervalMs: 0 });
      let result = await indexer.search('青铜齿轮', {
        keywords: '青铜齿轮',
        maxResults: 5,
        minScore: 0,
      });
      expect(result.results.some((item) => item.snippet.includes('青铜齿轮'))).toBe(true);

      await writeFile(join(workspace, 'MEMORY.md'), '第二版记忆：银色罗盘。\n');
      await indexer.syncIfStale({ maxWaitMs: 2_000, manifestCheckIntervalMs: 0 });
      result = await indexer.search('银色罗盘', {
        keywords: '银色罗盘',
        maxResults: 5,
        minScore: 0,
      });
      expect(result.results.some((item) => item.snippet.includes('银色罗盘'))).toBe(true);
    } finally {
      await indexer.close();
    }
  });
});

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

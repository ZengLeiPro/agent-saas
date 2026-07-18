import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { chunkMarkdown, hashText } from '../memory/index/chunker.js';
import {
  applyMMR,
  applyTemporalDecay,
  buildFtsQuery,
  mergeHybridResults,
  searchKeyword,
  searchVector,
} from '../memory/index/search.js';
import type { SearchResult } from '../memory/index/types.js';
import {
  releaseMemoryMaintenance,
  resetMemoryMaintenanceLocks,
  tryAcquireMemoryMaintenance,
} from '../memory/maintenanceLock.js';

/**
 * memory 层未覆盖行为补测：markdown 切分（chunker）、用户级维护 try-lock、
 * 搜索的纯函数（FTS 查询构建 / 混合合并 / MMR 多样性 / 时间衰减）以及
 * 关键词与向量检索（后者走 JS 内存回退路径，不依赖 sqlite-vec 扩展）。
 */

describe('memory chunker: chunkMarkdown', () => {
  it('空内容返回单个空 chunk（split 产生一个空行）', () => {
    const chunks = chunkMarkdown('', { tokens: 100, overlap: 10 });
    // '' split('\n') → [''], 不是空数组，故产出 1 个 chunk
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe('');
    expect(chunks[0]!.startLine).toBe(1);
    expect(chunks[0]!.endLine).toBe(1);
  });

  it('按标题拆分为多个 chunk，并写入正确的行号与内容 hash', () => {
    // tokens=50 → maxChars=200, minChars=50；每个 section 介于 50~200 字符之间：
    // 既大于合并阈值（不被并入前块），又不超过 maxChars（不被二次硬切）。
    const filler = 'x'.repeat(60);
    const content = [
      `# 章节一 ${filler}`,
      `# 章节二 ${filler}`,
    ].join('\n');
    const chunks = chunkMarkdown(content, { tokens: 50, overlap: 0 });

    expect(chunks.length).toBe(2);
    expect(chunks[0]!.startLine).toBe(1);
    expect(chunks[0]!.endLine).toBe(1);
    expect(chunks[1]!.startLine).toBe(2);
    expect(chunks[1]!.endLine).toBe(2);
    // hash = 文本内容 sha256
    expect(chunks[0]!.hash).toBe(hashText(chunks[0]!.text));
    expect(chunks[0]!.hash).not.toBe(chunks[1]!.hash);
  });

  it('过小的 section 合并到前一个 chunk，避免碎片化', () => {
    // tokens 足够大避免二次硬切；第二个标题下内容极短（< minChars）被并入前块。
    // maxChars=200, minChars=max(16, 50)=50；section2 '# 短' 仅 4 字符 < 50 → 合并
    const content = [
      '# 主标题',
      '第一段正文',
      '# 短',
    ].join('\n');
    const chunks = chunkMarkdown(content, { tokens: 50, overlap: 0 });

    // '# 短' 太短被并入前块 → 仅 1 个 chunk，覆盖到最后一行
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.endLine).toBe(3);
    expect(chunks[0]!.text).toContain('# 短');
  });

  it('超长 section 按 maxChars 二次切分并携带尾部重叠', () => {
    const lines = Array.from({ length: 12 }, (_, i) => `line-${i}-填充内容凑长度`);
    const content = lines.join('\n');
    // tokens=8 → maxChars=32，单行约 20+ 字节，会触发多次硬切
    const chunks = chunkMarkdown(content, { tokens: 8, overlap: 4 });

    expect(chunks.length).toBeGreaterThan(1);
    // 有重叠 → 相邻 chunk 的行号区间存在重合
    const overlaps = chunks.some((c, i) => i > 0 && c.startLine <= chunks[i - 1]!.endLine);
    expect(overlaps).toBe(true);
    // 覆盖到最后一行
    expect(chunks[chunks.length - 1]!.endLine).toBe(12);
  });

  it('overlap=0 时超长 section 硬切不重叠', () => {
    const lines = Array.from({ length: 12 }, (_, i) => `line-${i}-填充内容凑长度`);
    const chunks = chunkMarkdown(lines.join('\n'), { tokens: 8, overlap: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    // 无重叠 → 每个 chunk 的 startLine 严格大于前一个的 endLine
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.startLine).toBeGreaterThan(chunks[i - 1]!.endLine);
    }
  });
});

describe('memory maintenanceLock: try-lock 语义', () => {
  beforeEach(() => resetMemoryMaintenanceLocks());
  afterEach(() => resetMemoryMaintenanceLocks());

  it('首次获取成功，重复获取失败，释放后可再获取', () => {
    expect(tryAcquireMemoryMaintenance('t1', 'alice')).toBe(true);
    expect(tryAcquireMemoryMaintenance('t1', 'alice')).toBe(false);

    releaseMemoryMaintenance('t1', 'alice');
    expect(tryAcquireMemoryMaintenance('t1', 'alice')).toBe(true);
  });

  it('不同租户下同名用户互不影响（key 含 tenantId）', () => {
    expect(tryAcquireMemoryMaintenance('t1', 'alice')).toBe(true);
    expect(tryAcquireMemoryMaintenance('t2', 'alice')).toBe(true);
    // undefined 租户走 '__none' 分桶，与具名租户隔离
    expect(tryAcquireMemoryMaintenance(undefined, 'alice')).toBe(true);
    expect(tryAcquireMemoryMaintenance(undefined, 'alice')).toBe(false);
  });

  it('reset 清空全部锁状态', () => {
    tryAcquireMemoryMaintenance('t1', 'bob');
    resetMemoryMaintenanceLocks();
    expect(tryAcquireMemoryMaintenance('t1', 'bob')).toBe(true);
  });
});

describe('memory search: buildFtsQuery', () => {
  it('提取字母/数字/下划线 token 并用 OR 连接、加引号', () => {
    expect(buildFtsQuery('hello world_42')).toBe('"hello" OR "world_42"');
  });

  it('中文查询按 Unicode 字母切分', () => {
    expect(buildFtsQuery('记忆 检索')).toBe('"记忆" OR "检索"');
  });

  it('无有效 token 返回 null', () => {
    expect(buildFtsQuery('   !!! ??? ')).toBeNull();
    expect(buildFtsQuery('')).toBeNull();
  });

  it('剥离 token 内的双引号避免 FTS 语法注入', () => {
    // \p{L}/\p{N}/_ 不含引号，故引号本身不会成为 token 的一部分——
    // 断言正常单词被安全包裹
    expect(buildFtsQuery('safe')).toBe('"safe"');
  });
});

describe('memory search: mergeHybridResults', () => {
  const vec = (id: string, score: number): SearchResult & { id: string } => ({
    id, path: `p/${id}`, startLine: 1, endLine: 2, score, snippet: id,
  });
  const kw = (id: string, textScore: number): SearchResult & { id: string; textScore: number } => ({
    id, path: `p/${id}`, startLine: 1, endLine: 2, score: textScore, textScore, snippet: id,
  });

  it('同 id 同时命中两路时加权合并分数', () => {
    const merged = mergeHybridResults([vec('a', 1.0)], [kw('a', 0.5)], 0.6, 0.4);
    expect(merged).toHaveLength(1);
    // 0.6*1.0 + 0.4*0.5 = 0.8
    expect(merged[0]!.score).toBeCloseTo(0.8, 6);
  });

  it('仅单路命中时另一路分数按 0 计', () => {
    const merged = mergeHybridResults([vec('a', 1.0)], [kw('b', 1.0)], 0.5, 0.5);
    const byPath = Object.fromEntries(merged.map((r) => [r.path, r.score]));
    expect(byPath['p/a']).toBeCloseTo(0.5, 6); // 只有 vector
    expect(byPath['p/b']).toBeCloseTo(0.5, 6); // 只有 keyword
  });

  it('结果按合并分数降序排列', () => {
    const merged = mergeHybridResults(
      [vec('low', 0.1), vec('high', 0.9)],
      [],
      1, 0,
    );
    expect(merged.map((r) => r.path)).toEqual(['p/high', 'p/low']);
  });
});

describe('memory search: applyMMR', () => {
  const r = (path: string, score: number, snippet: string): SearchResult => ({
    path, startLine: 1, endLine: 2, score, snippet,
  });

  it('0/1 个结果直接原样返回', () => {
    expect(applyMMR([])).toEqual([]);
    const single = [r('a', 0.5, 'x')];
    expect(applyMMR(single)).toBe(single);
  });

  it('低 λ（重多样性）时相似扎堆项被不相似项挤到后面', () => {
    const results = [
      r('a', 1.0, '苹果 香蕉 橙子'),
      r('b', 0.95, '苹果 香蕉 橙子 葡萄'), // 与 a 高度相似
      r('c', 0.5, '汽车 火车 飞机'),       // 主题完全不同
    ];
    // λ=0.2 偏向多样性：选完 a 后，与 a 相似的 b 惩罚大，
    // 主题不同的 c 反超 b 被优先选中
    const ranked = applyMMR(results, 0.2);
    expect(ranked[0]!.path).toBe('a');
    expect(ranked.map((x) => x.path)).toEqual(['a', 'c', 'b']);
    expect(ranked).toHaveLength(3);
  });

  it('全部同分时仍产出完整排列（range=0 归一化分支）', () => {
    const results = [r('a', 0.5, 'x y'), r('b', 0.5, 'p q'), r('c', 0.5, 'm n')];
    const ranked = applyMMR(results, 0.7);
    expect(ranked).toHaveLength(3);
    expect(new Set(ranked.map((x) => x.path))).toEqual(new Set(['a', 'b', 'c']));
  });
});

describe('memory search: applyTemporalDecay', () => {
  const decayCfg = { enabled: true, halfLifeDays: 30 };
  const r = (path: string, score: number): SearchResult => ({
    path, startLine: 1, endLine: 2, score, snippet: path,
  });

  it('禁用时原样返回', () => {
    const input = [r('memory/2020-01-01.md', 1)];
    expect(applyTemporalDecay(input, { enabled: false, halfLifeDays: 30 })).toBe(input);
  });

  it('常青文件（MEMORY.md / 非日期 memory 文件）不衰减', () => {
    const out = applyTemporalDecay(
      [r('MEMORY.md', 1), r('memory/topics/tech.md', 1)],
      decayCfg,
    );
    expect(out[0]!.score).toBe(1);
    expect(out[1]!.score).toBe(1);
  });

  it('日期文件按半衰期指数衰减：越旧分数越低', () => {
    const now = Date.now();
    const halfLifeAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
    const iso = halfLifeAgo.toISOString().slice(0, 10);
    const out = applyTemporalDecay([r(`memory/${iso}.md`, 1)], decayCfg);
    // 恰好一个半衰期 → 约 0.5
    expect(out[0]!.score).toBeGreaterThan(0.45);
    expect(out[0]!.score).toBeLessThan(0.55);
  });

  it('非 memory 路径不识别为日期文件，保持原分', () => {
    const out = applyTemporalDecay([r('other/2020-01-01.md', 1)], decayCfg);
    expect(out[0]!.score).toBe(1);
  });
});

describe('memory search: searchKeyword (real FTS5 in-memory sqlite)', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(`CREATE VIRTUAL TABLE chunks_fts USING fts5(id, path, start_line, end_line, text)`);
    const insert = db.prepare(
      `INSERT INTO chunks_fts (id, path, start_line, end_line, text) VALUES (?,?,?,?,?)`,
    );
    insert.run('c1', 'memory/a.md', 1, 3, 'the quick brown fox jumps');
    insert.run('c2', 'memory/b.md', 4, 6, 'lazy dog sleeps all day');
  });

  afterEach(() => db.close());

  it('limit<=0 直接返回空', () => {
    expect(searchKeyword(db, 'fox', 0)).toEqual([]);
  });

  it('无有效 token（空查询）返回空', () => {
    expect(searchKeyword(db, '   ', 5)).toEqual([]);
  });

  it('命中的行携带 0-1 归一化 textScore 与 snippet', () => {
    const rows = searchKeyword(db, 'fox', 5);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('c1');
    expect(rows[0]!.path).toBe('memory/a.md');
    expect(rows[0]!.snippet).toContain('fox');
    expect(rows[0]!.textScore).toBeGreaterThan(0);
    expect(rows[0]!.textScore).toBeLessThanOrEqual(1);
    expect(rows[0]!.score).toBe(rows[0]!.textScore);
  });
});

describe('memory search: searchVector (JS 内存回退路径)', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE chunks (
      id TEXT, path TEXT, start_line INTEGER, end_line INTEGER, text TEXT, embedding TEXT
    )`);
    const insert = db.prepare(
      `INSERT INTO chunks (id, path, start_line, end_line, text, embedding) VALUES (?,?,?,?,?,?)`,
    );
    // near = 与查询向量方向一致（余弦=1）；far = 正交（余弦=0）
    insert.run('near', 'memory/near.md', 1, 2, 'near text', JSON.stringify([1, 0, 0]));
    insert.run('far', 'memory/far.md', 3, 4, 'far text', JSON.stringify([0, 1, 0]));
  });

  afterEach(() => db.close());

  it('空查询向量或 limit<=0 返回空', () => {
    expect(searchVector(db, [], 5, false)).toEqual([]);
    expect(searchVector(db, [1, 0, 0], 0, false)).toEqual([]);
  });

  it('vecAvailable=false 时用 JS 余弦相似度排序，最相近的排第一', () => {
    const rows = searchVector(db, [1, 0, 0], 5, false);
    expect(rows[0]!.id).toBe('near');
    expect(rows[0]!.score).toBeCloseTo(1, 6);
    // 正交项余弦=0
    const far = rows.find((r) => r.id === 'far')!;
    expect(far.score).toBeCloseTo(0, 6);
  });

  it('limit 截断结果数量', () => {
    const rows = searchVector(db, [1, 1, 0], 1, false);
    expect(rows).toHaveLength(1);
  });
});

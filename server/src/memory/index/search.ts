/**
 * Memory Index — Search Engine
 *
 * 双路检索（FTS5 关键词 + sqlite-vec 向量）+ 混合合并 + 时间衰减。
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  SearchResult,
  VectorSearchRow,
  KeywordSearchRow,
  MemoryIndexConfig,
} from './types.js';

const SNIPPET_MAX_CHARS = 700;

// ─── FTS5 查询构建 ────────────────────────────────────────────

/** 将自然语言查询转为 FTS5 MATCH 表达式（OR 连接，命中越多 BM25 分数越高） */
export function buildFtsQuery(raw: string): string | null {
  const tokens =
    raw.match(/[\p{L}\p{N}_]+/gu)?.map((t) => t.trim()).filter(Boolean) ?? [];
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replaceAll('"', '')}"`).join(' OR ');
}

/** BM25 rank → 0-1 分数 */
function bm25RankToScore(rank: number): number {
  if (!Number.isFinite(rank)) return 0;
  if (rank < 0) {
    const relevance = -rank;
    return relevance / (1 + relevance);
  }
  return 1 / (1 + rank);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}

// ─── 向量搜索 ────────────────────────────────────────────────

export function searchVector(
  db: DatabaseSync,
  queryVec: number[],
  limit: number,
  vecAvailable: boolean,
): Array<SearchResult & { id: string }> {
  if (queryVec.length === 0 || limit <= 0) return [];

  if (vecAvailable) {
    const blob = Buffer.from(new Float32Array(queryVec).buffer);
    const rows = db
      .prepare(
        `SELECT c.id, c.path, c.start_line, c.end_line, c.text,
                vec_distance_cosine(v.embedding, ?) AS dist
           FROM chunks_vec v
           JOIN chunks c ON c.id = v.id
          ORDER BY dist ASC
          LIMIT ?`
      )
      .all(blob, limit) as unknown as VectorSearchRow[];

    return rows.map((r) => ({
      id: r.id,
      path: r.path,
      startLine: r.start_line,
      endLine: r.end_line,
      score: 1 - r.dist,
      snippet: truncate(r.text, SNIPPET_MAX_CHARS),
    }));
  }

  // 回退：JS 内存计算余弦距离
  const allChunks = db
    .prepare(`SELECT id, path, start_line, end_line, text, embedding FROM chunks`)
    .all() as Array<{
    id: string;
    path: string;
    start_line: number;
    end_line: number;
    text: string;
    embedding: string;
  }>;

  const scored = allChunks
    .map((c) => {
      const emb = JSON.parse(c.embedding) as number[];
      return { chunk: c, score: cosineSimilarity(queryVec, emb) };
    })
    .filter((e) => Number.isFinite(e.score));

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((e) => ({
      id: e.chunk.id,
      path: e.chunk.path,
      startLine: e.chunk.start_line,
      endLine: e.chunk.end_line,
      score: e.score,
      snippet: truncate(e.chunk.text, SNIPPET_MAX_CHARS),
    }));
}

function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0, bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ─── 关键词搜索 ──────────────────────────────────────────────

export function searchKeyword(
  db: DatabaseSync,
  query: string,
  limit: number,
): Array<SearchResult & { id: string; textScore: number }> {
  if (limit <= 0) return [];
  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) return [];

  const rows = db
    .prepare(
      `SELECT id, path, start_line, end_line, text,
              bm25(chunks_fts) AS rank
         FROM chunks_fts
        WHERE chunks_fts MATCH ?
        ORDER BY rank ASC
        LIMIT ?`
    )
    .all(ftsQuery, limit) as unknown as KeywordSearchRow[];

  return rows.map((r) => {
    const textScore = bm25RankToScore(r.rank);
    return {
      id: r.id,
      path: r.path,
      startLine: r.start_line,
      endLine: r.end_line,
      score: textScore,
      textScore,
      snippet: truncate(r.text, SNIPPET_MAX_CHARS),
    };
  });
}

// ─── 混合合并 ────────────────────────────────────────────────

export function mergeHybridResults(
  vectorResults: Array<SearchResult & { id: string }>,
  keywordResults: Array<SearchResult & { id: string; textScore: number }>,
  vectorWeight: number,
  textWeight: number,
): SearchResult[] {
  const byId = new Map<
    string,
    { vectorScore: number; textScore: number; result: SearchResult & { id: string } }
  >();

  for (const r of vectorResults) {
    byId.set(r.id, { vectorScore: r.score, textScore: 0, result: r });
  }

  for (const r of keywordResults) {
    const existing = byId.get(r.id);
    if (existing) {
      existing.textScore = r.textScore;
    } else {
      byId.set(r.id, { vectorScore: 0, textScore: r.textScore, result: r });
    }
  }

  return Array.from(byId.values())
    .map((e) => ({
      path: e.result.path,
      startLine: e.result.startLine,
      endLine: e.result.endLine,
      score: vectorWeight * e.vectorScore + textWeight * e.textScore,
      snippet: e.result.snippet,
    }))
    .sort((a, b) => b.score - a.score);
}

// ─── MMR 多样性重排序 ────────────────────────────────────────

/**
 * Maximal Marginal Relevance (MMR)
 *
 * 迭代选择：每次选 λ×相关性 - (1-λ)×与已选项最大相似度 最高的候选。
 * 效果：同主题的多个 chunk 不会扎堆占满结果，让有限的结果覆盖更多不同话题。
 */

function tokenize(text: string): Set<string> {
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  return new Set(tokens);
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of smaller) {
    if (larger.has(t)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}

export function applyMMR(
  results: SearchResult[],
  lambda: number = 0.7,
): SearchResult[] {
  if (results.length <= 1) return results;

  // 归一化分数到 [0, 1]
  const maxScore = Math.max(...results.map((r) => r.score));
  const minScore = Math.min(...results.map((r) => r.score));
  const range = maxScore - minScore;
  const normalize = (s: number) => (range === 0 ? 1 : (s - minScore) / range);

  // 预分词
  const tokenCache = new Map<number, Set<string>>();
  for (let i = 0; i < results.length; i++) {
    tokenCache.set(i, tokenize(results[i]!.snippet));
  }

  const selected: number[] = [];
  const remaining = new Set(results.map((_, i) => i));

  while (remaining.size > 0) {
    let bestIdx = -1;
    let bestMMR = -Infinity;

    for (const idx of remaining) {
      const relevance = normalize(results[idx]!.score);

      // 与已选项的最大相似度
      let maxSim = 0;
      const candidateTokens = tokenCache.get(idx)!;
      for (const selIdx of selected) {
        const sim = jaccardSimilarity(candidateTokens, tokenCache.get(selIdx)!);
        if (sim > maxSim) maxSim = sim;
      }

      const mmr = lambda * relevance - (1 - lambda) * maxSim;
      if (mmr > bestMMR || (mmr === bestMMR && results[idx]!.score > (bestIdx >= 0 ? results[bestIdx]!.score : -Infinity))) {
        bestMMR = mmr;
        bestIdx = idx;
      }
    }

    if (bestIdx < 0) break;
    selected.push(bestIdx);
    remaining.delete(bestIdx);
  }

  return selected.map((i) => results[i]!);
}

// ─── 时间衰减 ────────────────────────────────────────────────

const DATED_PATH_RE = /(?:^|\/)memory\/(\d{4})-(\d{2})-(\d{2})\.md$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function isEvergreenPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized === 'MEMORY.md' || normalized === 'memory.md') return true;
  if (!normalized.startsWith('memory/')) return false;
  return !DATED_PATH_RE.test(normalized);
}

function parseDateFromPath(filePath: string): Date | null {
  const match = DATED_PATH_RE.exec(filePath.replace(/\\/g, '/'));
  if (!match) return null;
  const [, y, m, d] = match;
  return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
}

export function applyTemporalDecay(
  results: SearchResult[],
  config: MemoryIndexConfig['temporalDecay'],
): SearchResult[] {
  if (!config.enabled) return results;

  const lambda = Math.LN2 / config.halfLifeDays;
  const now = Date.now();

  return results.map((r) => {
    if (isEvergreenPath(r.path)) return r;

    const date = parseDateFromPath(r.path);
    if (!date) return r;

    const ageInDays = Math.max(0, (now - date.getTime()) / DAY_MS);
    const multiplier = Math.exp(-lambda * ageInDays);
    return { ...r, score: r.score * multiplier };
  });
}

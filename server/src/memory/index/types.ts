/**
 * Memory Index — Type Definitions
 */

export interface MemoryIndexConfig {
  enabled: boolean;
  /** SQLite 数据库存放目录 */
  dbDir: string;
  embedding: {
    /** OpenAI-compatible API base URL */
    baseUrl: string;
    apiKey: string;
    model: string;
    /** 向量维度（由模型决定，用于 sqlite-vec 建表） */
    dimensions: number;
  };
  chunking: {
    /** 每个 chunk 的目标 token 数 */
    tokens: number;
    /** 相邻 chunk 的重叠 token 数 */
    overlap: number;
  };
  search: {
    vectorWeight: number;
    textWeight: number;
    maxResults: number;
    minScore: number;
  };
  temporalDecay: {
    enabled: boolean;
    halfLifeDays: number;
  };
  sync: {
    /** 文件变化后的防抖时间（ms） */
    debounceMs: number;
  };
}

export interface MemoryChunk {
  startLine: number;
  endLine: number;
  text: string;
  hash: string;
}

export interface MemoryFileEntry {
  /** 相对于 workspace 的路径 */
  path: string;
  absPath: string;
  hash: string;
  mtimeMs: number;
  size: number;
}

export interface SearchResult {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
}

export interface SearchMeta {
  /** 双路合并后、过滤前的候选总数 */
  totalCandidates: number;
  /** 被 minScore 过滤掉的数量 */
  filteredOut: number;
  /** 被过滤结果中的最高分（无过滤时为 0） */
  bestFilteredScore: number;
}

export interface SearchResponse {
  results: SearchResult[];
  meta: SearchMeta;
}

export interface VectorSearchRow {
  id: string;
  path: string;
  start_line: number;
  end_line: number;
  text: string;
  dist: number;
}

export interface KeywordSearchRow {
  id: string;
  path: string;
  start_line: number;
  end_line: number;
  text: string;
  rank: number;
}

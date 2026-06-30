/**
 * Memory Index — SQLite Schema
 *
 * 表结构：
 *   meta       — 索引元信息（provider/model/chunking 参数的指纹）
 *   files      — 已索引文件的 hash/mtime/size
 *   chunks     — 分块文本 + 嵌入向量
 *   chunks_fts — FTS5 虚拟表（BM25 关键词搜索）
 *   chunks_vec — sqlite-vec 虚拟表（余弦距离向量搜索），可选
 *   embedding_cache — 嵌入缓存（避免重复调用 API）
 */

import type { DatabaseSync } from 'node:sqlite';

export function ensureSchema(db: DatabaseSync): { ftsAvailable: boolean } {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      hash TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      hash TEXT NOT NULL,
      text TEXT NOT NULL,
      embedding TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS embedding_cache (
      model TEXT NOT NULL,
      hash TEXT NOT NULL,
      embedding TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (model, hash)
    );
  `);

  let ftsAvailable = false;
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        text,
        id UNINDEXED,
        path UNINDEXED,
        start_line UNINDEXED,
        end_line UNINDEXED
      );
    `);
    ftsAvailable = true;
  } catch {
    // FTS5 不可用（不应该发生，Node 22 内置 SQLite 支持 FTS5）
  }

  return { ftsAvailable };
}

export function ensureVectorTable(db: DatabaseSync, dimensions: number): void {
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(` +
      `id TEXT PRIMARY KEY, ` +
      `embedding FLOAT[${dimensions}]` +
      `)`
  );
}

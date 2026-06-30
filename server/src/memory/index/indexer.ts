/**
 * Memory Index — Indexer
 *
 * 管理单个 workspace 的记忆索引：
 *   - SQLite 数据库（chunks + FTS5 + sqlite-vec）
 *   - 文件监听（chokidar, FSEvents based）
 *   - 增量同步（hash 比对，只处理变更文件）
 *   - 嵌入缓存（相同文本不重复调用 API）
 */

import { DatabaseSync } from 'node:sqlite';
import { readFile, stat, readdir } from 'node:fs/promises';
import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

import { ensureSchema, ensureVectorTable } from './schema.js';
import { chunkMarkdown, hashText } from './chunker.js';
import { EmbeddingProvider } from './embeddings.js';
import {
  searchVector,
  searchKeyword,
  mergeHybridResults,
  applyTemporalDecay,
  applyMMR,
} from './search.js';
import type {
  MemoryIndexConfig,
  MemoryFileEntry,
  MemoryChunk,
  SearchResult,
  SearchResponse,
} from './types.js';

type LogFn = (msg: string) => void;

export interface SyncIfStaleOptions {
  /** 已有索引但可能 stale 时最多等待同步完成多久。 */
  maxWaitMs?: number;
  /** 索引为空/首次建立时最多等待同步完成多久。 */
  emptyIndexMaxWaitMs?: number;
  /** 非 dirty 状态下，MemorySearch 前多久才做一次 manifest stale 检查。 */
  manifestCheckIntervalMs?: number;
}

export class MemoryIndexer {
  private db: DatabaseSync;
  private ftsAvailable = false;
  private vecAvailable = false;
  private readonly provider: EmbeddingProvider;
  private readonly config: MemoryIndexConfig;
  private readonly workspaceDir: string;
  private readonly dbPath: string;

  private dirty = false;
  private syncing: Promise<void> | null = null;
  private watcher: FSWatcher | null = null;
  private fileWatcher: FSWatcher | null = null;
  private watchTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private log: LogFn;
  private lastManifestCheckAt = 0;

  constructor(
    workspaceDir: string,
    config: MemoryIndexConfig,
    log?: LogFn,
    opts?: { skipWatch?: boolean },
  ) {
    this.workspaceDir = resolve(workspaceDir);
    this.config = config;
    this.log = log ?? (() => {});
    this.provider = new EmbeddingProvider(config.embedding);

    // DB 路径：{dbDir}/{workspace名}.sqlite
    const workspaceName = this.workspaceDir.split('/').pop() ?? 'default';
    const dbDir = resolve(config.dbDir);
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }
    this.dbPath = join(dbDir, `${workspaceName}.sqlite`);

    this.db = this.openDatabase();
    this.ftsAvailable = ensureSchema(this.db).ftsAvailable;
    this.tryLoadVec();
    // 只读模式（skipWatch）：不启动文件监听、不做启动 initial sync，
    // 纯查询主进程已维护的索引，避免多进程重复 watch / 竞争写同一 sqlite。
    if (!opts?.skipWatch) this.startWatcher();
  }

  // ─── 公开 API ─────────────────────────────────────────────

  async search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; keywords?: string },
  ): Promise<SearchResponse> {
    const emptyResponse: SearchResponse = { results: [], meta: { totalCandidates: 0, filteredOut: 0, bestFilteredScore: 0 } };
    const cleaned = query.trim();
    if (!cleaned) return emptyResponse;

    // 如果有脏数据，触发后台同步（不等待）
    if (this.dirty && !this.syncing) {
      void this.sync().catch((e) => this.log(`sync error: ${e}`));
    }

    if (!this.hasIndexedContent()) return emptyResponse;

    const maxResults = opts?.maxResults ?? this.config.search.maxResults;
    const minScore = opts?.minScore ?? this.config.search.minScore;
    const candidates = Math.min(200, maxResults * 3);

    // 双路并行
    let vectorResults: Awaited<ReturnType<typeof searchVector>> = [];
    let keywordResults: Awaited<ReturnType<typeof searchKeyword>> = [];

    const vectorPromise = (async () => {
      try {
        const queryVec = await this.provider.embed([cleaned]);
        if (queryVec[0] && queryVec[0].some((v) => v !== 0)) {
          vectorResults = searchVector(
            this.db, queryVec[0], candidates, this.vecAvailable,
          );
        }
      } catch (e) {
        this.log(`vector search error: ${e}`);
      }
    })();

    const keywordPromise = (async () => {
      try {
        const kw = opts?.keywords?.trim();
        if (this.ftsAvailable && kw) {
          keywordResults = searchKeyword(this.db, kw, candidates);
        }
      } catch (e) {
        this.log(`keyword search error: ${e}`);
      }
    })();

    await Promise.all([vectorPromise, keywordPromise]);

    // 合并
    let merged: SearchResult[];
    if (vectorResults.length > 0 && keywordResults.length > 0) {
      merged = mergeHybridResults(
        vectorResults,
        keywordResults,
        this.config.search.vectorWeight,
        this.config.search.textWeight,
      );
    } else if (vectorResults.length > 0) {
      merged = vectorResults;
    } else {
      merged = keywordResults;
    }

    // 时间衰减
    merged = applyTemporalDecay(merged, this.config.temporalDecay);
    merged.sort((a, b) => b.score - a.score);

    // MMR 多样性重排序（在分数排序后、截断前执行）
    merged = applyMMR(merged);

    // 过滤 + 截断，同时收集元信息
    const totalCandidates = merged.length;
    const passed = merged.filter((r) => r.score >= minScore);
    const filteredOut = totalCandidates - passed.length;
    const bestFilteredScore = filteredOut > 0
      ? Math.max(...merged.filter((r) => r.score < minScore).map((r) => r.score))
      : 0;

    return {
      results: passed.slice(0, maxResults),
      meta: { totalCandidates, filteredOut, bestFilteredScore },
    };
  }

  /** 强制全量同步 */
  async forceSync(): Promise<void> {
    await this.sync(true);
  }

  /** 显式通知索引器：记忆源文件已变更，排队同步。 */
  enqueueSync(reason = 'explicit', opts?: { debounceMs?: number }): void {
    this.scheduleSync(reason, opts?.debounceMs ?? 0);
  }

  /**
   * MemorySearch 前的轻量正确性兜底：
   * - dirty / 首次索引 / manifest TTL 到期时才检查源文件；
   * - 发现 stale 后只等待有限时间，避免搜索体验被 embedding API 拖住。
   */
  async syncIfStale(opts: SyncIfStaleOptions = {}): Promise<void> {
    if (this.closed) return;

    const hasIndexedFiles = this.hasIndexedFiles();
    const waitMs = hasIndexedFiles
      ? opts.maxWaitMs ?? 800
      : opts.emptyIndexMaxWaitMs ?? 2_000;

    if (this.syncing) {
      await this.waitForSync(this.syncing, waitMs, 'in-flight');
      return;
    }

    const manifestCheckIntervalMs = opts.manifestCheckIntervalMs ?? 60_000;
    const shouldCheckManifest = this.dirty
      || !hasIndexedFiles
      || Date.now() - this.lastManifestCheckAt >= manifestCheckIntervalMs;
    if (!shouldCheckManifest) return;

    let stale = false;
    try {
      stale = await this.isIndexStale();
      this.lastManifestCheckAt = Date.now();
    } catch (e) {
      this.log(`manifest check error: ${e}`);
      return;
    }

    if (!stale) {
      this.dirty = false;
      return;
    }

    await this.waitForSync(this.sync(), waitMs, 'stale');
  }

  /** 获取索引状态 */
  getStatus(): {
    dbPath: string;
    ftsAvailable: boolean;
    vecAvailable: boolean;
    chunkCount: number;
    fileCount: number;
  } {
    const chunkRow = this.db.prepare('SELECT COUNT(*) as cnt FROM chunks').get() as { cnt: number };
    const fileRow = this.db.prepare('SELECT COUNT(*) as cnt FROM files').get() as { cnt: number };
    return {
      dbPath: this.dbPath,
      ftsAvailable: this.ftsAvailable,
      vecAvailable: this.vecAvailable,
      chunkCount: chunkRow.cnt,
      fileCount: fileRow.cnt,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopWatching();
    if (this.syncing) {
      try { await this.syncing; } catch {}
    }
    this.db.close();
  }

  retire(): void {
    if (this.closed) return;
    this.dirty = false;
    this.stopWatching();
  }

  // ─── 同步逻辑 ─────────────────────────────────────────────

  private async sync(force = false): Promise<void> {
    if (this.closed) return;
    if (this.syncing) return this.syncing;

    this.syncing = this._doSync(force).finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async _doSync(force: boolean): Promise<void> {
    this.dirty = false;
    const files = await this.listMemoryFiles();
    const indexedFiles = this.getIndexedFiles();

    // 找出需要处理的文件
    const toIndex: MemoryFileEntry[] = [];
    const toDelete: string[] = [];
    const currentPaths = new Set<string>();

    for (const file of files) {
      currentPaths.add(file.path);
      const indexed = indexedFiles.get(file.path);
      if (!force && indexed && indexed.hash === file.hash) continue;
      toIndex.push(file);
    }

    for (const [path] of indexedFiles) {
      if (!currentPaths.has(path)) toDelete.push(path);
    }

    if (toIndex.length === 0 && toDelete.length === 0) {
      this.lastManifestCheckAt = Date.now();
      return;
    }

    this.log(`sync: ${toIndex.length} to index, ${toDelete.length} to delete`);

    // 删除过期文件的 chunks
    for (const path of toDelete) {
      this.deleteFileChunks(path);
    }

    // 索引新/变更文件
    for (const file of toIndex) {
      try {
        await this.indexFile(file);
      } catch (e) {
        this.log(`index error for ${file.path}: ${e}`);
      }
    }
    this.lastManifestCheckAt = Date.now();
  }

  private async isIndexStale(): Promise<boolean> {
    const files = await this.listMemoryFiles();
    const indexedFiles = this.getIndexedFiles();
    if (files.length !== indexedFiles.size) return true;
    for (const file of files) {
      const indexed = indexedFiles.get(file.path);
      if (!indexed || indexed.hash !== file.hash) return true;
    }
    return false;
  }

  private async waitForSync(
    syncPromise: Promise<void>,
    maxWaitMs: number,
    reason: string,
  ): Promise<boolean> {
    const guarded = syncPromise.catch((e) => {
      this.log(`sync error (${reason}): ${e}`);
    });
    if (maxWaitMs <= 0) {
      void guarded;
      return false;
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<false>((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout(false), maxWaitMs);
      timer.unref?.();
    });
    const completed = await Promise.race([
      guarded.then(() => true as const),
      timeout,
    ]);
    if (timer) clearTimeout(timer);
    return completed;
  }

  private async indexFile(file: MemoryFileEntry): Promise<void> {
    const content = await readFile(file.absPath, 'utf-8');
    const chunks = chunkMarkdown(content, this.config.chunking);

    // 先删除旧 chunks；空文件也要更新 files manifest，否则会被反复判 stale。
    this.deleteFileChunks(file.path);
    if (chunks.length === 0) {
      this.upsertFileEntry(file);
      return;
    }

    // 获取嵌入（带缓存）
    const embeddings = await this.embedWithCache(chunks);

    // 写入新 chunks
    const insertChunk = this.db.prepare(
      `INSERT INTO chunks (id, path, start_line, end_line, hash, text, embedding, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertFts = this.ftsAvailable
      ? this.db.prepare(
          `INSERT INTO chunks_fts (id, path, start_line, end_line, text)
           VALUES (?, ?, ?, ?, ?)`
        )
      : null;

    const now = Date.now();
    this.db.exec('BEGIN');
    try {
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]!;
        const embedding = embeddings[i] ?? [];
        const id = `${file.path}:${chunk.startLine}:${randomUUID().slice(0, 8)}`;

        insertChunk.run(
          id, file.path, chunk.startLine, chunk.endLine,
          chunk.hash, chunk.text, JSON.stringify(embedding), now,
        );

        if (insertFts) {
          insertFts.run(id, file.path, chunk.startLine, chunk.endLine, chunk.text);
        }

        // sqlite-vec
        if (this.vecAvailable && embedding.length > 0) {
          try {
            this.db.prepare(
              `INSERT INTO chunks_vec (id, embedding) VALUES (?, ?)`
            ).run(id, Buffer.from(new Float32Array(embedding).buffer));
          } catch {
            // vec 表可能还未创建（维度未知时），跳过
          }
        }
      }

      // 更新 files 表
      this.upsertFileEntry(file);

      this.db.exec('COMMIT');
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw e;
    }
  }

  private upsertFileEntry(file: MemoryFileEntry): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO files (path, hash, mtime, size) VALUES (?, ?, ?, ?)`
    ).run(file.path, file.hash, Math.floor(file.mtimeMs), file.size);
  }

  private deleteFileChunks(path: string): void {
    // 获取要删除的 chunk IDs
    const ids = (this.db.prepare('SELECT id FROM chunks WHERE path = ?').all(path) as Array<{ id: string }>)
      .map((r) => r.id);

    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM chunks WHERE path = ?').run(path);
      this.db.prepare('DELETE FROM files WHERE path = ?').run(path);

      if (this.ftsAvailable) {
        for (const id of ids) {
          this.db.prepare('DELETE FROM chunks_fts WHERE id = ?').run(id);
        }
      }

      if (this.vecAvailable) {
        for (const id of ids) {
          try {
            this.db.prepare('DELETE FROM chunks_vec WHERE id = ?').run(id);
          } catch {}
        }
      }

      this.db.exec('COMMIT');
    } catch {
      try { this.db.exec('ROLLBACK'); } catch {}
    }
  }

  // ─── 嵌入缓存 ─────────────────────────────────────────────

  private async embedWithCache(chunks: MemoryChunk[]): Promise<number[][]> {
    const model = this.config.embedding.model;
    const results: number[][] = new Array(chunks.length);
    const toEmbed: Array<{ index: number; text: string }> = [];

    // 查缓存
    const getCache = this.db.prepare(
      `SELECT embedding FROM embedding_cache WHERE model = ? AND hash = ?`
    );

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const cached = getCache.get(model, chunk.hash) as { embedding: string } | undefined;
      if (cached) {
        results[i] = JSON.parse(cached.embedding) as number[];
      } else {
        toEmbed.push({ index: i, text: chunk.text });
      }
    }

    if (toEmbed.length === 0) return results;

    // 调用 API
    const texts = toEmbed.map((e) => e.text);
    const embeddings = await this.provider.embed(texts);

    // 写入缓存
    const insertCache = this.db.prepare(
      `INSERT OR REPLACE INTO embedding_cache (model, hash, embedding, updated_at)
       VALUES (?, ?, ?, ?)`
    );
    const now = Date.now();

    for (let i = 0; i < toEmbed.length; i++) {
      const entry = toEmbed[i]!;
      const embedding = embeddings[i] ?? [];
      results[entry.index] = embedding;

      const chunk = chunks[entry.index]!;
      insertCache.run(model, chunk.hash, JSON.stringify(embedding), now);
    }

    // 首次拿到向量后确保 vec 表已建（需要知道维度）
    if (!this.vecAvailable && embeddings.length > 0 && embeddings[0]!.length > 0) {
      this.tryCreateVecTable(embeddings[0]!.length);
    }

    return results;
  }

  // ─── 数据库 ───────────────────────────────────────────────

  private openDatabase(): DatabaseSync {
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const db = new DatabaseSync(this.dbPath, { allowExtension: true });
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA journal_mode = WAL');
    return db;
  }

  private tryLoadVec(): void {
    try {
      const vecPkg = this.findSqliteVecPath();
      if (vecPkg) {
        this.db.loadExtension(vecPkg);
        this.vecAvailable = true;
        // 如果已知维度，创建 vec 表
        if (this.config.embedding.dimensions > 0) {
          this.tryCreateVecTable(this.config.embedding.dimensions);
        }
        this.log('sqlite-vec loaded');
      }
    } catch (e) {
      this.log(`sqlite-vec unavailable: ${e}`);
      this.vecAvailable = false;
    }
  }

  private tryCreateVecTable(dimensions: number): void {
    try {
      ensureVectorTable(this.db, dimensions);
      this.vecAvailable = true;
    } catch (e) {
      this.log(`vec table creation failed: ${e}`);
    }
  }

  private findSqliteVecPath(): string | null {
    // 尝试从项目依赖中找 sqlite-vec
    try {
      const getLoadablePath = require('sqlite-vec').getLoadablePath as () => string;
      return getLoadablePath();
    } catch {}

    // 尝试常见路径
    const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const pkgName = `sqlite-vec-${platform}-${arch}`;
    try {
      const vecPath = require.resolve(`${pkgName}/vec0`);
      return vecPath;
    } catch {}

    return null;
  }

  private hasIndexedContent(): boolean {
    const row = this.db.prepare('SELECT 1 as found FROM chunks LIMIT 1').get() as
      | { found?: number }
      | undefined;
    return row?.found === 1;
  }

  private hasIndexedFiles(): boolean {
    const row = this.db.prepare('SELECT 1 as found FROM files LIMIT 1').get() as
      | { found?: number }
      | undefined;
    return row?.found === 1;
  }

  private getIndexedFiles(): Map<string, { hash: string }> {
    const rows = this.db.prepare('SELECT path, hash FROM files').all() as Array<{
      path: string;
      hash: string;
    }>;
    const map = new Map<string, { hash: string }>();
    for (const r of rows) {
      map.set(r.path, { hash: r.hash });
    }
    return map;
  }

  // ─── 文件发现 ─────────────────────────────────────────────

  private async listMemoryFiles(): Promise<MemoryFileEntry[]> {
    const files: MemoryFileEntry[] = [];

    // 根 MEMORY.md + memory/**/*.md（递归）。
    // MemorySearch 的工具契约明确包含 MEMORY.md，索引范围必须与工具说明一致。
    const rootMemory = await this.buildFileEntry(
      join(this.workspaceDir, 'MEMORY.md'),
      'MEMORY.md',
    );
    if (rootMemory) files.push(rootMemory);

    const memoryDir = join(this.workspaceDir, 'memory');
    await this.walkDir(memoryDir, files);

    return files;
  }

  private async walkDir(dir: string, files: MemoryFileEntry[]): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await this.walkDir(full, files);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          const relPath = relative(this.workspaceDir, full).replace(/\\/g, '/');
          const fileEntry = await this.buildFileEntry(full, relPath);
          if (fileEntry) files.push(fileEntry);
        }
      }
    } catch {}
  }

  private async buildFileEntry(
    absPath: string,
    relPath: string,
  ): Promise<MemoryFileEntry | null> {
    try {
      const s = await stat(absPath);
      if (!s.isFile()) return null;
      const content = await readFile(absPath, 'utf-8');
      return {
        path: relPath,
        absPath,
        hash: hashText(content),
        mtimeMs: s.mtimeMs,
        size: s.size,
      };
    } catch {
      return null;
    }
  }

  // ─── 文件监听 ─────────────────────────────────────────────

  private startWatcher(): void {
    // 监听 memory/ 目录和 MEMORY.md
    const memoryDir = join(this.workspaceDir, 'memory');

    // 监听 memory/ 目录（递归）
    if (existsSync(memoryDir) && lstatSync(memoryDir).isDirectory()) {
      try {
        this.watcher = watch(memoryDir, { recursive: true }, (_event, filename) => {
          if (filename && filename.endsWith('.md')) {
            this.scheduleSync('watch');
          }
        });
      } catch {
        // 目录监听失败，降级为无监听
      }
    }

    // MEMORY.md 变化通过 memory/ 目录同级检测（fs.watch 不能同时监听文件和目录）
    // 用 interval 兜底
    const memoryFile = join(this.workspaceDir, 'MEMORY.md');
    if (existsSync(memoryFile)) {
      try {
        this.fileWatcher = watch(memoryFile, () => this.scheduleSync('watch'));
      } catch {}
    }

    // 启动时先同步一次
    void this.sync().catch((e) => this.log(`initial sync error: ${e}`));
  }

  private scheduleSync(reason = 'watch', debounceMs = this.config.sync.debounceMs): void {
    if (this.closed) return;
    this.dirty = true;
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      void this.sync().catch((e) => this.log(`${reason} sync error: ${e}`));
    }, Math.max(0, debounceMs));
    this.watchTimer.unref?.();
  }

  private stopWatching(): void {
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.fileWatcher) {
      this.fileWatcher.close();
      this.fileWatcher = null;
    }
  }
}

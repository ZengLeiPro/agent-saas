import { File, Paths, Directory } from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import {
  getPlatform,
  isSensitiveTransportAllowed,
  resolveKbFileSrc,
  TOKEN_KEY,
  type BoundaryIdentity,
} from '@agent/shared';
import { resolveFileReadSource } from '../lib/fileReadSource';

// --- Constants ---
const MAX_CACHE_SIZE = 1024 * 1024 * 1024; // 1 GB
const EVICT_TARGET = 700 * 1024 * 1024; // 700 MB
const INDEX_KEY = 'fileCache:index:v2';
const LEGACY_INDEX_KEY = 'fileCache:index';
const PERSIST_DEBOUNCE_MS = 2000;
const CACHE_DIR = 'files-v2';
const LEGACY_CACHE_DIR = 'files';

// --- Types ---
interface FileCacheEntry {
  serverPath: string;
  localFileName: string;
  modifiedAt: number;
  size: number;
  cachedAt: number;
  lastAccessedAt: number;
  owner?: string;
}

interface FileCacheIndex {
  version: 2;
  entries: Record<string, FileCacheEntry>;
  totalSize: number;
}

interface CacheScope {
  key: string;
  lifecycleGeneration: number;
}

function sha256Hex(value: string): string {
  return bytesToHex(sha256(utf8ToBytes(value)));
}

function makeCacheKey(scope: CacheScope, serverPath: string, owner?: string, root?: boolean): string {
  // KB 是租户共享只读，owner/root 不参与命名；同时剥掉 `#page=N` fragment，
  // 避免同一份文档因引用页码不同而重复落盘。
  const source = resolveFileReadSource(serverPath);
  if (source.kind === 'kb') return `${scope.key}:__kb__:${source.doc}`;
  const prefix = root ? '__root__:' : '';
  return owner ? `${scope.key}:${prefix}${owner}:${serverPath}` : `${scope.key}:${prefix}${serverPath}`;
}

function makeLocalFileName(scope: CacheScope, serverPath: string, owner?: string, root?: boolean): string {
  // 扩展名取自真实文档名（kb 路径要先剥伪协议与 fragment），供原生预览器识别类型
  const doc = resolveFileReadSource(serverPath).doc;
  const ext = doc.includes('.') ? doc.slice(doc.lastIndexOf('.')) : '';
  return `${sha256Hex(makeCacheKey(scope, serverPath, owner, root))}${ext}`;
}

class FileCacheService {
  private index: FileCacheIndex = { version: 2, entries: {}, totalSize: 0 };
  private loaded = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private inflight = new Map<string, Promise<string>>();
  private identity: BoundaryIdentity | null = null;
  private lifecycleGeneration = 0;

  setIdentity(identity: BoundaryIdentity | null): void {
    const previous = this.identity;
    const changed =
      previous?.userId !== identity?.userId ||
      previous?.tenantId !== identity?.tenantId ||
      previous?.generation !== identity?.generation;
    this.identity = identity;
    if (changed) {
      this.lifecycleGeneration += 1;
      this.inflight.clear();
    }
  }

  private captureScope(): CacheScope {
    if (!this.identity) throw new Error('FILE_CACHE_IDENTITY_UNAVAILABLE');
    const origin = getPlatform().platformConfig.getBaseUrl();
    return {
      key: `v2:${origin}:${this.identity.tenantId}:${this.identity.userId}:${this.identity.generation}`,
      lifecycleGeneration: this.lifecycleGeneration,
    };
  }

  private assertScope(scope: CacheScope): void {
    const current = this.captureScope();
    if (current.key !== scope.key || current.lifecycleGeneration !== scope.lifecycleGeneration) {
      throw new Error('FILE_CACHE_IDENTITY_CHANGED');
    }
  }

  async init(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await AsyncStorage.getItem(INDEX_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as FileCacheIndex;
        if (parsed.version === 2 && parsed.entries) {
          this.index = parsed;
        }
      }
    } catch {
      /* corrupted index, start fresh */
    }
    // Ensure cache subdirectory exists
    this.ensureCacheDir();
    await AsyncStorage.removeItem(LEGACY_INDEX_KEY).catch(() => undefined);
    try {
      const legacyDir = new Directory(Paths.cache, LEGACY_CACHE_DIR);
      if (legacyDir.exists) legacyDir.delete();
    } catch {
      /* old unscoped cache is never migrated across identities */
    }
    this.loaded = true;
  }

  /**
   * Check cache for a matching file. Returns local file URI on hit, null on miss.
   * When modifiedAt=0 and size=0, skips validation (caller has no metadata to verify).
   */
  async getCached(
    serverPath: string,
    modifiedAt: number,
    size: number,
    owner?: string,
    root?: boolean,
  ): Promise<string | null> {
    const scope = this.captureScope();
    await this.init();
    this.assertScope(scope);
    const key = makeCacheKey(scope, serverPath, owner, root);
    const entry = this.index.entries[key];
    if (!entry) return null;

    // When caller provides real metadata, validate against cached entry
    const skipValidation = modifiedAt === 0 && size === 0;
    if (!skipValidation && (entry.modifiedAt !== modifiedAt || entry.size !== size)) {
      // File changed on server — clean up stale cache entry
      try {
        const staleFile = new File(Paths.cache, `${CACHE_DIR}/${entry.localFileName}`);
        if (staleFile.exists) staleFile.delete();
      } catch {
        /* silent */
      }
      this.index.totalSize = Math.max(0, this.index.totalSize - entry.size);
      delete this.index.entries[key];
      this.schedulePersist();
      return null;
    }

    // Check local file exists (iOS may auto-purge Caches/)
    const localFile = new File(Paths.cache, `${CACHE_DIR}/${entry.localFileName}`);
    if (!localFile.exists) {
      this.index.totalSize = Math.max(0, this.index.totalSize - entry.size);
      delete this.index.entries[key];
      this.schedulePersist();
      return null;
    }

    // Update LRU access time
    entry.lastAccessedAt = Date.now();
    this.schedulePersist();

    return localFile.uri;
  }

  /**
   * Get cached file or download it. Returns local file URI.
   */
  async getOrDownload(
    serverPath: string,
    modifiedAt: number,
    size: number,
    owner?: string,
    root?: boolean,
  ): Promise<string> {
    if (!serverPath) throw new Error('serverPath is required');
    const scope = this.captureScope();

    // Check cache first
    const cached = await this.getCached(serverPath, modifiedAt, size, owner, root);
    if (cached) return cached;

    // Deduplicate concurrent downloads
    this.assertScope(scope);
    const key = makeCacheKey(scope, serverPath, owner, root);
    const existing = this.inflight.get(key);
    if (existing) return existing;

    const downloadPromise = this.downloadAndCache(scope, serverPath, modifiedAt, size, owner, root);
    this.inflight.set(key, downloadPromise);

    try {
      const uri = await downloadPromise;
      return uri;
    } finally {
      // A fenced request may finish after a new lifecycle has installed another
      // promise under the same logical key. Never delete the newer request.
      if (this.inflight.get(key) === downloadPromise) this.inflight.delete(key);
    }
  }

  /** Authenticated attachmentId route; never accepts a client path or external URL. */
  async getOrDownloadAttachment(attachmentId: string, originalName: string): Promise<string> {
    if (!/^[0-9a-f-]{36}$/i.test(attachmentId)) throw new Error('attachmentId is invalid');
    const scope = this.captureScope();
    this.ensureCacheDir();
    const platform = getPlatform();
    const baseUrl = platform.platformConfig.getBaseUrl();
    const url = `${baseUrl}/api/attachments/${encodeURIComponent(attachmentId)}/content`;
    platform.platformConfig.assertTrustedUrl?.(url, 'http');
    if (!isSensitiveTransportAllowed()) throw new Error('LOCAL_APP_LOCK_BLOCKED');
    const token = await platform.secureStorage.getItem(TOKEN_KEY);
    const extension = originalName.includes('.')
      ? originalName.slice(originalName.lastIndexOf('.')).replace(/[^.A-Za-z0-9]/g, '')
      : '';
    const finalFile = new File(
      Paths.cache,
      `${CACHE_DIR}/${sha256Hex(`${scope.key}:attachment:${attachmentId}`)}${extension}`,
    );
    const temporary = new File(
      Paths.cache,
      `${CACHE_DIR}/.${sha256Hex(`${scope.key}:${attachmentId}:${Date.now()}:${Math.random()}`)}.tmp`,
    );
    const downloaded = await File.downloadFileAsync(url, temporary, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      idempotent: false,
    });
    try {
      this.assertScope(scope);
      if (finalFile.exists) finalFile.delete();
      downloaded.move(finalFile);
      return finalFile.uri;
    } catch (error) {
      try {
        if (downloaded.exists) downloaded.delete();
      } catch {
        /* best effort */
      }
      throw error;
    }
  }

  /**
   * Clear all cached files and reset index.
   */
  async clearAll(): Promise<void> {
    this.lifecycleGeneration += 1;
    this.inflight.clear();
    try {
      const cacheDir = new Directory(Paths.cache, CACHE_DIR);
      if (cacheDir.exists) {
        cacheDir.delete();
      }
    } catch {
      /* silent */
    }
    try {
      const legacyDir = new Directory(Paths.cache, LEGACY_CACHE_DIR);
      if (legacyDir.exists) legacyDir.delete();
    } catch {
      /* legacy cache cleanup is best effort */
    }

    this.index = { version: 2, entries: {}, totalSize: 0 };
    this.loaded = true;

    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }

    try {
      await Promise.all([AsyncStorage.removeItem(INDEX_KEY), AsyncStorage.removeItem(LEGACY_INDEX_KEY)]);
    } catch {
      /* silent */
    }
  }

  // --- Private methods (trusted service transport) ---

  private ensureCacheDir(): void {
    try {
      const dir = new Directory(Paths.cache, CACHE_DIR);
      if (!dir.exists) {
        dir.create();
      }
    } catch {
      /* silent */
    }
  }

  private async downloadAndCache(
    scope: CacheScope,
    serverPath: string,
    modifiedAt: number,
    size: number,
    owner?: string,
    root?: boolean,
  ): Promise<string> {
    // Ensure cache dir exists (may have been purged since init)
    this.ensureCacheDir();

    const platform = getPlatform();
    const baseUrl = platform.platformConfig.getBaseUrl();
    // KB 文档（`kb://<doc>#page=N`，引用溯源卡）走租户共享只读端点 `/api/kb/file`，
    // 与 Web `CitationCard`/`PdfJsReader` 同一口径；此前只认工作区端点，
    // 导致 KB 根文档在移动端必然 404（P1 缺口）。
    const source = resolveFileReadSource(serverPath, 'download', { owner, root });
    let url: string;
    if (source.kind === 'kb') {
      if (!source.doc) throw new Error('引用文档路径无效');
      url = await resolveKbFileSrc(source.doc);
    } else {
      url = `${baseUrl}${source.workspaceUrl}`;
    }
    // Native downloads bypass authFetch, so enforce the identical origin policy
    // before reading the Bearer token or handing the request to Expo FileSystem.
    platform.platformConfig.assertTrustedUrl?.(url, 'http');
    if (!isSensitiveTransportAllowed()) throw new Error('LOCAL_APP_LOCK_BLOCKED');
    this.assertScope(scope);
    const token = await platform.secureStorage.getItem(TOKEN_KEY);

    const localFileName = makeLocalFileName(scope, serverPath, owner, root);
    const destFile = new File(Paths.cache, `${CACHE_DIR}/${localFileName}`);
    const temporary = new File(
      Paths.cache,
      `${CACHE_DIR}/.${sha256Hex(`${scope.key}:${serverPath}:${Date.now()}:${Math.random()}`)}.tmp`,
    );

    const downloaded = await File.downloadFileAsync(url, temporary, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      idempotent: false,
    });

    try {
      this.assertScope(scope);
      if (destFile.exists) destFile.delete();
      downloaded.move(destFile);
    } catch (error) {
      try {
        if (downloaded.exists) downloaded.delete();
      } catch {
        /* best effort */
      }
      throw error;
    }

    // Get actual downloaded size
    let actualSize = size;
    try {
      if (destFile.exists && destFile.size != null) {
        actualSize = destFile.size;
      }
    } catch {
      /* use server size */
    }

    // Update index
    const key = makeCacheKey(scope, serverPath, owner, root);
    const oldEntry = this.index.entries[key];
    if (oldEntry) {
      this.index.totalSize = Math.max(0, this.index.totalSize - oldEntry.size);
    }

    const entrySize = actualSize || size;
    this.index.entries[key] = {
      serverPath,
      localFileName,
      modifiedAt,
      size: entrySize,
      cachedAt: Date.now(),
      lastAccessedAt: Date.now(),
      owner,
    };
    this.index.totalSize += entrySize;

    // Evict if needed, then persist
    await this.evictIfNeeded();
    try {
      this.assertScope(scope);
    } catch (error) {
      if (this.index.entries[key]?.localFileName === localFileName) {
        this.index.totalSize = Math.max(0, this.index.totalSize - entrySize);
        delete this.index.entries[key];
      }
      try {
        if (destFile.exists) destFile.delete();
      } catch {
        /* best effort */
      }
      throw error;
    }
    this.schedulePersist();

    return destFile.uri;
  }

  private async evictIfNeeded(): Promise<void> {
    if (this.index.totalSize <= MAX_CACHE_SIZE) return;

    // Sort entries by lastAccessedAt ascending (least recently used first)
    const sortedKeys = Object.keys(this.index.entries).sort(
      (a, b) => this.index.entries[a].lastAccessedAt - this.index.entries[b].lastAccessedAt,
    );

    for (const key of sortedKeys) {
      if (this.index.totalSize <= EVICT_TARGET) break;

      const entry = this.index.entries[key];
      try {
        const localFile = new File(Paths.cache, `${CACHE_DIR}/${entry.localFileName}`);
        if (localFile.exists) {
          localFile.delete();
        }
      } catch {
        /* silent */
      }

      this.index.totalSize = Math.max(0, this.index.totalSize - entry.size);
      delete this.index.entries[key];
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistIndex();
    }, PERSIST_DEBOUNCE_MS);
  }

  private async persistIndex(): Promise<void> {
    try {
      await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(this.index));
    } catch {
      /* silent */
    }
  }
}

export const fileCacheService = new FileCacheService();

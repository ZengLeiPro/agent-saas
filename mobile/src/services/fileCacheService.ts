import { File, Paths, Directory } from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getPlatform, TOKEN_KEY } from '@agent/shared';

// --- Constants ---
const MAX_CACHE_SIZE = 1024 * 1024 * 1024; // 1 GB
const EVICT_TARGET = 700 * 1024 * 1024;     // 700 MB
const INDEX_KEY = 'fileCache:index';
const PERSIST_DEBOUNCE_MS = 2000;
const CACHE_DIR = 'files';

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
  version: 1;
  entries: Record<string, FileCacheEntry>;
  totalSize: number;
}

// --- DJB2 hash ---
function djb2Hash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

function makeCacheKey(serverPath: string, owner?: string, root?: boolean): string {
  const prefix = root ? '__root__:' : '';
  return owner ? `${prefix}${owner}:${serverPath}` : `${prefix}${serverPath}`;
}

function makeLocalFileName(serverPath: string, owner?: string, root?: boolean): string {
  const ext = serverPath.includes('.') ? serverPath.slice(serverPath.lastIndexOf('.')) : '';
  return djb2Hash(makeCacheKey(serverPath, owner, root)) + ext;
}

class FileCacheService {
  private index: FileCacheIndex = { version: 1, entries: {}, totalSize: 0 };
  private loaded = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private inflight = new Map<string, Promise<string>>();

  async init(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await AsyncStorage.getItem(INDEX_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as FileCacheIndex;
        if (parsed.version === 1 && parsed.entries) {
          this.index = parsed;
        }
      }
    } catch { /* corrupted index, start fresh */ }
    // Ensure cache subdirectory exists
    this.ensureCacheDir();
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
    await this.init();
    const key = makeCacheKey(serverPath, owner, root);
    const entry = this.index.entries[key];
    if (!entry) return null;

    // When caller provides real metadata, validate against cached entry
    const skipValidation = modifiedAt === 0 && size === 0;
    if (!skipValidation && (entry.modifiedAt !== modifiedAt || entry.size !== size)) {
      // File changed on server — clean up stale cache entry
      try {
        const staleFile = new File(Paths.cache, `${CACHE_DIR}/${entry.localFileName}`);
        if (staleFile.exists) staleFile.delete();
      } catch { /* silent */ }
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

    // Check cache first
    const cached = await this.getCached(serverPath, modifiedAt, size, owner, root);
    if (cached) return cached;

    // Deduplicate concurrent downloads
    const key = makeCacheKey(serverPath, owner, root);
    const existing = this.inflight.get(key);
    if (existing) return existing;

    const downloadPromise = this.downloadAndCache(serverPath, modifiedAt, size, owner, root);
    this.inflight.set(key, downloadPromise);

    try {
      const uri = await downloadPromise;
      return uri;
    } finally {
      this.inflight.delete(key);
    }
  }

  /**
   * Clear all cached files and reset index.
   */
  async clearAll(): Promise<void> {
    try {
      const cacheDir = new Directory(Paths.cache, CACHE_DIR);
      if (cacheDir.exists) {
        cacheDir.delete();
      }
    } catch { /* silent */ }

    this.index = { version: 1, entries: {}, totalSize: 0 };
    this.loaded = true;

    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }

    try {
      await AsyncStorage.removeItem(INDEX_KEY);
    } catch { /* silent */ }
  }

  // --- Private methods ---

  private ensureCacheDir(): void {
    try {
      const dir = new Directory(Paths.cache, CACHE_DIR);
      if (!dir.exists) {
        dir.create();
      }
    } catch { /* silent */ }
  }

  private async downloadAndCache(
    serverPath: string,
    modifiedAt: number,
    size: number,
    owner?: string,
    root?: boolean,
  ): Promise<string> {
    // Ensure cache dir exists (may have been purged since init)
    this.ensureCacheDir();

    const platform = getPlatform();
    const token = await platform.secureStorage.getItem(TOKEN_KEY);
    const baseUrl = platform.platformConfig.getBaseUrl();
    const ownerParam = owner ? `&owner=${encodeURIComponent(owner)}` : '';
    const rootParam = root ? '&root=true' : '';
    const url = `${baseUrl}/api/file/download?path=${encodeURIComponent(serverPath)}${ownerParam}${rootParam}`;

    const localFileName = makeLocalFileName(serverPath, owner, root);
    const destFile = new File(Paths.cache, `${CACHE_DIR}/${localFileName}`);

    const downloaded = await File.downloadFileAsync(url, destFile, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      idempotent: true,
    });

    // Get actual downloaded size
    let actualSize = size;
    try {
      if (destFile.exists && destFile.size != null) {
        actualSize = destFile.size;
      }
    } catch { /* use server size */ }

    // Update index
    const key = makeCacheKey(serverPath, owner, root);
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
    this.schedulePersist();

    return downloaded.uri;
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
      } catch { /* silent */ }

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
    } catch { /* silent */ }
  }
}

export const fileCacheService = new FileCacheService();

import { Directory, File, Paths } from 'expo-file-system';
import { selectVoiceMediaCacheEvictions, type VoiceMediaCacheEntry } from './voiceMediaCachePolicy';

const CACHE_DIR = 'voice-media-v1';
let sequence = 0;
const protectedUris = new Set<string>();

function hash(value: string): string {
  let result = 5381;
  for (let index = 0; index < value.length; index += 1) result = ((result << 5) + result + value.charCodeAt(index)) >>> 0;
  return result.toString(36);
}

function directory(): Directory {
  const value = new Directory(Paths.cache, CACHE_DIR);
  if (!value.exists) value.create({ idempotent: true, intermediates: true });
  return value;
}

export function createVoiceMediaTempFile(ownerKey: string, kind: 'voice' | 'tts', extension: 'wav' | 'mp3'): File {
  const owner = hash(ownerKey || 'anonymous');
  return new File(directory(), `${owner}_${kind}_${Date.now()}_${sequence++}.${extension}`);
}

export function protectVoiceMediaFile(file: File | null): void {
  if (file) protectedUris.add(file.uri);
}

export function releaseVoiceMediaFile(file: File | null): void {
  if (!file) return;
  protectedUris.delete(file.uri);
  try { if (file.exists) file.delete(); } catch {}
}

/** Startup/foreground maintenance. Active playback/upload paths are never selected. */
export function sweepVoiceMediaTempCache(now = Date.now()): void {
  let root: Directory;
  try { root = directory(); } catch { return; }
  const files = root.list().filter((entry): entry is File => entry instanceof File && entry.exists);
  const entries: VoiceMediaCacheEntry[] = files.map(file => ({
    uri: file.uri,
    size: file.size ?? 0,
    modifiedAt: file.modificationTime ?? now,
    protected: protectedUris.has(file.uri),
  }));
  const evictions = new Set(selectVoiceMediaCacheEvictions(entries, now));
  for (const file of files) {
    if (!evictions.has(file.uri)) continue;
    try { file.delete(); } catch {}
  }
}

/** Logout cleanup is fail-safe: never remove a source still owned by active playback/upload. */
export function clearVoiceMediaTempCache(): void {
  try {
    const root = new Directory(Paths.cache, CACHE_DIR);
    if (!root.exists) return;
    for (const entry of root.list()) {
      if (entry instanceof File && entry.exists && !protectedUris.has(entry.uri)) entry.delete();
    }
    if (root.list().length === 0) root.delete();
  } catch {}
}

export const VOICE_MEDIA_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const VOICE_MEDIA_CACHE_MAX_BYTES = 64 * 1024 * 1024;
export const VOICE_MEDIA_CACHE_MAX_COUNT = 8;

export interface VoiceMediaCacheEntry {
  uri: string;
  size: number;
  modifiedAt: number;
  protected: boolean;
}

/** TTL first, then oldest-unprotected LRU until both count and byte caps are met. */
export function selectVoiceMediaCacheEvictions(entries: readonly VoiceMediaCacheEntry[], now = Date.now()): string[] {
  const deleted = new Set<string>();
  for (const entry of entries) {
    if (!entry.protected && now - entry.modifiedAt >= VOICE_MEDIA_CACHE_TTL_MS) deleted.add(entry.uri);
  }
  const remaining = entries.filter(entry => !deleted.has(entry.uri));
  let count = remaining.length;
  let bytes = remaining.reduce((sum, entry) => sum + Math.max(0, entry.size), 0);
  for (const entry of [...remaining].filter(entry => !entry.protected).sort((a, b) => a.modifiedAt - b.modifiedAt)) {
    if (count <= VOICE_MEDIA_CACHE_MAX_COUNT && bytes <= VOICE_MEDIA_CACHE_MAX_BYTES) break;
    deleted.add(entry.uri);
    count -= 1;
    bytes -= Math.max(0, entry.size);
  }
  return [...deleted];
}

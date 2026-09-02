import { describe, expect, it } from 'vitest';
import {
  selectVoiceMediaCacheEvictions,
  VOICE_MEDIA_CACHE_MAX_BYTES,
  VOICE_MEDIA_CACHE_TTL_MS,
} from './voiceMediaCachePolicy';

describe('M50-04 mobile voice media cache pressure', () => {
  it('evicts expired and oldest unprotected entries without deleting active playback/upload files', () => {
    const now = 2 * VOICE_MEDIA_CACHE_TTL_MS;
    const entries = [
      { uri: 'expired', size: 1, modifiedAt: 0, protected: false },
      { uri: 'playing', size: VOICE_MEDIA_CACHE_MAX_BYTES, modifiedAt: 1, protected: true },
      { uri: 'old', size: 1024, modifiedAt: now - 10, protected: false },
      { uri: 'new', size: 1024, modifiedAt: now - 1, protected: false },
    ];
    const evicted = selectVoiceMediaCacheEvictions(entries, now);
    expect(evicted).toContain('expired');
    expect(evicted).toContain('old');
    expect(evicted).toContain('new');
    expect(evicted).not.toContain('playing');
  });

  it('enforces the count cap by LRU order', () => {
    const entries = Array.from({ length: 10 }, (_, index) => ({
      uri: String(index), size: 1, modifiedAt: index + 1, protected: false,
    }));
    expect(selectVoiceMediaCacheEvictions(entries, 10)).toEqual(['0', '1']);
  });
});

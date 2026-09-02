import { describe, expect, it } from 'vitest';
import { isTtsCapabilityAvailable } from './ttsCapability';

describe('M50-04 TTS capability contract', () => {
  it('fails closed unless the canonical top-level health field is literal true', () => {
    expect(isTtsCapabilityAvailable({ ttsAvailable: true })).toBe(true);
    expect(isTtsCapabilityAvailable({ ttsAvailable: false })).toBe(false);
    expect(isTtsCapabilityAvailable({ data: { ttsAvailable: true } })).toBe(false);
    expect(isTtsCapabilityAvailable({ ttsAvailable: 'true' })).toBe(false);
    expect(isTtsCapabilityAvailable(undefined)).toBe(false);
  });
});

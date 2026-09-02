import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('@/lib/authFetch', () => ({ authFetch }));

import { useVoicePlayer } from './useVoicePlayer';

class AudioStub {
  paused = true;
  ended = false;
  currentTime = 12;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  play = vi.fn(async () => { this.paused = false; });
  pause = vi.fn(() => { this.paused = true; });
  removeAttribute = vi.fn();
  load = vi.fn();
  constructor(_source?: string) {}
}

describe('M50-04 Web historical voice player', () => {
  let audio: AudioStub;
  const revokeObjectURL = vi.fn();
  beforeEach(() => {
    audio = new AudioStub();
    authFetch.mockReset().mockResolvedValue(new Response(new Blob(['voice'], { type: 'audio/wav' }), { status: 200 }));
    vi.stubGlobal('Audio', class { constructor() { return audio; } });
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:voice') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    revokeObjectURL.mockClear();
  });

  it('pauses/resumes at the retained position and stops when the page backgrounds', async () => {
    const { result, unmount } = renderHook(() => useVoicePlayer());
    act(() => result.current.play('message-1', '11111111-1111-4111-8111-111111111111'));
    await waitFor(() => expect(result.current.getState('message-1')).toBe('playing'));

    act(() => result.current.togglePause('message-1'));
    expect(result.current.getState('message-1')).toBe('paused');
    expect(audio.currentTime).toBe(12);

    act(() => result.current.togglePause('message-1'));
    await waitFor(() => expect(result.current.getState('message-1')).toBe('playing'));
    expect(audio.currentTime).toBe(12);
    expect(authFetch).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(result.current.getState('message-1')).toBe('idle');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:voice');
    unmount();
  });
});

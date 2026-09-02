import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('@/lib/authFetch', () => ({ authFetch }));

import { useTtsPlayer } from './useTtsPlayer';

describe('M50-04 Web TTS capability gate', () => {
  beforeEach(() => {
    localStorage.clear();
    authFetch.mockReset();
  });

  it('defaults autoplay off and makes no synthesis request without a positive health capability', async () => {
    authFetch.mockResolvedValueOnce(new Response(JSON.stringify({ ttsAvailable: false }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    const { result, unmount } = renderHook(() => useTtsPlayer());
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
    expect(result.current.available).toBe(false);
    expect(result.current.autoPlay).toBe(false);
    act(() => result.current.play('message-1', '不得调用网络'));
    await Promise.resolve();
    expect(authFetch).toHaveBeenCalledTimes(1);
    expect(authFetch).not.toHaveBeenCalledWith('/api/tts', expect.anything());
    unmount();
  });
});

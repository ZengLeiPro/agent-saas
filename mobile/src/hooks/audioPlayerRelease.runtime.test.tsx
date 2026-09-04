// @vitest-environment jsdom
import React, { Activity } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const players: Array<{
    playing: boolean;
    pause: ReturnType<typeof vi.fn>;
    play: ReturnType<typeof vi.fn>;
    replace: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  }> = [];
  const createAudioPlayer = vi.fn(() => {
    const player = {
      playing: false,
      pause: vi.fn(() => {
        throw new Error('native shared object is released');
      }),
      play: vi.fn(),
      replace: vi.fn(),
      release: vi.fn(),
    };
    players.push(player);
    return player;
  });
  return { players, createAudioPlayer };
});

vi.mock('expo-audio', () => ({
  createAudioPlayer: h.createAudioPlayer,
  setAudioModeAsync: vi.fn(async () => undefined),
}));
vi.mock('expo-file-system', () => ({ File: class File {} }));
vi.mock('@agent/shared', () => ({
  authFetch: vi.fn(async () => ({ ok: false })),
  getPlatform: () => ({
    storage: {
      getItem: vi.fn(async () => null),
      setItem: vi.fn(async () => undefined),
    },
  }),
  isTtsCapabilityAvailable: vi.fn(() => false),
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('../services/voiceMediaTempCache', () => ({
  createVoiceMediaTempFile: vi.fn(),
  protectVoiceMediaFile: vi.fn(),
  releaseVoiceMediaFile: vi.fn(),
  sweepVoiceMediaTempCache: vi.fn(),
}));

import { useTtsPlayer } from './useTtsPlayer';
import { useVoicePlayer } from './useVoicePlayer';

function VoiceProbe() {
  useVoicePlayer();
  return null;
}

function TtsProbe() {
  useTtsPlayer();
  return null;
}

function ActivityVoiceProbe({ mode }: { mode: 'visible' | 'hidden' }) {
  return <Activity mode={mode}><VoiceProbe /></Activity>;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  h.players.length = 0;
});

it('does not crash voice-player cleanup when Expo already released the object', () => {
  const view = render(<VoiceProbe />);
  expect(() => view.unmount()).not.toThrow();
  expect(h.players[0]?.pause).toHaveBeenCalled();
  expect(h.players[0]?.release).toHaveBeenCalledOnce();
});

it('does not crash TTS cleanup when Expo already released the object', () => {
  const view = render(<TtsProbe />);
  expect(() => view.unmount()).not.toThrow();
  expect(h.players[0]?.pause).toHaveBeenCalled();
  expect(h.players[0]?.release).toHaveBeenCalledOnce();
});

it('releases and recreates the voice player across React Activity hide and restore', () => {
  const view = render(<ActivityVoiceProbe mode="visible" />);

  expect(() => view.rerender(<ActivityVoiceProbe mode="hidden" />)).not.toThrow();
  expect(h.players[0]?.release).toHaveBeenCalledOnce();
  expect(() => view.rerender(<ActivityVoiceProbe mode="visible" />)).not.toThrow();
  expect(h.createAudioPlayer).toHaveBeenCalledTimes(2);
  expect(h.players[1]?.release).not.toHaveBeenCalled();
});

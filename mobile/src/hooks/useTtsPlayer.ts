import { useState, useRef, useCallback, useEffect } from 'react';
import { AppState } from 'react-native';
import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import { File } from 'expo-file-system';
import { authFetch, getPlatform, isTtsCapabilityAvailable } from '@agent/shared';
import { useAuth } from '../contexts/AuthContext';
import {
  createVoiceMediaTempFile,
  protectVoiceMediaFile,
  releaseVoiceMediaFile,
  sweepVoiceMediaTempCache,
} from '../services/voiceMediaTempCache';

export type TtsState = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

const TTS_AUTOPLAY_KEY = 'tts_autoplay';

export interface UseTtsPlayerReturn {
  activeKey: string | null;
  getState: (key: string) => TtsState;
  play: (key: string, text: string, voice?: string, speed?: number) => void;
  togglePause: (key: string) => void;
  stop: () => void;
  autoPlay: boolean;
  toggleAutoPlay: () => void;
  available: boolean;
}

export function useTtsPlayer(): UseTtsPlayerReturn {
  const [available, setAvailable] = useState(false);
  const [autoPlay, setAutoPlay] = useState(false);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [stateMap, setStateMap] = useState<Record<string, TtsState>>({});
  const activeKeyRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const tempFileRef = useRef<File | null>(null);
  const requestGenerationRef = useRef(0);
  const playerRef = useRef<ReturnType<typeof createAudioPlayer> | null>(null);
  const { user } = useAuth();
  const ownerKey = user ? `${user.tenantId}:${user.id}` : 'anonymous';

  useEffect(() => {
    authFetch('/api/health')
      .then(async (response) => response.ok ? isTtsCapabilityAvailable(await response.json()) : false)
      .then(setAvailable)
      .catch(() => setAvailable(false));

    void (async () => {
      const stored = await getPlatform().storage.getItem(TTS_AUTOPLAY_KEY);
      if (stored === 'true') setAutoPlay(true);
    })();
  }, []);

  const setState = useCallback((key: string, state: TtsState) => {
    setStateMap(prev => ({ ...prev, [key]: state }));
  }, []);

  const stopCurrent = useCallback(() => {
    requestGenerationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    // A native media-services reset can still invalidate the wrapper independently of React.
    try { playerRef.current?.pause(); } catch {}
    releaseVoiceMediaFile(tempFileRef.current);
    tempFileRef.current = null;
    if (activeKeyRef.current) setState(activeKeyRef.current, 'idle');
    activeKeyRef.current = null;
    setActiveKey(null);
  }, [setState]);

  useEffect(() => {
    const player = createAudioPlayer(null);
    playerRef.current = player;
    return () => {
      stopCurrent();
      if (playerRef.current === player) playerRef.current = null;
      try { player.release(); } catch {}
    };
  }, [stopCurrent]);

  const play = useCallback((key: string, text: string, voice?: string, speed?: number) => {
    // The authenticated health contract is authoritative; absent capability means no synthesis request.
    if (!available) return;
    const player = playerRef.current;
    if (!player) return;
    void (async () => {
      stopCurrent();
      const generation = requestGenerationRef.current;
      activeKeyRef.current = key;
      setActiveKey(key);
      setState(key, 'loading');
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        await setAudioModeAsync({ playsInSilentMode: true });
        const response = await authFetch('/api/tts', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, voice, speed }), signal: controller.signal,
        });
        if (!response.ok) throw new Error(`TTS failed: ${response.status}`);
        const blob = await response.blob();
        if (requestGenerationRef.current !== generation || activeKeyRef.current !== key) return;
        const tempFile = createVoiceMediaTempFile(ownerKey, 'tts', 'mp3');
        tempFile.write(new Uint8Array(await blob.arrayBuffer()));
        if (requestGenerationRef.current !== generation || activeKeyRef.current !== key) {
          releaseVoiceMediaFile(tempFile);
          return;
        }
        tempFileRef.current = tempFile;
        protectVoiceMediaFile(tempFile);
        player.replace({ uri: tempFile.uri });
        player.play();
        setState(key, 'playing');
      } catch (error) {
        if ((error as Error).name === 'AbortError') return;
        setState(key, 'error');
        activeKeyRef.current = null;
        setActiveKey(null);
      }
    })();
  }, [available, ownerKey, setState, stopCurrent]);

  const togglePause = useCallback((key: string) => {
    if (activeKeyRef.current !== key) return;
    const player = playerRef.current;
    if (!player) return;
    try {
      if (player.playing) { player.pause(); setState(key, 'paused'); }
      else { player.play(); setState(key, 'playing'); }
    } catch {
      stopCurrent();
    }
  }, [setState, stopCurrent]);

  const toggleAutoPlay = useCallback(() => {
    setAutoPlay(prev => {
      const next = !prev;
      void getPlatform().storage.setItem(TTS_AUTOPLAY_KEY, String(next));
      return next;
    });
  }, []);

  const getState = useCallback((key: string): TtsState => stateMap[key] || 'idle', [stateMap]);

  useEffect(() => {
    sweepVoiceMediaTempCache();
    return stopCurrent;
  }, [ownerKey, stopCurrent]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', next => { if (next !== 'active') stopCurrent(); });
    return () => { subscription.remove(); stopCurrent(); };
  }, [stopCurrent]);

  return { activeKey, getState, play, togglePause, stop: stopCurrent, autoPlay, toggleAutoPlay, available };
}

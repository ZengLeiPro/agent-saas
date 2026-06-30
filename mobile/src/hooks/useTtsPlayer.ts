import { useState, useRef, useCallback, useEffect } from 'react';
import { useAudioPlayer, setAudioModeAsync } from 'expo-audio';
import { File, Paths } from 'expo-file-system';
import { authFetch, getPlatform } from '@agent/shared';

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
  const player = useAudioPlayer(null);

  useEffect(() => {
    authFetch('/api/health')
      .then(r => r.ok ? r.json() as Promise<{ data?: { ttsAvailable?: boolean } }> : null)
      .then(data => {
        if (data?.data?.ttsAvailable) setAvailable(true);
      })
      .catch(() => {});

    void (async () => {
      const stored = await getPlatform().storage.getItem(TTS_AUTOPLAY_KEY);
      if (stored === 'true') setAutoPlay(true);
    })();
  }, []);

  const setState = useCallback((key: string, state: TtsState) => {
    setStateMap(prev => ({ ...prev, [key]: state }));
  }, []);

  const stopCurrent = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    player.pause();
    if (activeKeyRef.current) {
      setState(activeKeyRef.current, 'idle');
    }
    activeKeyRef.current = null;
    setActiveKey(null);
  }, [player, setState]);

  const play = useCallback((key: string, text: string, voice?: string, speed?: number) => {
    void (async () => {
      stopCurrent();

      activeKeyRef.current = key;
      setActiveKey(key);
      setState(key, 'loading');

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        await setAudioModeAsync({ playsInSilentMode: true });

        const response = await authFetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, voice, speed }),
          signal: controller.signal,
        });

        if (!response.ok) throw new Error(`TTS failed: ${response.status}`);
        if (activeKeyRef.current !== key) return;

        const blob = await response.blob();
        const tempFile = new File(Paths.cache, `tts_${Date.now()}.mp3`);
        const arrayBuffer = await blob.arrayBuffer();
        tempFile.write(new Uint8Array(arrayBuffer));

        if (activeKeyRef.current !== key) return;

        player.replace({ uri: tempFile.uri });
        player.play();
        setState(key, 'playing');
      } catch (error) {
        if ((error as Error).name === 'AbortError') return;
        console.error('TTS play error:', error);
        setState(key, 'error');
        activeKeyRef.current = null;
        setActiveKey(null);
      }
    })();
  }, [stopCurrent, setState, player]);

  const togglePause = useCallback((key: string) => {
    if (activeKeyRef.current !== key) return;
    if (player.playing) {
      player.pause();
      setState(key, 'paused');
    } else {
      player.play();
      setState(key, 'playing');
    }
  }, [player, setState]);

  const toggleAutoPlay = useCallback(() => {
    setAutoPlay(prev => {
      const next = !prev;
      void getPlatform().storage.setItem(TTS_AUTOPLAY_KEY, String(next));
      return next;
    });
  }, []);

  const getState = useCallback((key: string): TtsState => {
    return stateMap[key] || 'idle';
  }, [stateMap]);

  return { activeKey, getState, play, togglePause, stop: stopCurrent, autoPlay, toggleAutoPlay, available };
}

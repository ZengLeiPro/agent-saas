import { useState, useRef, useCallback } from 'react';
import { useAudioPlayer, setAudioModeAsync } from 'expo-audio';
import { File, Paths } from 'expo-file-system';
import { authFetch } from '@agent/shared';

export type VoicePlayState = 'idle' | 'loading' | 'playing' | 'paused';

export interface UseVoicePlayerReturn {
  activeId: string | null;
  getState: (id: string) => VoicePlayState;
  play: (id: string, audioUrl: string) => void;
  togglePause: (id: string) => void;
  stop: () => void;
}

export function useVoicePlayer(): UseVoicePlayerReturn {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [stateMap, setStateMap] = useState<Record<string, VoicePlayState>>({});
  const activeIdRef = useRef<string | null>(null);
  const player = useAudioPlayer(null);

  const setState = useCallback((id: string, state: VoicePlayState) => {
    setStateMap(prev => ({ ...prev, [id]: state }));
  }, []);

  const stopCurrent = useCallback(() => {
    player.pause();
    if (activeIdRef.current) {
      setState(activeIdRef.current, 'idle');
    }
    activeIdRef.current = null;
    setActiveId(null);
  }, [player, setState]);

  const play = useCallback((id: string, audioUrl: string) => {
    void (async () => {
      stopCurrent();

      activeIdRef.current = id;
      setActiveId(id);
      setState(id, 'loading');

      try {
        await setAudioModeAsync({ playsInSilentMode: true });

        const response = await authFetch(audioUrl);
        if (!response.ok) throw new Error(`Failed to fetch audio: ${response.status}`);
        const blob = await response.blob();

        // Write blob to temp file
        const tempFile = new File(Paths.cache, `voice_${id}_${Date.now()}.wav`);
        const arrayBuffer = await blob.arrayBuffer();
        tempFile.write(new Uint8Array(arrayBuffer));

        if (activeIdRef.current !== id) return;

        player.replace({ uri: tempFile.uri });
        player.play();
        setState(id, 'playing');
      } catch (error) {
        console.error('Voice play error:', error);
        setState(id, 'idle');
        activeIdRef.current = null;
        setActiveId(null);
      }
    })();
  }, [stopCurrent, setState, player]);

  const togglePause = useCallback((id: string) => {
    if (activeIdRef.current !== id) return;
    if (player.playing) {
      player.pause();
      setState(id, 'paused');
    } else {
      player.play();
      setState(id, 'playing');
    }
  }, [player, setState]);

  const getState = useCallback((id: string): VoicePlayState => {
    return stateMap[id] || 'idle';
  }, [stateMap]);

  return { activeId, getState, play, togglePause, stop: stopCurrent };
}

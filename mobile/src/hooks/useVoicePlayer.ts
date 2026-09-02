import { useState, useRef, useCallback, useEffect } from 'react';
import { AppState } from 'react-native';
import { useAudioPlayer, setAudioModeAsync } from 'expo-audio';
import { File } from 'expo-file-system';
import { authFetch } from '@agent/shared';
import { useAuth } from '../contexts/AuthContext';
import {
  createVoiceMediaTempFile,
  protectVoiceMediaFile,
  releaseVoiceMediaFile,
  sweepVoiceMediaTempCache,
} from '../services/voiceMediaTempCache';

export type VoicePlayState = 'idle' | 'loading' | 'playing' | 'paused';

export interface UseVoicePlayerReturn {
  activeId: string | null;
  getState: (id: string) => VoicePlayState;
  play: (id: string, attachmentId: string) => void;
  togglePause: (id: string) => void;
  stop: () => void;
}

/** Module coordinator keeps historical voice playback single-flight across every message row. */
let stopGlobalPlayback: (() => void) | null = null;

export function useVoicePlayer(): UseVoicePlayerReturn {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [stateMap, setStateMap] = useState<Record<string, VoicePlayState>>({});
  const activeIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const tempFileRef = useRef<File | null>(null);
  const generationRef = useRef(0);
  const player = useAudioPlayer(null);
  const { user } = useAuth();
  const ownerKey = user ? `${user.tenantId}:${user.id}` : 'anonymous';

  const setState = useCallback((id: string, state: VoicePlayState) => {
    setStateMap(prev => ({ ...prev, [id]: state }));
  }, []);

  const stopCurrent = useCallback(() => {
    generationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    player.pause();
    releaseVoiceMediaFile(tempFileRef.current);
    tempFileRef.current = null;
    if (activeIdRef.current) setState(activeIdRef.current, 'idle');
    activeIdRef.current = null;
    setActiveId(null);
    if (stopGlobalPlayback === stopCurrent) stopGlobalPlayback = null;
  }, [player, setState]);

  const play = useCallback((id: string, attachmentId: string) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attachmentId)) return;
    void (async () => {
      stopGlobalPlayback?.();
      stopCurrent();
      stopGlobalPlayback = stopCurrent;
      const generation = generationRef.current;
      const controller = new AbortController();
      abortRef.current = controller;
      activeIdRef.current = id;
      setActiveId(id);
      setState(id, 'loading');
      try {
        await setAudioModeAsync({ playsInSilentMode: true });
        const response = await authFetch(`/api/attachments/${encodeURIComponent(attachmentId)}/content`, { signal: controller.signal });
        if (!response.ok) throw new Error(`Failed to fetch audio: ${response.status}`);
        const blob = await response.blob();
        if (generationRef.current !== generation || activeIdRef.current !== id) return;
        const tempFile = createVoiceMediaTempFile(ownerKey, 'voice', 'wav');
        tempFile.write(new Uint8Array(await blob.arrayBuffer()));
        if (generationRef.current !== generation || activeIdRef.current !== id) {
          releaseVoiceMediaFile(tempFile);
          return;
        }
        tempFileRef.current = tempFile;
        protectVoiceMediaFile(tempFile);
        player.replace({ uri: tempFile.uri });
        player.play();
        setState(id, 'playing');
      } catch (error) {
        if ((error as Error).name !== 'AbortError') stopCurrent();
      }
    })();
  }, [ownerKey, player, setState, stopCurrent]);

  const togglePause = useCallback((id: string) => {
    if (activeIdRef.current !== id) return;
    if (player.playing) {
      player.pause();
      setState(id, 'paused');
    } else {
      // expo-audio resumes the same source at the retained currentTime.
      player.play();
      setState(id, 'playing');
    }
  }, [player, setState]);

  const getState = useCallback((id: string): VoicePlayState => stateMap[id] || 'idle', [stateMap]);

  useEffect(() => {
    sweepVoiceMediaTempCache();
    return stopCurrent;
  }, [ownerKey, stopCurrent]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', next => { if (next !== 'active') stopCurrent(); });
    return () => { subscription.remove(); stopCurrent(); };
  }, [stopCurrent]);

  return { activeId, getState, play, togglePause, stop: stopCurrent };
}

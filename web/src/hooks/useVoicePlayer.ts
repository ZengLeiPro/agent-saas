/** Authenticated historical voice playback with pause/resume and lifecycle fences. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { authFetch } from '@/lib/authFetch';

export type VoicePlayState = 'idle' | 'loading' | 'playing' | 'paused';

export interface UseVoicePlayerReturn {
  activeId: string | null;
  getState: (id: string) => VoicePlayState;
  play: (id: string, attachmentId: string) => void;
  togglePause: (id: string) => void;
  stop: () => void;
}

export function useVoicePlayer(): UseVoicePlayerReturn {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [state, setState] = useState<VoicePlayState>('idle');
  const activeIdRef = useRef<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);

  const cleanup = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute('src');
      audioRef.current.load();
      audioRef.current = null;
    }
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    generationRef.current += 1;
    cleanup();
    activeIdRef.current = null;
    setActiveId(null);
    setState('idle');
  }, [cleanup]);

  const play = useCallback((id: string, attachmentId: string) => {
    void (async () => {
      stop();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attachmentId)) return;
      const generation = generationRef.current;
      const controller = new AbortController();
      abortRef.current = controller;
      activeIdRef.current = id;
      setActiveId(id);
      setState('loading');
      try {
        const response = await authFetch(`/api/attachments/${encodeURIComponent(attachmentId)}/content`, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        if (generationRef.current !== generation || activeIdRef.current !== id) return;
        const objectUrl = URL.createObjectURL(blob);
        objectUrlRef.current = objectUrl;
        const audio = new Audio(objectUrl);
        audioRef.current = audio;
        audio.onended = stop;
        audio.onerror = stop;
        await audio.play();
        if (generationRef.current === generation && activeIdRef.current === id) setState('playing');
      } catch (error) {
        if ((error as Error).name !== 'AbortError') stop();
      }
    })();
  }, [stop]);

  const togglePause = useCallback((id: string) => {
    if (activeIdRef.current !== id || !audioRef.current) return;
    if (audioRef.current.paused) {
      // HTMLAudioElement resumes at currentTime; loading a new source is deliberately avoided.
      void audioRef.current.play().then(() => setState('playing')).catch(stop);
    } else {
      audioRef.current.pause();
      setState('paused');
    }
  }, [stop]);

  const getState = useCallback((id: string): VoicePlayState => activeId === id ? state : 'idle', [activeId, state]);

  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState !== 'visible') stop(); };
    const onPageHide = () => stop();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      cleanup();
    };
  }, [cleanup, stop]);

  return { activeId, getState, play, togglePause, stop };
}

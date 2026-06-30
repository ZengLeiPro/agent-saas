/**
 * 语音消息回放 Hook
 *
 * 管理 HTMLAudioElement 实例，支持播放/暂停/停止。
 * 全局同一时间只播放一条语音消息。
 * 通过 authFetch 获取音频数据，确保 JWT 鉴权正常工作。
 */

import { useCallback, useRef, useState } from 'react';
import { authFetch } from '@/lib/authFetch';

export type VoicePlayState = 'idle' | 'loading' | 'playing' | 'paused';

export interface UseVoicePlayerReturn {
  /** 正在播放的消息 ID */
  activeId: string | null;
  /** 获取指定消息的播放状态 */
  getState: (id: string) => VoicePlayState;
  /** 播放 */
  play: (id: string, audioUrl: string) => void;
  /** 暂停/恢复 */
  togglePause: (id: string) => void;
  /** 停止 */
  stop: () => void;
}

export function useVoicePlayer(): UseVoicePlayerReturn {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [state, setState] = useState<VoicePlayState>('idle');
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  const cleanup = useCallback(() => {
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
    cleanup();
    setActiveId(null);
    setState('idle');
  }, [cleanup]);

  const play = useCallback(async (id: string, audioUrl: string) => {
    // 如果正在播放别的，先停止
    stop();

    setActiveId(id);
    setState('loading');

    try {
      // 通过 authFetch 获取音频数据，携带 JWT token
      const res = await authFetch(audioUrl);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      objectUrlRef.current = objectUrl;

      const audio = new Audio(objectUrl);
      audioRef.current = audio;
      setState('playing');

      audio.onended = () => {
        setActiveId(null);
        setState('idle');
        cleanup();
      };
      audio.onerror = () => {
        setActiveId(null);
        setState('idle');
        cleanup();
      };

      await audio.play();
    } catch {
      setActiveId(null);
      setState('idle');
      cleanup();
    }
  }, [stop, cleanup]);

  const togglePause = useCallback((id: string) => {
    if (activeId !== id || !audioRef.current) return;

    if (state === 'playing') {
      audioRef.current.pause();
      setState('paused');
    } else if (state === 'paused') {
      audioRef.current.play().catch(() => {});
      setState('playing');
    }
  }, [activeId, state]);

  const getState = useCallback((id: string): VoicePlayState => {
    if (activeId !== id) return 'idle';
    return state;
  }, [activeId, state]);

  return { activeId, getState, play, togglePause, stop };
}

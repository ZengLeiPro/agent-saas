/**
 * TTS Player Hook
 *
 * 全局单例管理：一个 HTMLAudioElement 实例，同一时间只播放一条消息。
 * 提供 play / togglePause / stop 操作和各消息的播放状态追踪。
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { authFetch } from '@/lib/authFetch';
import { TTS_AUTOPLAY_KEY } from '@/lib/constants';

export type TtsState = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

export interface UseTtsPlayerReturn {
  /** 各消息的 TTS 状态，key = 调用方指定的唯一标识 */
  getState: (key: string) => TtsState;
  /** 响应式状态 map，供 MessageList 消费 */
  ttsStateMap: Record<string, TtsState>;
  /** 当前正在播放的 key */
  activeKey: string | null;
  /** 播放指定文本 */
  play: (key: string, text: string, voice?: string, speed?: number) => void;
  /** 暂停/恢复 */
  togglePause: (key: string) => void;
  /** 停止播放 */
  stop: () => void;
  /** 自动播放开关 */
  autoPlay: boolean;
  /** 切换自动播放 */
  toggleAutoPlay: () => void;
  /** TTS 是否可用（后端已配置） */
  available: boolean;
}

export function useTtsPlayer(): UseTtsPlayerReturn {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [stateMap, setStateMap] = useState<Record<string, TtsState>>({});
  const stateMapRef = useRef<Record<string, TtsState>>({});
  stateMapRef.current = stateMap;
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [autoPlay, setAutoPlay] = useState(() => {
    const stored = localStorage.getItem(TTS_AUTOPLAY_KEY);
    return stored === null ? true : stored === 'true';
  });
  const [available, setAvailable] = useState(false);

  // 启动时检测 TTS 是否可用
  useEffect(() => {
    authFetch('/api/health')
      .then((res) => res.json())
      .then((data) => {
        // health 端点返回配置信息，检查 tts 是否存在
        setAvailable(data?.ttsAvailable === true);
      })
      .catch(() => setAvailable(false));
  }, []);

  const updateState = useCallback((key: string, state: TtsState) => {
    setStateMap((prev) => ({ ...prev, [key]: state }));
  }, []);

  const cleanup = useCallback(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;

    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute('src');
      audioRef.current.load();
    }
    cleanup();

    setActiveKey((prev) => {
      if (prev) {
        setStateMap((s) => ({ ...s, [prev]: 'idle' }));
      }
      return null;
    });
  }, [cleanup]);

  const play = useCallback(
    (key: string, text: string, voice?: string, speed?: number) => {
      // 停止当前播放
      stop();

      updateState(key, 'loading');
      setActiveKey(key);

      const controller = new AbortController();
      abortRef.current = controller;

      (async () => {
        try {
          const body: Record<string, unknown> = { text };
          if (voice) body.voice = voice;
          if (speed) body.speed = speed;

          const response = await authFetch('/api/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
          });

          if (!response.ok) {
            throw new Error(`TTS request failed: ${response.status}`);
          }

          const blob = await response.blob();
          const url = URL.createObjectURL(blob);
          objectUrlRef.current = url;

          if (!audioRef.current) {
            audioRef.current = new Audio();
          }
          const audio = audioRef.current;
          audio.src = url;

          audio.onplay = () => updateState(key, 'playing');
          audio.onpause = () => {
            if (!audio.ended) updateState(key, 'paused');
          };
          audio.onended = () => {
            updateState(key, 'idle');
            setActiveKey(null);
            cleanup();
          };
          audio.onerror = () => {
            updateState(key, 'error');
            setTimeout(() => updateState(key, 'idle'), 1500);
            setActiveKey(null);
            cleanup();
          };

          await audio.play();
        } catch (err) {
          if ((err as Error).name === 'AbortError') return;
          updateState(key, 'error');
          setTimeout(() => updateState(key, 'idle'), 1500);
          setActiveKey(null);
          cleanup();
        }
      })();
    },
    [stop, updateState, cleanup],
  );

  const activeKeyRef = useRef(activeKey);
  activeKeyRef.current = activeKey;

  const togglePause = useCallback(
    (key: string) => {
      if (!audioRef.current || activeKeyRef.current !== key) return;
      if (audioRef.current.paused) {
        audioRef.current.play().catch(() => {});
      } else {
        audioRef.current.pause();
      }
    },
    [],
  );

  const toggleAutoPlay = useCallback(() => {
    setAutoPlay((prev) => {
      const next = !prev;
      localStorage.setItem(TTS_AUTOPLAY_KEY, String(next));
      return next;
    });
  }, []);

  const getState = useCallback(
    (key: string): TtsState => stateMapRef.current[key] || 'idle',
    [],
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      abortRef.current?.abort();
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
      }
    };
  }, []);

  return {
    getState,
    ttsStateMap: stateMap,
    activeKey,
    play,
    togglePause,
    stop,
    autoPlay,
    toggleAutoPlay,
    available,
  };
}

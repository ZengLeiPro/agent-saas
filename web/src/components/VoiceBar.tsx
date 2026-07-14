/**
 * VoiceBar
 *
 * Agent [VOICE] 标记产生的内嵌语音播放器条。
 * 显示在文本消息气泡下方。
 */

import { Loader2, Pause, Play } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TtsState } from '@/hooks/useTtsPlayer';

interface VoiceBarProps {
  text: string;
  voice?: string;
  speed?: number;
  state: TtsState;
  onPlay: () => void;
  onTogglePause: () => void;
}

export function VoiceBar({ state, onPlay, onTogglePause }: VoiceBarProps) {
  const handleClick = () => {
    if (state === 'idle' || state === 'error') {
      onPlay();
    } else if (state === 'playing' || state === 'paused') {
      onTogglePause();
    }
  };

  const isPlaying = state === 'playing';
  const isLoading = state === 'loading';

  return (
    <div className="mt-2 flex items-center gap-2 rounded-md bg-accent/50 px-2 py-1.5">
      <button
        onClick={handleClick}
        disabled={isLoading}
        className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-white hover:bg-primary/80 disabled:opacity-70"
      >
        {isLoading ? (
          <Loader2 className="size-3 animate-spin" />
        ) : isPlaying ? (
          <Pause className="size-3" />
        ) : (
          <Play className="size-3 ml-0.5" />
        )}
      </button>

      {/* 波形指示器 */}
      <div className="flex items-center gap-px">
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className={cn(
              'w-0.5 rounded-full bg-primary/60 transition-all',
              isPlaying ? 'animate-soundbar' : 'h-1',
            )}
            style={
              isPlaying
                ? { animationDelay: `${i * 0.15}s`, height: '12px' }
                : undefined
            }
          />
        ))}
      </div>

      <span className="text-xs text-muted-foreground">
        {state === 'error' ? 'Error' : isLoading ? 'Loading...' : ''}
      </span>
    </div>
  );
}

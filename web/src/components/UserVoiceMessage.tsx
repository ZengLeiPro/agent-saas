/**
 * 用户语音消息条组件（微信风格）
 *
 * 特性:
 * - 右对齐，用户消息配色
 * - 气泡宽度随时长变化
 * - 播放/暂停按钮 + CSS 波形动画 + 时长
 * - 状态: uploading / transcribing / sent / failed
 * - 转写文字可折叠展开
 */

import { useState } from 'react';
import { Play, Pause, Loader2, CircleAlert, ChevronDown, ChevronUp } from 'lucide-react';
import type { VoicePlayState } from '../hooks/useVoicePlayer';

interface UserVoiceMessageProps {
  audioUrl: string;
  duration: number;          // 秒
  transcribedText?: string;
  status: 'uploading' | 'transcribing' | 'sent' | 'failed';
  playState: VoicePlayState;
  onPlay: () => void;
  onTogglePause: () => void;
  timestamp?: number;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  if (m > 0) return `${m}:${s.toString().padStart(2, '0')}`;
  return `${s}"`;
}

/** 气泡宽度: 1秒 → 30%, 60秒 → 70%, 线性插值 */
function getBubbleWidth(duration: number): string {
  const minW = 30;
  const maxW = 70;
  const t = Math.min(duration / 60, 1);
  const w = Math.round(minW + t * (maxW - minW));
  return `${w}%`;
}

export function UserVoiceMessage({
  audioUrl: _audioUrl,
  duration,
  transcribedText,
  status,
  playState,
  onPlay,
  onTogglePause,
  timestamp,
}: UserVoiceMessageProps) {
  const [showText, setShowText] = useState(false);
  const isLoading = playState === 'loading';
  const isPlaying = playState === 'playing';
  const isPaused = playState === 'paused';

  return (
    <div className="flex flex-col items-end gap-1">
      {/* 语音气泡 */}
      <div
        className="flex items-center gap-2 rounded-lg px-3 py-2 bg-user-bubble text-foreground cursor-pointer select-none"
        style={{ minWidth: '100px', maxWidth: '70%', width: getBubbleWidth(duration) }}
        onClick={() => {
          if (status !== 'sent' || isLoading) return;
          if (playState === 'idle') onPlay();
          else onTogglePause();
        }}
      >
        {/* 左侧: 播放按钮 / 状态图标 */}
        {status === 'uploading' || status === 'transcribing' ? (
          <Loader2 className="size-5 shrink-0 animate-spin text-muted-foreground" />
        ) : status === 'failed' ? (
          <CircleAlert className="size-5 shrink-0 text-destructive/60" />
        ) : isLoading ? (
          <Loader2 className="size-5 shrink-0 animate-spin" />
        ) : isPlaying || isPaused ? (
          <Pause className="size-5 shrink-0" />
        ) : (
          <Play className="size-5 shrink-0" />
        )}

        {/* 中间: 波形条 */}
        <div className="flex items-center gap-0.5 flex-1 h-5 overflow-hidden">
          {Array.from({ length: 12 }).map((_, i) => (
            <div
              key={i}
              className={`w-0.5 rounded-full transition-all ${
                isPlaying
                  ? 'bg-foreground animate-voice-wave'
                  : 'bg-foreground/50'
              }`}
              style={{
                height: isPlaying ? undefined : `${4 + Math.random() * 12}px`,
                animationDelay: isPlaying ? `${i * 0.1}s` : undefined,
              }}
            />
          ))}
        </div>

        {/* 右侧: 时长 */}
        <span className="text-xs font-mono tabular-nums shrink-0 text-foreground/90">
          {formatDuration(duration)}
        </span>
      </div>

      {/* 状态标签 */}
      {status === 'uploading' && (
        <span className="text-xs text-muted-foreground">上传中...</span>
      )}
      {status === 'transcribing' && (
        <span className="text-xs text-muted-foreground">识别中...</span>
      )}
      {status === 'failed' && (
        <span className="text-xs text-destructive">发送失败</span>
      )}

      {/* 转写文字 (可折叠) */}
      {transcribedText && status === 'sent' && (
        <button
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => setShowText(prev => !prev)}
        >
          {showText ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
          {showText ? '收起' : '转写文字'}
        </button>
      )}
      {showText && transcribedText && (
        <div className="text-xs text-muted-foreground bg-muted/50 rounded-lg px-3 py-1.5 max-w-[70%]">
          {transcribedText}
        </div>
      )}

      {/* 时间戳 */}
      {timestamp && (
        <span className="text-[10px] text-muted-foreground/60 mt-0.5">
          {new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      )}
    </div>
  );
}

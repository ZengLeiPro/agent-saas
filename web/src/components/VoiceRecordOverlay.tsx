/**
 * 录音中全屏遮罩组件
 *
 * 极简样式：仅显示波形动画 + 时长。
 */

interface VoiceRecordOverlayProps {
  isRecording: boolean;
  isCancelled: boolean;
  duration: number;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function VoiceRecordOverlay({ isRecording, isCancelled, duration }: VoiceRecordOverlayProps) {
  if (!isRecording) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center pb-40 bg-black/20">
      <div className={`flex items-center gap-3 rounded-full px-5 py-2.5 transition-colors ${
        isCancelled ? 'bg-destructive/90' : 'bg-accent/95'
      }`}>
        {/* 波形动画 */}
        <div className="flex items-center gap-0.5 h-4">
          {[0, 1, 2, 3, 4].map(i => (
            <div
              key={i}
              className={`w-0.5 rounded-full ${
                isCancelled ? 'bg-white/70' : 'bg-primary animate-voice-wave'
              }`}
              style={{
                animationDelay: isCancelled ? undefined : `${i * 0.12}s`,
                height: isCancelled ? '3px' : '3px',
              }}
            />
          ))}
        </div>

        {/* 时长 */}
        <span className={`text-sm font-mono tabular-nums ${
          isCancelled ? 'text-white/90' : 'text-foreground'
        }`}>
          {formatDuration(duration)}
        </span>
      </div>
    </div>
  );
}

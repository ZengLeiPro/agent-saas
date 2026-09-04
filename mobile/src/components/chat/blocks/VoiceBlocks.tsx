/** 语音块：助手侧语音标记提示（voice）与用户侧语音气泡（user-voice）。 */
import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { Mic, Pause, Play, Volume2 } from 'lucide-react-native';
import type { MessageItem } from '@agent/shared';
import { useVoicePlayer } from '../../../hooks/useVoicePlayer';
import { useColors, useChatTypography } from '../../../theme';
import { useMessageStyles } from './shared';

// --- Voice Block ---
export function VoiceBlock({ message }: { message: MessageItem & { type: 'voice' } }) {
  const colors = useColors();
  const typo = useChatTypography();
  const styles = useMessageStyles(colors, typo);

  return (
    <View style={[styles.voiceBlock, { flexDirection: 'row', alignItems: 'center', gap: 6 }]}>
      <Volume2 size={14} color={colors.mutedForeground} strokeWidth={2} />
      <Text style={styles.voiceText}>语音消息 ({message.voiceMarkers.length} 段)</Text>
    </View>
  );
}

// --- User Voice Block ---
export function UserVoiceBlock({ message }: { message: MessageItem & { type: 'user-voice' } }) {
  const colors = useColors();
  const typo = useChatTypography();
  const styles = useMessageStyles(colors, typo);
  const player = useVoicePlayer();
  const playState = player.getState(message.id);
  const playable =
    !!message.attachmentId && (message.status === 'ready' || message.status === 'sent');
  const fallbackText =
    message.status === 'uploading'
      ? '上传中…'
      : message.status === 'transcribing'
        ? '转写中…'
        : message.status === 'ready'
          ? '转写已就绪，请编辑后发送'
          : message.status === 'failed'
            ? message.failedReason || '语音处理失败'
            : '已发送';
  const displayText = message.transcribedText || fallbackText;
  const durationLabel = `${Math.max(0, Math.round(message.duration))} 秒`;

  return (
    <View
      style={styles.userBubbleContainer}
      accessible
      accessibilityRole="summary"
      accessibilityLabel={`语音 ${durationLabel}，${fallbackText}`}
    >
      <View style={[styles.userBubble, message.status === 'failed' && styles.failedBubble]}>
        <Pressable
          style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 4 }}
          disabled={!playable}
          accessibilityRole={playable ? 'button' : undefined}
          accessibilityLabel={playable ? `播放语音，${durationLabel}` : undefined}
          onPress={() => {
            if (!message.attachmentId) return;
            if (playState === 'idle') player.play(message.id, message.attachmentId);
            else player.togglePause(message.id);
          }}
        >
          {playable ? (
            playState === 'playing' ? (
              <Pause size={14} color={colors.foreground} />
            ) : (
              <Play size={14} color={colors.foreground} />
            )
          ) : (
            <Mic size={14} color={colors.foreground} />
          )}
          <Text style={[styles.userText, { flexShrink: 1 }]}>
            {durationLabel} · {displayText}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

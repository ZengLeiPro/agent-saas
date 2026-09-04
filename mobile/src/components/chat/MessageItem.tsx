/**
 * 消息渲染入口：只负责 props 类型、按 `type` 分发到 chat/blocks 下的块组件、以及 memo 包装。
 * 每个消息块的实现见 ./blocks/*。
 */
import React, { useEffect, useRef } from 'react';
import { Animated } from 'react-native';
import type {
  AskUserAnswers,
  MessageItem,
  RawPresentationGate,
  RenderItem,
} from '@agent/shared';
import { MessageErrorBoundary } from '../ErrorBoundary';
import { ActivityGroupView } from './blocks/ActivityGroupBlock';
import { AskUserBlock } from './blocks/AskUserBlock';
import { BusinessStepCard } from './blocks/BusinessStepBlock';
import { FileDownloadCard } from './blocks/FileDownloadCard';
import { PermissionBlock } from './blocks/PermissionBlock';
import { SubagentBlock } from './blocks/SubagentBlock';
import { ModerationMessage, SystemTimelineMessage } from './blocks/SystemBlocks';
import { TextMessage } from './blocks/TextBlock';
import { ThinkingBlock } from './blocks/ThinkingBlock';
import { ToolResultBlock, ToolUseBlock } from './blocks/ToolBlock';
import { UserMessage } from './blocks/UserMessage';
import { UserVoiceBlock, VoiceBlock } from './blocks/VoiceBlocks';

// app/chat/[sessionId].tsx 直接消费这两个交互块，继续从本模块导出以保持调用方零改动。
export { AskUserBlock, PermissionBlock };

interface MessageItemViewProps {
  item: RenderItem;
  isLast?: boolean;
  skipAnimation?: boolean;
  onPermissionResponse?: (interactionId: string, allow: boolean) => Promise<void>;
  onAskUserResponse?: (interactionId: string, answers: AskUserAnswers) => Promise<void>;
  onRetryMessage?: (message: MessageItem) => void;
  onForkMessage?: (message: MessageItem) => void;
  isFirstUser?: boolean;
  isLoading?: boolean;
  onPreviewMd?: (filePath: string) => void;
  onTtsPlay?: (key: string, text: string) => void;
  presentationGate?: RawPresentationGate;
}

export const MessageItemView = React.memo(function MessageItemView({
  item,
  isLast,
  skipAnimation,
  onPermissionResponse,
  onAskUserResponse,
  onRetryMessage,
  onForkMessage,
  isFirstUser,
  isLoading,
  onPreviewMd,
  onTtsPlay,
  presentationGate,
}: MessageItemViewProps) {
  // Skip fade animation for initial batch to avoid blocking JS thread
  const fadeAnim = useRef(new Animated.Value(skipAnimation ? 1 : 0)).current;
  useEffect(() => {
    if (skipAnimation) return;
    const anim = Animated.timing(fadeAnim, { toValue: 1, duration: 200, useNativeDriver: true });
    anim.start();
    return () => anim.stop();
  }, []);

  let content: React.ReactNode;

  if (item.type === 'activity_group') {
    content = <ActivityGroupView group={item} isLast={isLast} gate={presentationGate} onRetry={onRetryMessage} />;
  } else {
    switch (item.type) {
      case 'user':
        content = <UserMessage message={item} onRetry={onRetryMessage} onFork={onForkMessage} isFirstUser={isFirstUser} isLoading={isLoading} />;
        break;
      case 'text':
        content = item.moderation && item.moderation.outcome !== 'allowed'
          ? <ModerationMessage message={item} />
          : <TextMessage message={item} onPreviewMd={onPreviewMd} onTtsPlay={onTtsPlay} />;
        break;
      case 'thinking':
        content = <ThinkingBlock message={item} />;
        break;
      case 'tool_use':
        content = <ToolUseBlock message={item} gate={presentationGate} onRecovery={onRetryMessage ? () => onRetryMessage(item) : undefined} />;
        break;
      case 'tool_result':
        content = <ToolResultBlock message={item} gate={presentationGate} />;
        break;
      case 'permission_request':
        content = <PermissionBlock message={item} onResponse={onPermissionResponse} />;
        break;
      case 'ask_user':
        content = <AskUserBlock message={item} onResponse={onAskUserResponse} />;
        break;
      case 'subagent':
        content = <SubagentBlock message={item} />;
        break;
      case 'file_download':
        content = <FileDownloadCard message={item} onPreviewMd={onPreviewMd} />;
        break;
      case 'voice':
        content = <VoiceBlock message={item} />;
        break;
      case 'user-voice':
        content = <UserVoiceBlock message={item} />;
        break;
      case 'business_step':
        content = <BusinessStepCard event={item} gate={presentationGate} />;
        break;
      case 'runtime_status':
      case 'system_event':
      case 'system-error':
        content = <SystemTimelineMessage message={item} gate={presentationGate} onRetry={onRetryMessage} />;
        break;
      default:
        content = null;
    }
  }

  return (
    <MessageErrorBoundary>
      <Animated.View style={{ opacity: fadeAnim }}>
        {content}
      </Animated.View>
    </MessageErrorBoundary>
  );
});

/** 用户消息气泡：文本 / 语音转写标记 / 附件 chip、长按菜单与重试态。 */
import React, { useState, useMemo, useCallback } from 'react';
import { View, Text, TouchableOpacity, Pressable, Share } from 'react-native';
import { Image as ImageIcon, Mic, Paperclip } from 'lucide-react-native';
import * as Clipboard from 'expo-clipboard';
import type { MessageItem } from '@agent/shared';
import { formatFileSize } from '@agent/shared';
import { DropdownMenu, type DropdownSection } from '../../overlays/DropdownMenu';
import { fileCacheService } from '../../../services/fileCacheService';
import { useColors, useChatTypography, fontScale } from '../../../theme';
import { hapticLight } from '../../../lib/haptics';
import { ImageLightbox } from '../ImageLightbox';
import { useMessageStyles } from './shared';

// --- User Message ---
export function UserMessage({
  message,
  onRetry,
  onFork,
  isFirstUser,
  isLoading,
}: {
  message: MessageItem & { type: 'user' };
  onRetry?: (message: MessageItem) => void;
  onFork?: (message: MessageItem) => void;
  isFirstUser?: boolean;
  isLoading?: boolean;
}) {
  const colors = useColors();
  const typo = useChatTypography();
  const styles = useMessageStyles(colors, typo);

  const showFork = !!onFork && !isFirstUser && !isLoading && message.id.startsWith('line-');

  const [menuVisible, setMenuVisible] = useState(false);
  const [anchorTop, setAnchorTop] = useState(0);
  const [attachmentPreviewUri, setAttachmentPreviewUri] = useState<string | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);

  const openAttachment = useCallback(
    async (attachment: NonNullable<typeof message.attachments>[number]) => {
      if (!attachment.attachmentId) return;
      setAttachmentError(null);
      try {
        const uri = await fileCacheService.getOrDownloadAttachment(
          attachment.attachmentId,
          attachment.name,
        );
        if (attachment.isImage) setAttachmentPreviewUri(uri);
        else await Share.share({ url: uri, title: attachment.name });
      } catch {
        setAttachmentError('附件已过期、删除或无权访问');
      }
    },
    [message.attachments],
  );

  const sections = useMemo<DropdownSection[]>(
    () => [
      {
        id: 's1',
        actions: [
          { id: 'copy', label: '复制' },
          { id: 'share', label: '分享' },
          ...(showFork ? [{ id: 'fork', label: '从此编辑' }] : []),
        ],
      },
    ],
    [showFork],
  );

  const handleAction = useCallback(
    (actionId: string) => {
      switch (actionId) {
        case 'copy':
          void Clipboard.setStringAsync(message.content);
          break;
        case 'share':
          void Share.share({ message: message.content });
          break;
        case 'fork':
          onFork?.(message);
          break;
      }
    },
    [message.content, onFork, message],
  );

  const handleLongPress = useCallback((e: import('react-native').GestureResponderEvent) => {
    hapticLight();
    setAnchorTop(e.nativeEvent.pageY);
    setMenuVisible(true);
  }, []);

  const messageText = message.displayContent ?? message.content;
  const displayText = messageText;

  return (
    <View style={styles.userBubbleContainer}>
      <Pressable onLongPress={handleLongPress} style={styles.userMenuWrapper}>
        <View style={[styles.userBubble, message.status === 'failed' && styles.failedBubble]}>
          {displayText ? (
            message.isVoiceTranscript ? (
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 4 }}>
                <Mic size={14} color={colors.foreground} strokeWidth={2} style={{ marginTop: 3 }} />
                <Text style={[styles.userText, { flexShrink: 1 }]}>{displayText}</Text>
              </View>
            ) : (
              <Text style={styles.userText}>{displayText}</Text>
            )
          ) : null}
          {message.attachments && message.attachments.length > 0 && (
            <View style={[styles.attachmentChips, displayText ? { marginTop: 6 } : undefined]}>
              {message.attachments.map((att, i) => (
                <Pressable
                  key={att.attachmentId ?? i}
                  style={styles.attachmentChip}
                  onPress={att.attachmentId ? () => void openAttachment(att) : undefined}
                  accessibilityRole={att.attachmentId ? 'button' : 'text'}
                  accessibilityLabel={`${att.isImage ? '查看图片' : '下载附件'}：${att.name}${att.size !== undefined ? `，${formatFileSize(att.size)}` : ''}`}
                >
                  {att.isImage ? (
                    <ImageIcon size={12} color={colors.mutedForeground} strokeWidth={2} />
                  ) : (
                    <Paperclip size={12} color={colors.mutedForeground} strokeWidth={2} />
                  )}
                  <View style={{ maxWidth: 180 }}>
                    <Text style={styles.attachmentChipText} numberOfLines={1}>
                      {att.name}
                    </Text>
                    {(att.mimeType || att.size !== undefined) && (
                      <Text
                        style={[
                          styles.attachmentChipText,
                          fontScale.xs2 /* token: 近似 fontSize 10 */,
                        ]}
                        numberOfLines={1}
                      >
                        {[
                          att.mimeType?.split('/').at(-1),
                          att.size !== undefined ? formatFileSize(att.size) : undefined,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </Text>
                    )}
                  </View>
                </Pressable>
              ))}
            </View>
          )}
        </View>
      </Pressable>
      <DropdownMenu
        visible={menuVisible}
        onClose={() => setMenuVisible(false)}
        sections={sections}
        onSelect={handleAction}
        anchorTop={anchorTop}
        align="right"
      />
      {message.status === 'failed' && onRetry && (
        <TouchableOpacity onPress={() => onRetry(message)} style={styles.retryButton}>
          <Text style={styles.retryText}>重试</Text>
        </TouchableOpacity>
      )}
      {message.status === 'pending' && <Text style={styles.pendingText}>发送中...</Text>}
      {attachmentError && (
        <Text accessibilityRole="alert" style={styles.retryText}>
          {attachmentError}
        </Text>
      )}
      {attachmentPreviewUri && (
        <ImageLightbox
          visible
          uri={attachmentPreviewUri}
          onClose={() => setAttachmentPreviewUri(null)}
        />
      )}
    </View>
  );
}

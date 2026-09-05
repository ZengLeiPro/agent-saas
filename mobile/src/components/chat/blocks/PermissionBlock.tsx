/** 权限请求块：工具名 + 入参 Markdown + 允许/拒绝按钮。 */
import React, { useMemo } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import Markdown from 'react-native-markdown-display';
import type { MessageItem } from '@agent/shared';
import { cjkMarkdownIt } from '../../../lib/markdownIt';
import { useColors, useChatTypography } from '../../../theme';
import { createMarkdownStyles } from '../markdownStyles';
import { useMessageStyles } from './shared';

// --- Permission Block ---
export function PermissionBlock({
  message,
  onResponse,
  disabled = false,
}: {
  message: MessageItem & { type: 'permission_request' };
  onResponse?: (interactionId: string, allow: boolean) => Promise<void>;
  disabled?: boolean;
}) {
  const colors = useColors();
  const typo = useChatTypography();
  const styles = useMessageStyles(colors, typo);
  const mdStyles = useMemo(() => createMarkdownStyles(colors, typo), [colors, typo]);

  return (
    <View style={styles.permissionBlock}>
      <Text style={styles.permissionTitle}>{message.toolName}</Text>
      <Markdown markdownit={cjkMarkdownIt} style={mdStyles}>
        {message.toolInput}
      </Markdown>
      {message.status === 'pending' && (
        <View style={styles.permissionButtons}>
          <TouchableOpacity
            testID="permission-deny-button"
            style={[styles.permButton, styles.denyButton]}
            accessibilityRole="button"
            accessibilityLabel={`拒绝权限请求 ${message.toolName}`}
            disabled={disabled || !onResponse}
            accessibilityState={{ disabled: disabled || !onResponse }}
            onPress={() => onResponse?.(message.interactionId, false)}
          >
            <Text style={styles.denyText}>拒绝</Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID="permission-allow-button"
            style={[styles.permButton, styles.allowButton]}
            accessibilityRole="button"
            accessibilityLabel={`允许权限请求 ${message.toolName}`}
            disabled={disabled || !onResponse}
            accessibilityState={{ disabled: disabled || !onResponse }}
            onPress={() => onResponse?.(message.interactionId, true)}
          >
            <Text style={styles.allowText}>允许</Text>
          </TouchableOpacity>
        </View>
      )}
      {message.status !== 'pending' && (
        <Text
          style={[
            styles.statusBadge,
            message.status === 'allowed' ? styles.allowedBadge : styles.deniedBadge,
          ]}
        >
          {message.status === 'allowed' ? '已允许' : '已拒绝'}
        </Text>
      )}
    </View>
  );
}

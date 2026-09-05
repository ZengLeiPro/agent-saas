/** 思考块：折叠标题行 + 展开后的原始思考文本。 */
import React, { useState } from 'react';
import { View, Text, Pressable, ScrollView } from 'react-native';
import { ChevronRight, Lightbulb } from 'lucide-react-native';
import type { MessageItem } from '@agent/shared';
import { useColors, useChatTypography } from '../../../theme';
import { useMessageStyles } from './shared';

// --- Thinking Block ---
export function ThinkingBlock({ message }: { message: MessageItem & { type: 'thinking' } }) {
  const colors = useColors();
  const typo = useChatTypography();
  const styles = useMessageStyles(colors, typo);
  const [expanded, setExpanded] = useState(false);
  if (!message.content && !message.streaming) return null;

  return (
    <View>
      <Pressable
        onPress={() => setExpanded(!expanded)}
        style={styles.toolRow}
        accessibilityRole="button"
        accessibilityLabel="展开或折叠详情"
        accessibilityState={{ expanded }}
      >
        <Lightbulb size={16} color={colors.mutedForeground} strokeWidth={2} />
        <Text style={styles.toolLabel}>{message.streaming ? '思考中...' : '已思考'}</Text>
        <ChevronRight
          size={16}
          color={colors.mutedForeground}
          strokeWidth={2}
          style={expanded ? { transform: [{ rotate: '90deg' }] } : undefined}
        />
      </Pressable>
      {expanded && (
        <ScrollView style={styles.codePreviewScrollable} nestedScrollEnabled>
          <Text style={styles.codePreviewText}>{message.content}</Text>
        </ScrollView>
      )}
    </View>
  );
}

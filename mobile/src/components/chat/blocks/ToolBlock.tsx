/** 工具块：tool_use（canonical 摘要 + 授权后的原始 payload）与独立 tool_result。 */
import React, { useState, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  Image,
  ScrollView,
} from 'react-native';
import { ChevronRight, CircleAlert, CircleCheck, CircleSlash2 } from 'lucide-react-native';
import type { MessageItem, RawPresentationGate } from '@agent/shared';
import {
  formatJson,
  parseToolResult,
  selectRenderModel,
  selectToolPresentation,
} from '@agent/shared';
import { useColors, spacing, typography, fontScale, useChatTypography } from '../../../theme';
import { ImageLightbox } from '../ImageLightbox';
import { CanonicalPresentationBody } from './PresentationBlock';
import { useMessageStyles } from './shared';

// --- Tool Use Block (canonical summary + debug-authorized raw payload) ---
export function ToolUseBlock({
  message,
  gate,
  onRecovery,
}: {
  message: MessageItem & { type: 'tool_use' };
  gate?: RawPresentationGate;
  onRecovery?: () => void;
}) {
  const colors = useColors();
  const typo = useChatTypography();
  const styles = useMessageStyles(colors, typo);
  const [expanded, setExpanded] = useState(false);
  const [lightboxUri, setLightboxUri] = useState<string | null>(null);

  const hasResult = message.resultReady === true;
  const item = useMemo(() => selectRenderModel({ messages: [message] }).items[0], [message]);
  const canonical = useMemo(() => selectToolPresentation(item, gate), [gate, item]);
  const hasIssue = canonical.status === 'failed';
  const isCancelled = canonical.status === 'cancelled';

  // 延迟解析结果中的图片
  const parsed = useMemo(
    () =>
      expanded && hasResult && canonical.showRaw ? parseToolResult(message.result || '') : null,
    [canonical.showRaw, expanded, hasResult, message.result],
  );
  const hasImages = parsed !== null && parsed.images.length > 0;

  const icon = canonical.busy ? (
    <ActivityIndicator size={16} color={colors.primary} />
  ) : hasIssue ? (
    <CircleAlert size={16} color={colors.warning} strokeWidth={2} />
  ) : isCancelled ? (
    <CircleSlash2 size={16} color={colors.mutedForeground} strokeWidth={2} />
  ) : (
    <CircleCheck size={16} color={colors.mutedForeground} strokeWidth={2} />
  );

  return (
    <View>
      <Pressable
        onPress={() => setExpanded(!expanded)}
        style={[styles.toolRow, { minHeight: 44 }]}
        accessibilityRole="button"
        accessibilityLabel={[
          canonical.title,
          canonical.statusLabel,
          canonical.summary,
          expanded ? '收起详情' : '展开详情',
        ]
          .filter(Boolean)
          .join('，')}
        accessibilityState={{ expanded, busy: canonical.busy }}
      >
        <View accessible={false}>{icon}</View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.toolLabel} numberOfLines={1}>
            {canonical.title}
            {canonical.busy ? '...' : ''}
          </Text>
          {canonical.summary ? (
            <Text
              style={{ ...typography.caption, color: colors.mutedForeground }}
              numberOfLines={1}
            >
              {canonical.summary}
            </Text>
          ) : null}
        </View>
        <Text
          style={{
            color: hasIssue ? colors.warning : colors.mutedForeground,
            ...fontScale.xs2 /* token: 近似 fontSize 11 */,
          }}
        >
          {canonical.statusLabel}
        </Text>
        <View accessible={false}>
          <ChevronRight
            size={16}
            color={colors.mutedForeground}
            strokeWidth={2}
            style={expanded ? { transform: [{ rotate: '90deg' }] } : undefined}
          />
        </View>
      </Pressable>
      {canonical.recoveryAction && onRecovery ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${canonical.title}，${canonical.recoveryAction.label}`}
          onPress={onRecovery}
          style={{
            minHeight: 44,
            justifyContent: 'center',
            alignSelf: 'flex-start',
            paddingHorizontal: spacing.sm,
          }}
        >
          <Text style={{ ...typography.bodySmall, fontWeight: '600', color: colors.foreground }}>
            {canonical.recoveryAction.label}
          </Text>
        </Pressable>
      ) : null}
      {expanded && (
        <View>
          <CanonicalPresentationBody presentation={canonical} />
          {canonical.showRaw ? (
            <ScrollView style={styles.codePreviewScrollable} nestedScrollEnabled>
              <Text style={styles.codePreviewText}>{formatJson(message.toolInput)}</Text>
              {hasResult && !hasImages && (
                <>
                  <View
                    style={{
                      borderTopWidth: StyleSheet.hairlineWidth,
                      borderTopColor: colors.border,
                      marginTop: 8,
                      paddingTop: 8,
                    }}
                  >
                    <Text
                      style={{
                        ...styles.codePreviewText,
                        padding: 0,
                        paddingHorizontal: 12,
                        marginBottom: 4,
                      }}
                    >
                      Result:
                    </Text>
                    <Text style={styles.codePreviewText}>{message.result}</Text>
                  </View>
                </>
              )}
            </ScrollView>
          ) : null}
          {canonical.showRaw && hasResult && hasImages && (
            <>
              <Text
                style={{
                  ...typo.caption,
                  fontWeight: '600',
                  color: colors.mutedForeground,
                  marginVertical: 6,
                }}
              >
                Result:
              </Text>
              <View style={styles.imageGrid}>
                {parsed.images.map((img, i) => {
                  const uri = `data:${img.mimeType};base64,${img.data}`;
                  return (
                    <Pressable key={i} onPress={() => setLightboxUri(uri)}>
                      <Image source={{ uri }} style={styles.thumbnailImage} resizeMode="contain" />
                    </Pressable>
                  );
                })}
              </View>
              {parsed.text ? (
                <ScrollView style={styles.codePreviewScrollable} nestedScrollEnabled>
                  <Text style={styles.codePreviewText}>{parsed.text}</Text>
                </ScrollView>
              ) : null}
              {lightboxUri && (
                <ImageLightbox visible uri={lightboxUri} onClose={() => setLightboxUri(null)} />
              )}
            </>
          )}
        </View>
      )}
    </View>
  );
}

// --- Tool Result Block ---
export function ToolResultBlock({
  message,
  gate,
}: {
  message: MessageItem & { type: 'tool_result' };
  gate?: RawPresentationGate;
}) {
  const colors = useColors();
  const typo = useChatTypography();
  const styles = useMessageStyles(colors, typo);
  const [expanded, setExpanded] = useState(false);
  const [lightboxUri, setLightboxUri] = useState<string | null>(null);
  const renderItem = useMemo(() => selectRenderModel({ messages: [message] }).items[0], [message]);
  const canonical = useMemo(() => selectToolPresentation(renderItem, gate), [renderItem, gate]);

  // raw payload 只有在会话调试权限明确授权后才解析和挂到 RN 树上。
  const parsed = useMemo(
    () => (expanded && canonical.showRaw ? parseToolResult(message.result) : null),
    [canonical.showRaw, expanded, message.result],
  );
  const hasImages = parsed !== null && parsed.images.length > 0;

  return (
    <View>
      <Pressable
        onPress={canonical.showRaw ? () => setExpanded(!expanded) : undefined}
        disabled={!canonical.showRaw}
        style={styles.toolRow}
        accessibilityRole="button"
        accessibilityLabel={canonical.showRaw ? '展开或折叠调试详情' : canonical.title}
        accessibilityState={{
          disabled: !canonical.showRaw,
          expanded: canonical.showRaw ? expanded : undefined,
        }}
      >
        <CircleCheck size={16} color={colors.mutedForeground} strokeWidth={2} />
        <Text style={styles.toolLabel} numberOfLines={1}>
          {canonical.title}
        </Text>
        {canonical.showRaw ? (
          <ChevronRight
            size={16}
            color={colors.mutedForeground}
            strokeWidth={2}
            style={expanded ? { transform: [{ rotate: '90deg' }] } : undefined}
          />
        ) : null}
      </Pressable>
      <CanonicalPresentationBody presentation={canonical} />
      {expanded && canonical.showRaw && hasImages && parsed ? (
        <>
          <View style={styles.imageGrid}>
            {parsed.images.map((img, i) => {
              const uri = `data:${img.mimeType};base64,${img.data}`;
              return (
                <Pressable key={i} onPress={() => setLightboxUri(uri)}>
                  <Image source={{ uri }} style={styles.thumbnailImage} resizeMode="contain" />
                </Pressable>
              );
            })}
          </View>
          {parsed.text ? (
            <ScrollView style={styles.codePreviewScrollable} nestedScrollEnabled>
              <Text style={styles.codePreviewText}>{parsed.text}</Text>
            </ScrollView>
          ) : null}
          {lightboxUri ? (
            <ImageLightbox visible uri={lightboxUri} onClose={() => setLightboxUri(null)} />
          ) : null}
        </>
      ) : null}
      {expanded && canonical.showRaw && parsed && !hasImages ? (
        <ScrollView style={styles.codePreviewScrollable} nestedScrollEnabled>
          <Text style={styles.codePreviewText}>{parsed.text}</Text>
        </ScrollView>
      ) : null}
    </View>
  );
}

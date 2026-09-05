/**
 * 工具块：tool_use（canonical 摘要 + 授权后的原始 payload）与独立 tool_result。
 *
 * 两层摘要，与 `web/src/components/ToolBlock.tsx` 对齐：
 * 第一层折叠行 = 工具标题 + 一句人话摘要 + 状态徽标（含耗时）+ 回执；
 * 第二层展开区 = 结构化 detail / 回执，再往下才是**授权后**的原始 payload。
 *
 * 原始 input/result 的可见性只由 `canonical.showRaw`（RawPresentationGate）决定，
 * 本文件不提供任何旁路；非 debug 用户展开也只看到业务摘要。
 */
import React, { useState, useMemo } from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator, Image, ScrollView } from 'react-native';
import { ChevronRight, CircleAlert, CircleCheck, CircleSlash2 } from 'lucide-react-native';
import type { MessageItem, RawPresentationGate, ParsedToolResult } from '@agent/shared';
import {
  formatActivityDuration,
  formatJson,
  normalizeToolPresentation,
  parseToolResult,
  selectRenderModel,
  selectToolPresentation,
  toolResultExitCode,
} from '@agent/shared';
import { useColors, spacing, fontWeight, useChatTypography } from '../../../theme';
import { Badge } from '../../ui';
import { ImageLightbox } from '../ImageLightbox';
import { CanonicalPresentationBody } from './PresentationBlock';
import { useMessageStyles, type MessageStyles } from './shared';
import { toneBadgeVariant } from './tone';

type ToolStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'succeeded';

/**
 * 原始结果正文（图片 + 文本）。tool_use 与 tool_result 两处此前各写了一份，
 * 合并为一个组件——重复的渲染分支迟早会长成两种行为。
 */
function ResultContent({
  parsed,
  styles,
  label,
}: {
  parsed: ParsedToolResult;
  styles: MessageStyles;
  label?: string;
}) {
  const colors = useColors();
  const typo = useChatTypography();
  const [lightboxUri, setLightboxUri] = useState<string | null>(null);
  const hasImages = parsed.images.length > 0;

  return (
    <View>
      {label ? (
        <Text
          style={[
            typo.caption,
            { color: colors.mutedForeground, fontWeight: fontWeight.semibold, marginTop: spacing.xs },
          ]}
        >
          {label}
        </Text>
      ) : null}
      {hasImages ? (
        <View style={styles.imageGrid}>
          {parsed.images.map((img, index) => {
            const uri = `data:${img.mimeType};base64,${img.data}`;
            return (
              <Pressable key={index} onPress={() => setLightboxUri(uri)}>
                <Image source={{ uri }} style={styles.thumbnailImage} resizeMode="contain" />
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {parsed.text ? (
        <ScrollView style={styles.codePreviewScrollable} nestedScrollEnabled>
          <Text style={styles.codePreviewText}>{parsed.text}</Text>
        </ScrollView>
      ) : null}
      {lightboxUri ? (
        <ImageLightbox visible uri={lightboxUri} onClose={() => setLightboxUri(null)} />
      ) : null}
    </View>
  );
}

/**
 * 用结构化事实校正技术终态：`metadata.exitCode` 是进程原值，
 * 平台合成的 executionStatus 是转译过的判定链，两者冲突时以原值为准。
 * 只做单向校正（非零退出码 → 有异常），不反向把已判失败的降级成成功。
 */
function resolveExecutionStatus(status: ToolStatus, exitCode?: number): ToolStatus {
  if (status === 'pending' || status === 'running' || status === 'cancelled') return status;
  if (exitCode !== undefined && exitCode !== 0) return 'failed';
  return status;
}

function statusTone(status: ToolStatus, busy: boolean) {
  if (busy || status === 'running') return 'active' as const;
  if (status === 'failed') return 'warning' as const;
  if (status === 'cancelled') return 'neutral' as const;
  if (status === 'completed' || status === 'succeeded') return 'success' as const;
  return 'pending' as const;
}

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
  // 剧本标记 defaultOpen 的高价值执行块（且带摘要）首次挂载即展开；原始 payload 不因它上主流。
  const [expanded, setExpanded] = useState(
    message.defaultExpanded === true && !!message.presentation,
  );

  const hasResult = message.resultReady === true;
  const item = useMemo(() => selectRenderModel({ messages: [message] }).items[0], [message]);
  const canonical = useMemo(() => selectToolPresentation(item, gate), [gate, item]);
  const exitCode = useMemo(() => toolResultExitCode(message.toolMetadata), [message.toolMetadata]);
  const status = resolveExecutionStatus(canonical.status as ToolStatus, exitCode);
  const hasIssue = status === 'failed';
  const tone = statusTone(status, canonical.busy);
  const metadataDuration = message.toolMetadata?.durationMs;
  const duration = formatActivityDuration(
    message.durationMs ?? (typeof metadataDuration === 'number' ? metadataDuration : undefined),
  );

  const normalized = useMemo(
    () => normalizeToolPresentation(message.presentation),
    [message.presentation],
  );
  const title = normalized?.connector ? `连接器 · ${canonical.title}` : canonical.title;

  // 原始 payload 只有在会话调试权限明确授权后才解析并挂到 RN 树上。
  const parsed = useMemo(
    () => (expanded && hasResult && canonical.showRaw ? parseToolResult(message.result || '') : null),
    [canonical.showRaw, expanded, hasResult, message.result],
  );

  const statusLabel = [
    hasIssue ? '有异常' : canonical.statusLabel,
    duration && (status === 'completed' || status === 'failed' || status === 'cancelled')
      ? duration
      : null,
    hasIssue && exitCode !== undefined ? `退出码 ${exitCode}` : null,
  ]
    .filter(Boolean)
    .join(' ');

  const icon = canonical.busy ? (
    <ActivityIndicator size={16} color={colors.infoFamily.DEFAULT} />
  ) : hasIssue ? (
    <CircleAlert size={16} color={colors.warningFamily.DEFAULT} strokeWidth={2} />
  ) : status === 'cancelled' ? (
    <CircleSlash2 size={16} color={colors.mutedForeground} strokeWidth={2} />
  ) : (
    <CircleCheck size={16} color={colors.mutedForeground} strokeWidth={2} />
  );

  return (
    <View>
      <Pressable
        onPress={() => setExpanded(!expanded)}
        style={[styles.toolRow, blockStyles.tappable]}
        accessibilityRole="button"
        accessibilityLabel={[
          title,
          canonical.statusLabel,
          canonical.summary,
          expanded ? '收起详情' : '展开详情',
        ]
          .filter(Boolean)
          .join('，')}
        accessibilityState={{ expanded, busy: canonical.busy }}
      >
        <View accessible={false}>{icon}</View>
        <View style={blockStyles.titleArea}>
          <Text style={styles.toolLabel} numberOfLines={1}>
            {title}
            {canonical.busy ? '...' : ''}
          </Text>
          {canonical.summary ? (
            <Text style={[typo.caption, { color: colors.mutedForeground }]} numberOfLines={1}>
              {canonical.summary}
            </Text>
          ) : null}
        </View>
        <Badge size="sm" variant={toneBadgeVariant(tone)} label={statusLabel} />
        <View accessible={false}>
          <ChevronRight
            size={16}
            color={colors.mutedForeground}
            strokeWidth={2}
            style={expanded ? blockStyles.rotated : undefined}
          />
        </View>
      </Pressable>
      {canonical.receipt ? (
        <Text style={[typo.caption, blockStyles.receipt, { color: colors.mutedForeground }]}>
          {`→ ${canonical.receipt.system}${canonical.receipt.readBack ? ' · 回读校验通过' : ''}`}
        </Text>
      ) : null}
      {canonical.recoveryAction && onRecovery ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${title}，${canonical.recoveryAction.label}`}
          onPress={onRecovery}
          style={blockStyles.recovery}
        >
          <Text
            style={[typo.bodySmall, { color: colors.foreground, fontWeight: fontWeight.semibold }]}
          >
            {canonical.recoveryAction.label}
          </Text>
        </Pressable>
      ) : null}
      {expanded ? (
        <View>
          <CanonicalPresentationBody presentation={canonical} detailVariant="code" />
          {canonical.showRaw ? (
            <>
              <ScrollView style={styles.codePreviewScrollable} nestedScrollEnabled>
                <Text style={styles.codePreviewText}>{formatJson(message.toolInput)}</Text>
              </ScrollView>
              {parsed ? (
                <ResultContent
                  parsed={parsed}
                  styles={styles}
                  label={hasIssue ? 'Error:' : 'Result:'}
                />
              ) : null}
            </>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

// --- Tool Result Block（历史 transcript 里独立出现的 tool_result）---
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
  const renderItem = useMemo(() => selectRenderModel({ messages: [message] }).items[0], [message]);
  const canonical = useMemo(() => selectToolPresentation(renderItem, gate), [renderItem, gate]);
  const normalized = useMemo(
    () => normalizeToolPresentation(message.presentation),
    [message.presentation],
  );
  const title = normalized?.connector ? `连接器 · ${canonical.title}` : canonical.title;

  const parsed = useMemo(
    () => (expanded && canonical.showRaw ? parseToolResult(message.result) : null),
    [canonical.showRaw, expanded, message.result],
  );

  return (
    <View>
      <Pressable
        onPress={canonical.showRaw ? () => setExpanded(!expanded) : undefined}
        disabled={!canonical.showRaw}
        style={styles.toolRow}
        accessibilityRole="button"
        accessibilityLabel={canonical.showRaw ? '展开或折叠调试详情' : title}
        accessibilityState={{
          disabled: !canonical.showRaw,
          expanded: canonical.showRaw ? expanded : undefined,
        }}
      >
        <CircleCheck size={16} color={colors.mutedForeground} strokeWidth={2} />
        <Text style={styles.toolLabel} numberOfLines={1}>
          {title}
        </Text>
        {canonical.showRaw ? (
          <ChevronRight
            size={16}
            color={colors.mutedForeground}
            strokeWidth={2}
            style={expanded ? blockStyles.rotated : undefined}
          />
        ) : null}
      </Pressable>
      <CanonicalPresentationBody presentation={canonical} detailVariant="code" />
      {parsed ? <ResultContent parsed={parsed} styles={styles} /> : null}
    </View>
  );
}

const blockStyles = StyleSheet.create({
  tappable: { minHeight: 44 },
  titleArea: { flex: 1, minWidth: 0 },
  rotated: { transform: [{ rotate: '90deg' }] },
  recovery: {
    minHeight: 44,
    justifyContent: 'center',
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.sm,
  },
  receipt: { paddingHorizontal: spacing.sm },
});

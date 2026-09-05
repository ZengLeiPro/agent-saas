/**
 * Token 明细面板的展示零件：色调映射、堆叠彩条、类目树、折叠节与行样式。
 *
 * 从 TokenDetail.tsx 拆出以保持单文件在可读规模内。这里只有绑定与样式，
 * 判定逻辑（取值优先级 / 阈值预警 / 口径标签）一律在 shared tokenUsageView；
 * 分类色一律取主题 `colors.chart` 调色板，不消费服务端下发的十六进制色值。
 */
import React, { useMemo, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { ChevronDown } from 'lucide-react-native';
import {
  contextAccuracyLabel,
  formatTokenCount,
  tokenCategoryColor,
  type ContextUsageCategory,
  type MessageItem,
  type SubagentStatus,
  type TokenUsageTone,
} from '@agent/shared';
import { spacing, typography, radius, monoFamily, type ThemeColors } from '../../theme';

export function toneColor(tone: TokenUsageTone, colors: ThemeColors): string {
  if (tone === 'danger') return colors.dangerFamily.ink;
  if (tone === 'warning') return colors.warningFamily.ink;
  return colors.mutedForeground;
}

export function toneBarColor(tone: TokenUsageTone, colors: ThemeColors): string {
  if (tone === 'danger') return colors.danger;
  if (tone === 'warning') return colors.warning;
  return colors.primary;
}

export interface TokenSegment {
  key: string;
  name: string;
  tokens: number;
}

/** 上下文构成的横向堆叠彩条：按占比铺满，颜色按 chart 调色板轮转 */
export function StackedBar({
  segments,
  colors,
}: {
  segments: TokenSegment[];
  colors: ThemeColors;
}) {
  const shown = segments.filter((segment) => segment.tokens > 0);
  const total = shown.reduce((sum, segment) => sum + segment.tokens, 0);
  if (total <= 0) return null;
  return (
    <View style={[barStyles.track, { backgroundColor: colors.muted }]}>
      {shown.map((segment, index) => (
        <View
          key={segment.key}
          style={{
            flexGrow: segment.tokens / total,
            backgroundColor: tokenCategoryColor(index, colors.chart),
          }}
        />
      ))}
    </View>
  );
}

function CategoryRow({
  item,
  index,
  colors,
  styles,
}: {
  item: ContextUsageCategory;
  index: number;
  colors: ThemeColors;
  styles: ReturnType<typeof useStyles>;
}) {
  const [expanded, setExpanded] = useState(false);
  const children = item.children?.filter((child) => child.tokens > 0) ?? [];
  const hasChildren = children.length > 0;
  return (
    <View>
      <Pressable
        disabled={!hasChildren}
        onPress={() => setExpanded((value) => !value)}
        accessibilityRole={hasChildren ? 'button' : 'text'}
        accessibilityLabel={`${item.name} ${formatTokenCount(item.tokens)}`}
        style={rowStyles.row}
      >
        <View style={rowStyles.categoryLabel}>
          <View
            style={[rowStyles.swatch, { backgroundColor: tokenCategoryColor(index, colors.chart) }]}
          />
          <Text style={[rowStyles.label, { color: colors.mutedForeground }]} numberOfLines={1}>
            {item.name}
            {item.isDeferred ? ' (deferred)' : ''}
          </Text>
          {hasChildren ? (
            <ChevronDown
              size={12}
              color={colors.mutedForeground}
              strokeWidth={2}
              style={{ transform: [{ rotate: expanded ? '180deg' : '0deg' }] }}
            />
          ) : null}
          <Text style={[rowStyles.badge, { color: colors.mutedForeground }]}>
            {contextAccuracyLabel(item.accuracy)}
          </Text>
        </View>
        <Text style={[rowStyles.value, { color: colors.foreground }]}>
          {formatTokenCount(item.tokens)}
        </Text>
      </Pressable>
      {hasChildren && expanded ? (
        <View style={[styles.subTree, { borderLeftColor: colors.border }]}>
          <CategoryTree categories={children} colors={colors} styles={styles} />
        </View>
      ) : null}
    </View>
  );
}

export function CategoryTree({
  categories,
  colors,
  styles,
}: {
  categories: ContextUsageCategory[];
  colors: ThemeColors;
  styles: ReturnType<typeof useStyles>;
}) {
  return (
    <View>
      {categories
        .filter((item) => item.tokens > 0)
        .map((item, index) => (
          <CategoryRow key={item.key} item={item} index={index} colors={colors} styles={styles} />
        ))}
    </View>
  );
}

/** 记忆文件 / MCP 工具等次要清单的折叠节 */
export function CollapsibleSection({
  title,
  count,
  colors,
  styles,
  children,
}: {
  title: string;
  count: number;
  colors: ThemeColors;
  styles: ReturnType<typeof useStyles>;
  children: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View>
      <View style={styles.divider} />
      <Pressable
        onPress={() => setExpanded((value) => !value)}
        accessibilityRole="button"
        accessibilityLabel={`${title}（${count}）`}
        style={rowStyles.row}
      >
        <Text style={styles.sectionTitle}>
          {title}
          <Text style={styles.hint}>{`（${count}）`}</Text>
        </Text>
        <ChevronDown
          size={14}
          color={colors.mutedForeground}
          strokeWidth={2}
          style={{ transform: [{ rotate: expanded ? '180deg' : '0deg' }] }}
        />
      </Pressable>
      {expanded ? <View>{children}</View> : null}
    </View>
  );
}

export function TokenRow({
  label,
  value,
  colors,
}: {
  label: string;
  value: number;
  colors: ThemeColors;
}) {
  return <TextRow label={label} value={value.toLocaleString()} colors={colors} />;
}

export function TextRow({
  label,
  value,
  colors,
}: {
  label: string;
  value: string;
  colors: ThemeColors;
}) {
  return (
    <View style={rowStyles.row}>
      <Text style={[rowStyles.label, { color: colors.mutedForeground }]} numberOfLines={1}>
        {label}
      </Text>
      <Text style={[rowStyles.value, { color: colors.foreground }]}>{value}</Text>
    </View>
  );
}

export function shortSessionId(sessionId: string): string {
  return sessionId.split('-').slice(0, 2).join('-');
}

export interface ChildAgentResource {
  childSessionId: string;
  agentType: string;
  status: SubagentStatus;
  model?: string;
  durationMs?: number;
  totalTokens?: number;
}

export function collectChildAgentResources(
  messages: MessageItem[] | undefined,
): ChildAgentResource[] {
  const bySession = new Map<string, ChildAgentResource>();
  for (const message of messages ?? []) {
    if (message.type !== 'subagent' || !message.childSessionId) continue;
    bySession.set(message.childSessionId, {
      childSessionId: message.childSessionId,
      agentType: message.agentType,
      status: message.status,
      model: message.model,
      durationMs: message.durationMs,
      totalTokens: message.totalTokens,
    });
  }
  return [...bySession.values()];
}

export function childStatusLabel(status: SubagentStatus): string {
  if (status === 'running') return '运行中';
  if (status === 'completed') return '已完成';
  if (status === 'cancelled') return '已取消';
  if (status === 'timeout') return '超时';
  return '失败';
}

export const barStyles = StyleSheet.create({
  track: {
    flexDirection: 'row',
    height: 8,
    borderRadius: radius.full,
    overflow: 'hidden',
    marginTop: spacing.sm,
  },
  progressTrack: {
    height: 8,
    borderRadius: radius.full,
    overflow: 'hidden',
    marginTop: spacing.sm,
    justifyContent: 'center',
  },
  progressFill: { height: '100%', borderRadius: radius.full },
  thresholdMark: { position: 'absolute', top: 0, bottom: 0, width: 1 },
});

export const rowStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 3,
  },
  label: { ...typography.caption, flexShrink: 1 },
  value: { ...typography.caption, fontFamily: monoFamily },
  categoryLabel: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs + 1,
  },
  swatch: { width: 8, height: 8, borderRadius: radius.sm / 2 },
  badge: { ...typography.meta },
});

export function useStyles(colors: ThemeColors) {
  return useMemo(
    () =>
      StyleSheet.create({
        card: {
          position: 'absolute',
          right: spacing.md,
          width: 320,
          maxHeight: 560,
          backgroundColor: colors.card,
          borderRadius: radius.lg,
          padding: spacing.md,
          shadowColor: colors.shadow,
          shadowOffset: { width: 0, height: 4 },
          shadowOpacity: 0.15,
          shadowRadius: 12,
          elevation: 8,
          borderWidth: 1,
          borderColor: colors.border,
        },
        hero: {
          borderRadius: radius.xl,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.border,
          backgroundColor: colors.muted,
          padding: spacing.md,
          gap: spacing.xs,
        },
        heroRow: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm },
        heroValue: { ...typography.display },
        kpiRow: { flexDirection: 'row', marginTop: spacing.xs },
        kpiCell: { flex: 1, minWidth: 0, paddingHorizontal: spacing.sm },
        kpiCellDivided: { borderLeftWidth: StyleSheet.hairlineWidth },
        kpiValue: { ...typography.subtitle, color: colors.foreground },
        sectionTitle: {
          ...typography.caption,
          fontWeight: '600',
          color: colors.foreground,
          marginBottom: 2,
        },
        hint: { ...typography.meta, color: colors.mutedForeground },
        subTree: {
          marginLeft: spacing.sm,
          paddingLeft: spacing.sm,
          borderLeftWidth: StyleSheet.hairlineWidth,
        },
        childResourceRow: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: spacing.sm,
          paddingVertical: 2,
        },
        childResourceText: { flex: 1, minWidth: 0 },
        divider: {
          height: StyleSheet.hairlineWidth,
          backgroundColor: colors.border,
          marginVertical: 6,
        },
        sessionId: { ...typography.caption, color: colors.mutedForeground, paddingVertical: 2 },
      }),
    [colors],
  );
}

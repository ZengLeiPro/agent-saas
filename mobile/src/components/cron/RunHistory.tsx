/**
 * 运行历史 —— 信息结构对齐 Web `CronManager/RunHistory.tsx` 的表格列
 * （时间 / 状态 / 尝试 / 耗时 / 摘要），触屏上把「尝试与摘要」折进可展开区。
 *
 * 呈现门禁：这里只展示服务端已经语义化过的字段（状态、耗时、触发方式、错误摘要）。
 * 原始 transcript（`/runs/:runId/details`）属于 raw payload，遵守
 * RawPresentationGate / debugMode 纪律：非 debug 档位不提供入口，
 * 移动端当前也不拉取该端点，避免把原始输出泄进普通员工视图。
 */
import React, { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ChevronDown, ChevronRight } from 'lucide-react-native';
import type { CronRunLogEntry } from '@agent/shared';
import {
  cronRunStatusTone,
  cronRunSummary,
  cronRunTriggerLabel,
  formatCronRunDuration,
} from '@agent/shared';
import { useColors, spacing, fontScale, fontWeight } from '../../theme';
import { ICON_SIZE, ICON_STROKE } from '../../lib/icons';
import { Card } from '../ui/Card';
import { EmptyState } from '../ui/EmptyState';
import { Skeleton } from '../ui/Skeleton';
import { StatusBadge } from '../ui/StatusBadge';
import { resolveListRowPosition, resolveListRowShape } from '../ui/listRowStyles';

interface RunHistoryProps {
  entries: CronRunLogEntry[];
  loading: boolean;
  error?: string | null;
  /** debugMode 放行时才展示 runId / sessionId 这类排障标识 */
  debugMode?: boolean;
}

const SKELETON_ROWS = 3;
const SKELETON_ROW_HEIGHT = 48;

function formatStartedAt(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(
    d.getSeconds(),
  )}`;
}

function RunRow({
  entry,
  last,
  debugMode,
}: {
  entry: CronRunLogEntry;
  last: boolean;
  debugMode?: boolean;
}) {
  const colors = useColors();
  const [expanded, setExpanded] = useState(false);
  const shape = resolveListRowShape(resolveListRowPosition(last ? 1 : 0, 2));
  const Chevron = expanded ? ChevronDown : ChevronRight;
  const summary = cronRunSummary(entry);

  const toggle = useCallback(() => setExpanded((v) => !v), []);

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${formatStartedAt(entry.startedAtMs)} ${summary}`}
        accessibilityState={{ expanded }}
        onPress={toggle}
        style={({ pressed }) => (pressed ? { backgroundColor: colors.accent } : null)}
      >
        <View style={styles.row}>
          <StatusBadge status={cronRunStatusTone(entry.status)} size="sm" />
          <View style={styles.main}>
            <Text style={[styles.time, { color: colors.foreground }]} numberOfLines={1}>
              {formatStartedAt(entry.startedAtMs)}
            </Text>
            <Text style={[styles.meta, { color: colors.mutedForeground }]} numberOfLines={1}>
              {cronRunTriggerLabel(entry.trigger)} · {formatCronRunDuration(entry.durationMs)}
              {entry.attempt && entry.attempt > 1 ? ` · 第 ${entry.attempt} 次尝试` : ''}
            </Text>
          </View>
          <Chevron
            size={ICON_SIZE.action}
            color={colors.mutedForeground}
            strokeWidth={ICON_STROKE.default}
          />
        </View>
      </Pressable>

      {expanded ? (
        <View style={styles.detail}>
          <Text
            style={[
              styles.summary,
              { color: entry.status === 'error' ? colors.dangerFamily.ink : colors.mutedForeground },
            ]}
          >
            {summary}
          </Text>
          {debugMode ? (
            <Text style={[styles.debug, { color: colors.mutedForeground }]} numberOfLines={2}>
              run: {entry.runId}
              {entry.sessionId ? `\nsession: ${entry.sessionId}` : ''}
            </Text>
          ) : null}
        </View>
      ) : null}

      {shape.showSeparator ? (
        <View style={[styles.separator, { backgroundColor: colors.border }]} />
      ) : null}
    </View>
  );
}

export function RunHistory({ entries, loading, error, debugMode }: RunHistoryProps) {
  const colors = useColors();

  if (loading) {
    return (
      <View style={styles.skeletonWrap} testID="cron-run-history-skeleton">
        {Array.from({ length: SKELETON_ROWS }, (_, index) => (
          <Skeleton key={index} height={SKELETON_ROW_HEIGHT} />
        ))}
      </View>
    );
  }

  if (error) {
    return (
      <Card>
        <Text style={[styles.summary, { color: colors.dangerFamily.ink }]}>{error}</Text>
      </Card>
    );
  }

  if (entries.length === 0) {
    return <EmptyState title="暂无运行记录" testID="cron-run-history-empty" />;
  }

  return (
    <Card flush testID="cron-run-history">
      {entries.map((entry, index) => (
        <RunRow
          key={entry.runId}
          entry={entry}
          last={index === entries.length - 1}
          debugMode={debugMode}
        />
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.md,
  },
  main: {
    flex: 1,
    gap: 2,
  },
  time: {
    ...fontScale.sm,
    fontWeight: fontWeight.medium,
  },
  meta: {
    ...fontScale.xs,
  },
  detail: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    gap: spacing.xs,
  },
  summary: {
    ...fontScale.sm,
  },
  debug: {
    ...fontScale.xs2,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: spacing.lg,
  },
  skeletonWrap: {
    gap: spacing.sm,
  },
});

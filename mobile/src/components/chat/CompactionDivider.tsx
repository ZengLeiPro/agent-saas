import React, { useMemo, useState } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from "react-native";
import { ChevronRight } from "lucide-react-native";
import { useColors, useChatTypography, spacing, radius, monoFamily } from "../../theme";
import type { CompactionMessageItem } from "../../lib/compaction";

/**
 * 上下文压缩渲染单元（非气泡），与 `web/src/components/CompactionDivider.tsx` 同口径：
 * - status='running'：状态条「正在压缩上下文…」；
 * - 非 debugMode：只画分界线，不暴露压缩条数与摘要（黑箱压缩纪律）；
 * - debugMode：分界线中间显示「已压缩 N 条历史消息」，有摘要时可展开为等宽正文。
 *
 * debugMode 与 MessageList 里 presentationGate 的来源同一条：
 * `user.debugMode === true && isDebugModeAvailable(...)`。
 */
interface CompactionDividerProps {
  item: CompactionMessageItem;
  /** 仅调试用户可见压缩条数与「查看摘要」入口 */
  debugMode?: boolean;
}

export const CompactionDivider = React.memo(function CompactionDivider({
  item,
  debugMode,
}: CompactionDividerProps) {
  const colors = useColors();
  const typo = useChatTypography();
  const [expanded, setExpanded] = useState(false);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: {
          alignItems: "center",
          paddingVertical: spacing.lg,
          paddingHorizontal: spacing.sm,
        },
        lineRow: {
          flexDirection: "row",
          alignItems: "center",
          alignSelf: "stretch",
          gap: spacing.sm,
        },
        line: {
          flex: 1,
          height: StyleSheet.hairlineWidth,
          backgroundColor: colors.border,
        },
        label: {
          ...typo.caption,
          color: colors.mutedForeground,
        },
        expandRow: {
          flexDirection: "row",
          alignItems: "center",
          gap: spacing.xs / 2,
        },
        runningRow: {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: spacing.sm,
          paddingVertical: spacing.sm,
        },
        summary: {
          ...typo.caption,
          fontFamily: monoFamily,
          color: colors.mutedForeground,
          alignSelf: "stretch",
          marginTop: spacing.sm,
          padding: spacing.sm,
          borderRadius: radius.md,
          backgroundColor: colors.codeBlockBg,
        },
      }),
    [colors, typo],
  );

  if (item.status === "running") {
    return (
      <View style={styles.runningRow}>
        <ActivityIndicator size="small" color={colors.mutedForeground} />
        <Text style={styles.label}>正在压缩上下文…</Text>
      </View>
    );
  }

  const label =
    typeof item.coveredEventCount === "number" && item.coveredEventCount > 0
      ? `已压缩 ${item.coveredEventCount} 条历史消息`
      : "上下文已压缩";
  const canExpand = debugMode === true && !!item.summary;

  return (
    <View style={styles.container}>
      <View style={styles.lineRow}>
        <View style={styles.line} />
        {debugMode === true ? (
          <>
            <Text style={styles.label}>{label}</Text>
            {canExpand ? (
              <Pressable
                testID="compaction-summary-toggle"
                accessibilityRole="button"
                accessibilityLabel={expanded ? "收起压缩摘要" : "查看压缩摘要"}
                hitSlop={8}
                onPress={() => setExpanded((value) => !value)}
                style={styles.expandRow}
              >
                <Text style={styles.label}>查看摘要</Text>
                <ChevronRight
                  size={12}
                  color={colors.mutedForeground}
                  strokeWidth={2}
                  style={{ transform: [{ rotate: expanded ? "90deg" : "0deg" }] }}
                />
              </Pressable>
            ) : null}
          </>
        ) : null}
        <View style={styles.line} />
      </View>
      {canExpand && expanded ? (
        <Text style={styles.summary} testID="compaction-summary">
          {item.summary}
        </Text>
      ) : null}
    </View>
  );
});

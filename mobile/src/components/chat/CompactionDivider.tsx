import React, { useMemo } from "react";
import { View, Text, StyleSheet } from "react-native";
import { useColors, useChatTypography, spacing } from "../../theme";
import type { CompactionMessageItem } from "../../lib/compaction";

/**
 * 上下文压缩分界线（非气泡）：
 * ──── 已压缩 N 条历史消息 ────
 * 分界线以上的内容 AI 已不再直接记得，但原始记录完整保留、可随时检索
 *
 * item.summary 完整携带压缩摘要；「查看摘要」入口仅在用户 debugMode 下
 * 提供，mobile 当前未消费 debugMode，故暂不渲染展开按钮。
 */
interface CompactionDividerProps {
  item: CompactionMessageItem;
}

export const CompactionDivider = React.memo(function CompactionDivider({
  item,
}: CompactionDividerProps) {
  const colors = useColors();
  const typo = useChatTypography();

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
        hint: {
          ...typo.caption,
          color: colors.mutedForeground,
          opacity: 0.75,
          marginTop: spacing.xs,
          textAlign: "center",
          paddingHorizontal: spacing.lg,
        },
      }),
    [colors, typo],
  );

  const label =
    item.coveredEventCount > 0
      ? `已压缩 ${item.coveredEventCount} 条历史消息`
      : "上下文已压缩";

  return (
    <View style={styles.container}>
      <View style={styles.lineRow}>
        <View style={styles.line} />
        <Text style={styles.label}>{label}</Text>
        <View style={styles.line} />
      </View>
      <Text style={styles.hint}>
        分界线以上的内容 AI 已不再直接记得，但原始记录完整保留、可随时检索
      </Text>
    </View>
  );
});

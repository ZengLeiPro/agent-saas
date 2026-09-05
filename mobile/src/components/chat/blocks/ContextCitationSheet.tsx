/**
 * 会话 Context 引用证据抽屉（对齐 `web/src/components/ContextCitationDrawer.tsx`）。
 *
 * 只读展示：来源 / 原文时间 / Freshness / 证据状态 + Evidence 列表。
 * 归一化、失败文案、链接白名单全部来自 shared `lib/contextCitation`，
 * 本文件只做 BottomSheet 内的 RN 绑定，不含判定逻辑。
 */
import React, { useMemo } from 'react';
import { ActivityIndicator, Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ExternalLink, FileSearch } from 'lucide-react-native';
import {
  formatContextCitationTime,
  safeContextCitationUrl,
  type ContextCitationDetail,
  type ContextCitationEvidence,
} from '@agent/shared';
import { BottomSheet, Badge, Button } from '../../ui';
import { useColors, useChatTypography, spacing, radius } from '../../../theme';
import type { ThemeColors } from '../../../theme';

export interface ContextCitationSheetProps {
  visible: boolean;
  label: string;
  detail: ContextCitationDetail | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onRetry: () => void;
}

function useSheetStyles(colors: ThemeColors, typo: ReturnType<typeof useChatTypography>) {
  return useMemo(
    () =>
      StyleSheet.create({
        body: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, gap: spacing.md },
        center: {
          alignItems: 'center',
          justifyContent: 'center',
          gap: spacing.sm,
          paddingVertical: spacing['3xl'],
        },
        subtitle: { ...typo.caption, color: colors.mutedForeground },
        summaryCard: {
          borderRadius: radius.xl,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.border,
          backgroundColor: colors.muted,
          padding: spacing.md,
          gap: spacing.sm,
        },
        field: { gap: spacing.xs / 2 },
        fieldLabel: { ...typo.meta, color: colors.mutedForeground },
        fieldValue: { ...typo.bodySmall, color: colors.foreground },
        badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
        evidenceCard: {
          borderRadius: radius.xl,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.border,
          backgroundColor: colors.card,
          padding: spacing.md,
          gap: spacing.sm,
        },
        quote: {
          ...typo.bodySmall,
          color: colors.foreground,
          borderLeftWidth: 2,
          borderLeftColor: colors.primary,
          paddingLeft: spacing.md,
        },
        linkRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
        link: { ...typo.bodySmall, color: colors.link },
        errorCard: {
          borderRadius: radius.xl,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.dangerFamily.DEFAULT,
          backgroundColor: colors.dangerFamily.subtle,
          padding: spacing.lg,
          alignItems: 'center',
          gap: spacing.md,
        },
        errorText: { ...typo.bodySmall, color: colors.dangerFamily.ink, textAlign: 'center' },
      }),
    [colors, typo],
  );
}

function EvidenceItem({
  item,
  styles,
  colors,
}: {
  item: ContextCitationEvidence;
  styles: ReturnType<typeof useSheetStyles>;
  colors: ThemeColors;
}) {
  const nativeUrl = safeContextCitationUrl(item.nativeUrl);
  return (
    <View style={styles.evidenceCard} testID="context-citation-evidence">
      <Text style={styles.fieldLabel}>Evidence</Text>
      <Text style={styles.quote}>“{item.quote}”</Text>
      <Text style={styles.subtitle}>作者：{item.author || '未提供'}</Text>
      {nativeUrl ? (
        <Text
          style={styles.link}
          accessibilityRole="link"
          onPress={() => {
            void Linking.openURL(nativeUrl);
          }}
        >
          在原系统中打开 <ExternalLink size={12} color={colors.link} strokeWidth={2} />
        </Text>
      ) : (
        <Text style={styles.subtitle}>
          {item.nativeUrl ? '原文链接因安全策略不可打开' : '原文链接未提供'}
        </Text>
      )}
    </View>
  );
}

export function ContextCitationSheet({
  visible,
  label,
  detail,
  loading,
  error,
  onClose,
  onRetry,
}: ContextCitationSheetProps) {
  const colors = useColors();
  const typo = useChatTypography();
  const styles = useSheetStyles(colors, typo);

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title="Context 引用"
      snap="half"
      testID="context-citation-sheet"
    >
      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <Text style={styles.subtitle} numberOfLines={2}>
          {label}
        </Text>
        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator size="small" color={colors.mutedForeground} />
            <Text style={styles.subtitle}>正在加载引用证据</Text>
          </View>
        ) : error ? (
          <View style={styles.errorCard}>
            <Text style={styles.errorText}>{error}</Text>
            <Button label="重试" variant="outline" size="sm" onPress={onRetry} />
          </View>
        ) : detail ? (
          <>
            <View style={styles.summaryCard}>
              <View style={styles.field}>
                <Text style={styles.fieldLabel}>来源</Text>
                <Text style={styles.fieldValue}>{detail.source}</Text>
              </View>
              <View style={styles.field}>
                <Text style={styles.fieldLabel}>原文时间</Text>
                <Text style={styles.fieldValue}>
                  {formatContextCitationTime(detail.occurredAt)}
                </Text>
              </View>
              <View style={styles.field}>
                <Text style={styles.fieldLabel}>Freshness</Text>
                <View style={styles.badgeRow}>
                  <Badge label={detail.freshness} variant="outline" size="sm" />
                  {detail.freshnessAsOf ? (
                    <Text style={styles.subtitle}>
                      截至 {formatContextCitationTime(detail.freshnessAsOf)}
                    </Text>
                  ) : null}
                </View>
              </View>
              <View style={styles.field}>
                <Text style={styles.fieldLabel}>证据状态</Text>
                <View style={styles.badgeRow}>
                  <Badge
                    label={detail.derived ? '派生证据' : '原始证据'}
                    variant={detail.derived ? 'info' : 'outline'}
                    size="sm"
                  />
                  <Badge
                    label={detail.degraded ? '降级结果' : '未降级'}
                    variant={detail.degraded ? 'warning' : 'outline'}
                    size="sm"
                  />
                </View>
              </View>
            </View>
            {detail.evidence.length ? (
              detail.evidence.map((item, index) => (
                <EvidenceItem
                  key={`${index}-${item.quote}`}
                  item={item}
                  styles={styles}
                  colors={colors}
                />
              ))
            ) : (
              <View style={styles.center}>
                <FileSearch size={28} color={colors.mutedForeground} strokeWidth={2} />
                <Text style={styles.fieldValue}>暂无可展示 Evidence</Text>
              </View>
            )}
          </>
        ) : null}
      </ScrollView>
    </BottomSheet>
  );
}

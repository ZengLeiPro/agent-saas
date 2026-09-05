/**
 * canonical presentation 正文：summary / detail / display / evidence / receipt 的统一渲染。
 *
 * detail 按 DetailLine 分型渲染（见 DetailLines.tsx），display 按 kind 分派
 * （见 PresentationBlockViews.tsx）——两者都与 Web 同源，不再降级成纯文本行。
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { CircleCheck } from 'lucide-react-native';
import type { SharedPresentation, ToolReceipt } from '@agent/shared';
import {
  useColors,
  spacing,
  radius,
  fontScale,
  fontWeight,
  monoFamily,
  useChatTypography,
} from '../../../theme';
import { DetailLines, type DetailVariant } from './DetailLines';
import { PresentationBlocks } from './PresentationBlockViews';
import { resolveActivityToneTokens } from './tone';

/** 外部系统回执：平台盖的章，位置与语气都比普通详情行高一档。 */
export function ReceiptRow({ receipt }: { receipt: ToolReceipt }) {
  const colors = useColors();
  const typo = useChatTypography();
  const success = resolveActivityToneTokens('success', colors);
  return (
    <View style={[styles.receipt, { borderTopColor: colors.border }]}>
      <Text style={[typo.caption, { color: colors.mutedForeground }]}>回执</Text>
      <Text style={[typo.caption, { color: colors.foreground }]}>{receipt.system}</Text>
      <Text style={[styles.mono, styles.flexText, { color: colors.foreground }]}>{receipt.id}</Text>
      {receipt.readBack ? (
        <View style={styles.readBack}>
          <CircleCheck size={12} color={success.tint} strokeWidth={2} />
          <Text style={[typo.caption, { color: success.ink }]}>回读校验通过</Text>
        </View>
      ) : null}
    </View>
  );
}

/** 依据引用：等宽小 chip，强调「这是可溯源的稳定标识」而不是一句描述。 */
export function EvidenceRefs({ refs }: { refs: readonly string[] }) {
  const colors = useColors();
  if (!refs.length) return null;
  return (
    <View style={styles.evidence}>
      {refs.map((ref) => (
        <Text
          key={ref}
          style={[
            styles.mono,
            styles.chip,
            { color: colors.mutedForeground, borderColor: colors.border },
          ]}
        >
          {ref}
        </Text>
      ))}
    </View>
  );
}

export function CanonicalPresentationBody({
  presentation,
  detailVariant = 'plain',
}: {
  presentation: SharedPresentation;
  /** 工具摘要用 `code` 皮（等宽密排），业务步骤与呈现块用 `plain`。 */
  detailVariant?: DetailVariant;
}) {
  const colors = useColors();
  const typo = useChatTypography();
  const hasBody =
    !!presentation.summary ||
    presentation.detail.length > 0 ||
    presentation.display.length > 0 ||
    presentation.evidence.length > 0 ||
    !!presentation.receipt;
  if (!hasBody) return null;

  return (
    <View style={styles.body}>
      {presentation.summary ? (
        <Text
          style={[
            typo.bodySmall,
            { color: colors.foreground, fontWeight: fontWeight.medium },
          ]}
        >
          {presentation.summary}
        </Text>
      ) : null}
      <DetailLines lines={presentation.detail} variant={detailVariant} />
      <PresentationBlocks blocks={presentation.display} />
      <EvidenceRefs refs={presentation.evidence} />
      {presentation.receipt ? <ReceiptRow receipt={presentation.receipt} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { gap: spacing.sm, paddingVertical: spacing.xs },
  mono: { ...fontScale.xs, fontFamily: monoFamily },
  flexText: { flex: 1, minWidth: 0 },
  receipt: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: spacing.xs,
  },
  readBack: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  evidence: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  chip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.xs,
    paddingVertical: 1,
    overflow: 'hidden',
  },
});

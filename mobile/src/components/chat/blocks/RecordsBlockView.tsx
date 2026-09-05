/**
 * records 呈现块 —— 与 `web/src/components/presentation/PresentationBlocks.tsx`
 * 的 RecordsView 同构：rows / checklist / comparison / grid 四种布局。
 *
 * Web 用 CSS grid + subgrid 做列对齐；RN 没有 subgrid，comparison 表改为
 * **横向可滚动**的固定列宽表格——手机宽度放不下 4 列，横滑比换行更接近
 * 客户在 Web 手机浏览器里看到的形态。
 */
import React, { useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { ChevronRight, Circle, CircleCheck, CircleX, TriangleAlert } from 'lucide-react-native';
import type { PresentationTone, RecordItem, RecordsBlock } from '@agent/shared';
import {
  useColors,
  spacing,
  radius,
  fontScale,
  fontWeight,
  monoFamily,
  useChatTypography,
} from '../../../theme';
import { Badge } from '../../ui';
import { DetailLines } from './DetailLines';
import { resolvePresentationToneTokens, toneBadgeVariant } from './tone';
import { PRESENTATION_TONE_TO_ACTIVITY } from '@agent/shared';

const CHECKLIST_ICON: Record<PresentationTone, typeof Circle> = {
  neutral: Circle,
  info: Circle,
  success: CircleCheck,
  warn: TriangleAlert,
  danger: CircleX,
  muted: Circle,
};

const ICON = 12;
const STROKE = 2;
/** comparison 表的列宽：手机横滑表格必须固定列宽，否则跨行对不齐。 */
const COMPARISON_WIDTHS = [128, 132, 132, 108] as const;
const COMPARISON_HEADERS = ['对照项', '基准/之前', '当前/实际', '差异'] as const;

function useMonoStyle(mono?: boolean) {
  return mono ? { ...fontScale.xs, fontFamily: monoFamily } : null;
}

function RecordRow({
  item,
  checklist,
  showValue,
}: {
  item: RecordItem;
  checklist: boolean;
  showValue: boolean;
}) {
  const colors = useColors();
  const typo = useChatTypography();
  const [open, setOpen] = useState(false);
  const expandable = !!item.detail?.length;
  const tone = item.tone ?? 'neutral';
  const toneTokens = resolvePresentationToneTokens(tone, colors);
  const Icon = CHECKLIST_ICON[tone];
  const mono = useMonoStyle(item.mono);

  return (
    <View
      style={[
        styles.row,
        { borderTopColor: colors.border },
        item.tone === 'warn' ? { backgroundColor: toneTokens.subtle } : null,
      ]}
    >
      <Pressable
        onPress={expandable ? () => setOpen((value) => !value) : undefined}
        disabled={!expandable}
        accessibilityRole={expandable ? 'button' : undefined}
        accessibilityState={expandable ? { expanded: open } : undefined}
        accessibilityLabel={[item.label, item.value, item.tag?.text].filter(Boolean).join('，')}
        style={[styles.rowInner, expandable ? styles.tappable : null]}
      >
        {checklist ? (
          <Icon size={ICON} color={toneTokens.tint} strokeWidth={STROKE} style={styles.rowIcon} />
        ) : null}
        <Text
          style={[
            typo.bodySmall,
            mono,
            styles.label,
            { color: checklist ? colors.foreground : colors.mutedForeground },
            !checklist && item.tone === 'danger' ? styles.struck : null,
          ]}
        >
          {item.label}
        </Text>
        {showValue ? (
          <Text style={[typo.bodySmall, mono, styles.value, { color: colors.foreground }]}>
            {item.value ?? ''}
          </Text>
        ) : null}
        {item.tag ? (
          <Badge
            size="sm"
            variant={toneBadgeVariant(PRESENTATION_TONE_TO_ACTIVITY[item.tag.tone])}
            label={item.tag.text}
          />
        ) : null}
        {expandable ? (
          <ChevronRight
            size={14}
            color={colors.mutedForeground}
            style={open ? styles.rotated : undefined}
          />
        ) : null}
      </Pressable>
      {item.note ? (
        <Text style={[typo.caption, { color: colors.mutedForeground }]}>{item.note}</Text>
      ) : null}
      {expandable && open ? <DetailLines lines={item.detail} /> : null}
    </View>
  );
}

function ComparisonCell({ text, width, tone }: { text: string; width: number; tone?: string }) {
  const colors = useColors();
  const typo = useChatTypography();
  return <Text style={[typo.bodySmall, { width, color: tone ?? colors.foreground }]}>{text}</Text>;
}

function ComparisonTable({ items }: { items: readonly RecordItem[] }) {
  const colors = useColors();
  const typo = useChatTypography();
  return (
    <ScrollView
      horizontal
      nestedScrollEnabled
      showsHorizontalScrollIndicator
      accessibilityLabel="对照表，可横向滚动"
    >
      <View>
        <View style={[styles.comparisonRow, { borderTopColor: colors.border }]}>
          {COMPARISON_HEADERS.map((header, index) => (
            <Text
              key={header}
              style={[
                typo.caption,
                { width: COMPARISON_WIDTHS[index], color: colors.mutedForeground },
              ]}
            >
              {header}
            </Text>
          ))}
        </View>
        {items.map((item, index) => {
          const toneTokens = item.tone ? resolvePresentationToneTokens(item.tone, colors) : null;
          return (
            <View
              key={index}
              style={[
                styles.comparisonRow,
                { borderTopColor: colors.border },
                item.tone === 'warn' || item.tone === 'danger'
                  ? { backgroundColor: toneTokens?.subtle }
                  : null,
              ]}
            >
              <ComparisonCell text={item.label} width={COMPARISON_WIDTHS[0]} />
              <ComparisonCell text={item.baseline ?? '—'} width={COMPARISON_WIDTHS[1]} />
              <ComparisonCell text={item.current ?? '—'} width={COMPARISON_WIDTHS[2]} />
              <ComparisonCell
                text={item.delta ?? '—'}
                width={COMPARISON_WIDTHS[3]}
                tone={toneTokens?.ink}
              />
            </View>
          );
        })}
      </View>
    </ScrollView>
  );
}

function GridView({ items }: { items: readonly RecordItem[] }) {
  const colors = useColors();
  const typo = useChatTypography();
  return (
    <View style={styles.grid}>
      {items.map((item, index) => (
        <View key={index} style={styles.gridCell}>
          <Text style={[typo.caption, { color: colors.mutedForeground }]}>{item.label}</Text>
          <Text
            style={[
              typo.bodySmall,
              item.mono ? { ...fontScale.xs, fontFamily: monoFamily } : null,
              {
                color: item.tone
                  ? resolvePresentationToneTokens(item.tone, colors).ink
                  : colors.foreground,
              },
            ]}
          >
            {item.value ?? ''}
          </Text>
        </View>
      ))}
    </View>
  );
}

export function RecordsBlockView({ block }: { block: RecordsBlock }) {
  const colors = useColors();
  const typo = useChatTypography();
  const checklist = block.layout === 'checklist';
  const showValue = block.items.some((item) => item.value !== undefined && item.value !== '');

  return (
    <View style={[styles.container, { borderColor: colors.border, backgroundColor: colors.card }]}>
      {block.title ? (
        <View style={[styles.titleBar, { backgroundColor: colors.muted }]}>
          <Text
            style={[typo.bodySmall, { color: colors.foreground, fontWeight: fontWeight.semibold }]}
          >
            {block.title}
          </Text>
        </View>
      ) : null}
      {block.layout === 'grid' ? (
        <GridView items={block.items} />
      ) : block.layout === 'comparison' ? (
        <ComparisonTable items={block.items} />
      ) : (
        block.items.map((item, index) => (
          <RecordRow key={index} item={item} checklist={checklist} showValue={showValue} />
        ))
      )}
      {block.footer ? (
        <View style={[styles.footer, { borderTopColor: colors.border }]}>
          <Text style={[typo.caption, { color: colors.mutedForeground }]}>{block.footer}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg,
    overflow: 'hidden',
  },
  titleBar: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  row: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, gap: 2 },
  rowInner: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  tappable: { minHeight: 44, alignItems: 'center' },
  rowIcon: { marginTop: 3 },
  label: { flexShrink: 1, minWidth: 0 },
  value: { flex: 1, minWidth: 0 },
  struck: { textDecorationLine: 'line-through', opacity: 0.7 },
  rotated: { transform: [{ rotate: '90deg' }] },
  comparisonRow: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap', padding: spacing.md, gap: spacing.sm },
  gridCell: { minWidth: '44%', flexGrow: 1, flexShrink: 1, gap: 2 },
  footer: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});

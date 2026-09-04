/** canonical presentation 正文：detail / display / evidence / receipt 的统一渲染。 */
import React from 'react';
import { View, Text } from 'react-native';
import type { PresentationBlock, SharedPresentation } from '@agent/shared';
import { useColors, spacing, typography } from '../../../theme';

function detailLineText(line: SharedPresentation['detail'][number]): string {
  if (typeof line === 'string') return line;
  if ('k' in line) return `${line.k}：${line.v}`;
  if ('no' in line) return `${line.no}. ${line.text}`;
  if ('indent' in line) return line.text;
  if ('section' in line) return line.section;
  if ('warn' in line) return line.warn;
  if ('insight' in line) return `${line.label ? `${line.label}：` : ''}${line.insight}`;
  if ('risk' in line) return `${line.text}${line.action ? `；${line.action}` : ''}`;
  if ('verdict' in line) return `${line.text}${line.note ? `；${line.note}` : ''}`;
  if ('quote' in line) return `${line.quote}${line.source ? ` — ${line.source}` : ''}`;
  if ('original' in line)
    return `${line.original}${line.translation ? `；${line.translation}` : ''}`;
  return line.fields.map((field) => `${field.k}：${field.v}`).join('；');
}

function displayBlockLines(block: PresentationBlock): string[] {
  if (block.kind === 'callout')
    return [block.title, ...block.body, ...(block.detail?.map(detailLineText) ?? [])].filter(
      (value): value is string => !!value,
    );
  if (block.kind === 'records')
    return [
      block.title,
      ...block.items.map((item) =>
        [item.label, item.value, item.baseline, item.current, item.delta, item.note]
          .filter(Boolean)
          .join(' · '),
      ),
      block.footer,
    ].filter((value): value is string => !!value);
  return [block.title, ...(block.body ?? [])];
}

export function CanonicalPresentationBody({ presentation }: { presentation: SharedPresentation }) {
  const colors = useColors();
  const lines = [
    ...presentation.detail.map(detailLineText),
    ...presentation.display.flatMap(displayBlockLines),
    ...presentation.evidence.map((item) => `依据：${item}`),
  ];
  return (
    <View style={{ gap: spacing.xs, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs }}>
      {presentation.summary ? (
        <Text style={{ ...typography.bodySmall, color: colors.foreground }}>
          {presentation.summary}
        </Text>
      ) : null}
      {lines.map((line, index) => (
        <Text
          key={`${index}-${line}`}
          style={{ ...typography.caption, color: colors.mutedForeground }}
        >
          {line}
        </Text>
      ))}
      {presentation.receipt ? (
        <Text style={{ ...typography.caption, color: colors.mutedForeground }}>
          {presentation.receipt.system} · {presentation.receipt.id}
        </Text>
      ) : null}
    </View>
  );
}

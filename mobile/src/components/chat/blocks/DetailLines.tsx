/**
 * DetailLine 分型渲染 —— 与 `web/src/components/PresentationDetail.tsx` 同构。
 *
 * 之前 Mobile 把所有结构化 detail 降级成纯文本行，是多个块视觉差距的共同根因：
 * 判定行没有对错色、缺口区没有橙底、字段网格没有大字。分组与语义判定全部取自
 * `@agent/shared`（groupDetailLines / isEmphasisValue），本文件只做 RN 绑定。
 *
 * 安全纪律（M40-04）：未知变体安全降级为纯文本，不 JSON.stringify、不抛错。
 */
import React, { createContext, useContext, useMemo } from 'react';
import { View, Text, StyleSheet, type TextStyle } from 'react-native';
import { Circle, CircleCheck, CircleX, TriangleAlert } from 'lucide-react-native';
import type { DetailLine } from '@agent/shared';
import { DEFAULT_WARN_HEADER, groupDetailLines, isEmphasisValue } from '@agent/shared';
import {
  useColors,
  spacing,
  radius,
  fontScale,
  monoFamily,
  fontWeight,
  useChatTypography,
} from '../../../theme';
import { resolveActivityToneTokens } from './tone';

/**
 * 三种排版皮，与 Web 一一对应：
 * - `code`：工具执行摘要的等宽块（深底浅字，密集）；
 * - `card`：白卡键值（细分隔线 + 关键值强调色）；
 * - `plain`：无框业务摘要，保留各行自身的判定 / 风险 / 警告语义。
 */
export type DetailVariant = 'code' | 'card' | 'plain';

const VariantContext = createContext<DetailVariant>('plain');

const CIRCLED_DIGITS = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';

function formatOrdinal(no: number): string {
  return no >= 1 && no <= CIRCLED_DIGITS.length ? CIRCLED_DIGITS[no - 1] : `${no}.`;
}

/** 正文字号：code 皮走等宽小字，其余走业务正文。 */
function useBodyTextStyle(): TextStyle {
  const variant = useContext(VariantContext);
  const typo = useChatTypography();
  return variant === 'code' ? { ...fontScale.xs, fontFamily: monoFamily } : typo.bodySmall;
}

function KeyValueRow({ k, v, prefix }: { k: string; v: string; prefix?: string }) {
  const colors = useColors();
  const variant = useContext(VariantContext);
  const body = useBodyTextStyle();
  const emphasized = variant === 'card' && isEmphasisValue(v);
  return (
    <View style={styles.kvRow}>
      <Text style={[body, styles.kvLabel, { color: colors.mutedForeground }]}>
        {prefix ? `${prefix} ` : ''}
        {k}
      </Text>
      <Text
        style={[
          body,
          styles.kvValue,
          { color: emphasized ? colors.primary : colors.foreground },
          emphasized ? { fontWeight: fontWeight.medium } : null,
        ]}
      >
        {v}
      </Text>
    </View>
  );
}

function SectionRow({ section }: { section: string }) {
  const colors = useColors();
  const typo = useChatTypography();
  return (
    <Text style={[typo.meta, styles.section, { color: colors.mutedForeground }]}>{section}</Text>
  );
}

const VERDICT_ICON = {
  pass: CircleCheck,
  fail: CircleX,
  warn: TriangleAlert,
  pending: Circle,
} as const;

const VERDICT_TONE = {
  pass: 'success',
  fail: 'danger',
  warn: 'warning',
  pending: 'pending',
} as const;

function VerdictRow({
  verdict,
  text,
  note,
}: {
  verdict: keyof typeof VERDICT_ICON;
  text: string;
  note?: string;
}) {
  const colors = useColors();
  const body = useBodyTextStyle();
  const Icon = VERDICT_ICON[verdict];
  const tone = resolveActivityToneTokens(VERDICT_TONE[verdict], colors);
  return (
    <View style={styles.iconRow}>
      <Icon size={ICON} color={tone.tint} strokeWidth={STROKE} style={styles.rowIcon} />
      <Text style={[body, styles.flexText, { color: colors.foreground }]}>
        {text}
        {note ? <Text style={{ color: colors.mutedForeground }}>{`　${note}`}</Text> : null}
      </Text>
    </View>
  );
}

function InsightRow({ insight, label }: { insight: string; label?: string }) {
  const colors = useColors();
  const body = useBodyTextStyle();
  const tone = resolveActivityToneTokens('active', colors);
  return (
    <View style={[styles.accentBar, { borderLeftColor: tone.tint }]}>
      <Text style={[body, { color: colors.foreground, fontWeight: fontWeight.medium }]}>
        {label ? <Text style={{ color: tone.ink }}>{`${label}：`}</Text> : null}
        {insight}
      </Text>
    </View>
  );
}

function RiskRow({
  risk,
  text,
  action,
}: {
  risk: 'high' | 'medium';
  text: string;
  action?: string;
}) {
  const colors = useColors();
  const body = useBodyTextStyle();
  const tone = resolveActivityToneTokens(risk === 'high' ? 'danger' : 'warning', colors);
  return (
    <View style={[styles.accentBar, { borderLeftColor: tone.tint, backgroundColor: tone.subtle }]}>
      <Text style={[body, { color: tone.ink, fontWeight: fontWeight.medium }]}>{text}</Text>
      {action ? (
        <Text style={[body, { color: colors.mutedForeground }]}>
          {'建议 · '}
          <Text style={{ color: colors.foreground }}>{action}</Text>
        </Text>
      ) : null}
    </View>
  );
}

function QuoteRow({ quote, source }: { quote: string; source?: string }) {
  const colors = useColors();
  const body = useBodyTextStyle();
  return (
    <View style={[styles.accentBar, { borderLeftColor: colors.border }]}>
      <Text style={[body, { color: colors.mutedForeground }]}>
        {`「${quote}」`}
        {source ? `　出处 ${source}` : ''}
      </Text>
    </View>
  );
}

function OriginalRow({ original, translation }: { original: string; translation?: string }) {
  const colors = useColors();
  const typo = useChatTypography();
  const body = useBodyTextStyle();
  return (
    <View style={styles.stack}>
      <Text style={[body, { color: colors.mutedForeground }]}>{original}</Text>
      {translation ? (
        <View style={styles.iconRow}>
          <Text
            style={[
              typo.meta,
              styles.inlineTag,
              { color: colors.mutedForeground, backgroundColor: colors.muted },
            ]}
          >
            中文摘要
          </Text>
          <Text style={[body, styles.flexText, { color: colors.foreground }]}>{translation}</Text>
        </View>
      ) : null}
    </View>
  );
}

/**
 * 字段网格（demo B11）：客户应当记住的硬字段。值刻意放大加粗、脱离等宽排版——
 * 这是整条摘要里唯一允许「大字」的地方。
 */
function FieldsGrid({ fields }: { fields: ReadonlyArray<{ k: string; v: string }> }) {
  const colors = useColors();
  const typo = useChatTypography();
  return (
    <View style={styles.fieldsGrid}>
      {fields.map((field, index) => (
        <View
          key={`${index}-${field.k}`}
          style={[styles.fieldCell, { borderColor: colors.border, backgroundColor: colors.card }]}
        >
          <Text style={[typo.meta, { color: colors.mutedForeground }]}>{field.k}</Text>
          <Text
            style={[typo.bodySmall, { color: colors.foreground, fontWeight: fontWeight.semibold }]}
          >
            {field.v || '—'}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** 连续缺口/警告行聚合成的橙底色块。 */
function WarnGroup({ header, warns }: { header: string; warns: readonly string[] }) {
  const colors = useColors();
  const typo = useChatTypography();
  const body = useBodyTextStyle();
  const tone = resolveActivityToneTokens('warning', colors);
  return (
    <View style={[styles.warnGroup, { backgroundColor: tone.subtle }]}>
      <Text style={[typo.meta, { color: tone.ink, fontWeight: fontWeight.medium }]}>{header}</Text>
      {warns.map((warn, index) => (
        <View key={`${index}-${warn}`} style={styles.iconRow}>
          <TriangleAlert
            size={ICON}
            color={tone.tint}
            strokeWidth={STROKE}
            style={styles.rowIcon}
          />
          <Text style={[body, styles.flexText, { color: tone.ink }]}>{warn}</Text>
        </View>
      ))}
    </View>
  );
}

function DetailRow({ line }: { line: DetailLine }) {
  const colors = useColors();
  const body = useBodyTextStyle();
  const plainText = (value: string, indent = 0) => (
    <Text style={[body, { color: colors.foreground, paddingLeft: indent * spacing.md }]}>
      {value}
    </Text>
  );

  if (typeof line === 'string') return plainText(line);
  if ('tree' in line) return <KeyValueRow k={line.k} v={line.v} prefix={line.tree} />;
  if ('k' in line) return <KeyValueRow k={line.k} v={line.v} />;
  if ('no' in line)
    return (
      <View style={styles.iconRow}>
        <Text style={[body, { color: colors.mutedForeground }]}>{formatOrdinal(line.no)}</Text>
        <Text style={[body, styles.flexText, { color: colors.foreground }]}>{line.text}</Text>
      </View>
    );
  if ('indent' in line) return plainText(line.text, line.indent);
  if ('section' in line) return <SectionRow section={line.section} />;
  // 正常路径下 warn 行已由 groupDetailLines 聚合为 WarnGroup；这里只兜底直接传单行的调用方
  if ('warn' in line) return <WarnGroup header={DEFAULT_WARN_HEADER} warns={[line.warn]} />;
  if ('insight' in line) return <InsightRow insight={line.insight} label={line.label} />;
  if ('risk' in line) return <RiskRow risk={line.risk} text={line.text} action={line.action} />;
  if ('verdict' in line)
    return <VerdictRow verdict={line.verdict} text={line.text} note={line.note} />;
  if ('quote' in line) return <QuoteRow quote={line.quote} source={line.source} />;
  if ('original' in line)
    return <OriginalRow original={line.original} translation={line.translation} />;
  if ('fields' in line) return <FieldsGrid fields={line.fields} />;
  return null;
}

export function DetailLines({
  lines,
  variant = 'plain',
}: {
  lines: readonly DetailLine[] | undefined;
  variant?: DetailVariant;
}) {
  const colors = useColors();
  const groups = useMemo(() => groupDetailLines(lines ?? []), [lines]);
  if (!groups.length) return null;

  const container =
    variant === 'code'
      ? [styles.codeContainer, { backgroundColor: colors.codeBlockBg }]
      : variant === 'card'
        ? [styles.cardContainer, { borderColor: colors.border, backgroundColor: colors.card }]
        : styles.plainContainer;

  return (
    <VariantContext.Provider value={variant}>
      <View style={container}>
        {groups.map((group, index) => {
          const body =
            group.kind === 'warnGroup' ? (
              <WarnGroup header={group.header} warns={group.warns} />
            ) : (
              <DetailRow line={group.line} />
            );
          return variant === 'card' ? (
            <View
              key={index}
              style={[
                styles.cardRow,
                index > 0 ? { borderTopWidth: StyleSheet.hairlineWidth } : null,
                { borderTopColor: colors.border },
              ]}
            >
              {body}
            </View>
          ) : (
            <View key={index}>{body}</View>
          );
        })}
      </View>
    </VariantContext.Provider>
  );
}

const ICON = 12;
const STROKE = 2;

const styles = StyleSheet.create({
  plainContainer: { gap: spacing.xs },
  codeContainer: {
    gap: 2,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  cardContainer: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  cardRow: { paddingHorizontal: spacing.md, paddingVertical: spacing.xs },
  kvRow: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
  kvLabel: { flexShrink: 0, maxWidth: '40%' },
  kvValue: { flex: 1, minWidth: 0 },
  section: { marginTop: spacing.xs, fontWeight: fontWeight.medium },
  iconRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.xs },
  rowIcon: { marginTop: 3 },
  flexText: { flex: 1, minWidth: 0 },
  accentBar: { borderLeftWidth: 2, paddingLeft: spacing.sm, paddingVertical: 2, gap: 2 },
  stack: { gap: 2 },
  inlineTag: {
    borderRadius: radius.sm,
    paddingHorizontal: spacing.xs,
    overflow: 'hidden',
  },
  fieldsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingVertical: 2 },
  fieldCell: {
    minWidth: '46%',
    flexGrow: 1,
    flexShrink: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  warnGroup: {
    gap: spacing.xs,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
});

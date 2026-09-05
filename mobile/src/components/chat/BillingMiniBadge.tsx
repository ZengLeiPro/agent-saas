/**
 * 积分徽标与明细（对齐 `web/src/components/BillingMiniBadge.tsx`）。
 *
 * 数据面与 Web 同三条接口：`/api/billing/me/summary`、
 * `/api/billing/sessions/:id/summary`、`/api/billing/me/budget`，30s 轮询；
 * 计费未开启或 internal 模式整个徽标隐藏。
 *
 * 纯计算（可见性 / 额度来源 / 文案 / 告警等级 / 进度比例）全部在 shared
 * `billingBadge` 里，本文件只负责取数与呈现。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  authFetch,
  billingAllowanceLabel,
  billingModeLabel,
  budgetBarRatio,
  budgetStatusLabel,
  formatBillingCredits,
  formatBillingCreditsDetailed,
  formatBudgetUsageRatio,
  isBillingBadgeVisible,
  resolveBillingAllowance,
  resolveBillingBadgeTone,
  type BillingAccountSummary,
  type BillingBadgeTone,
  type MyMemberBudget,
  type SessionBillingSummary,
} from '@agent/shared';
import { useColors, spacing, radius, fontScale, fontWeight, type ThemeColors } from '../../theme';
import { EntityIcons, ICON_SIZE, ICON_STROKE } from '../../lib/icons';

const REFRESH_MS = 30_000;

export interface BillingBadgeData {
  summary: BillingAccountSummary | null;
  sessionSummary: SessionBillingSummary | null;
  memberBudget: MyMemberBudget | null;
}

async function loadJson<T>(url: string, key: string): Promise<T | null> {
  const response = await authFetch(url);
  if (!response.ok) return null;
  const body = (await response.json()) as Record<string, unknown>;
  return (body?.[key] as T | undefined) ?? null;
}

/** 30s 轮询三条接口；个人预算独立失败不影响余额徽标（与 Web 拆两个 effect 一致）。 */
export function useBillingBadgeData(sessionId?: string | null): BillingBadgeData {
  const [summary, setSummary] = useState<BillingAccountSummary | null>(null);
  const [sessionSummary, setSessionSummary] = useState<SessionBillingSummary | null>(null);
  const [memberBudget, setMemberBudget] = useState<MyMemberBudget | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [account, session] = await Promise.all([
          loadJson<BillingAccountSummary>('/api/billing/me/summary', 'summary'),
          sessionId
            ? loadJson<SessionBillingSummary>(
                `/api/billing/sessions/${encodeURIComponent(sessionId)}/summary`,
                'summary',
              ).catch(() => null)
            : Promise.resolve(null),
        ]);
        if (cancelled) return;
        setSummary(account);
        setSessionSummary(session);
      } catch {
        if (cancelled) return;
        setSummary(null);
        setSessionSummary(null);
      }
    };
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const budget = await loadJson<MyMemberBudget>('/api/billing/me/budget', 'budget');
        if (!cancelled) setMemberBudget(budget);
      } catch {
        if (!cancelled) setMemberBudget(null);
      }
    };
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return { summary, sessionSummary, memberBudget };
}

function toneColor(tone: BillingBadgeTone, colors: ThemeColors): string {
  if (tone === 'danger') return colors.dangerFamily.ink;
  return tone === 'warn' ? colors.warningFamily.ink : colors.mutedForeground;
}

function statusColor(status: MyMemberBudget['status'], colors: ThemeColors): string {
  if (status === 'over') return colors.dangerFamily.ink;
  if (status === 'warning') return colors.warningFamily.ink;
  if (status === 'attention') return colors.warningFamily.DEFAULT;
  return status === 'normal' ? colors.successFamily.ink : colors.mutedForeground;
}

export function BillingMiniBadgeTrigger({
  data,
  onPress,
}: {
  data: BillingBadgeData;
  onPress: () => void;
}) {
  const colors = useColors();
  const styles = useBadgeStyles(colors);
  const { summary, memberBudget } = data;
  if (!isBillingBadgeVisible(summary) || !summary) return null;

  const tone = resolveBillingBadgeTone(
    summary.lowBalance,
    memberBudget?.status,
    memberBudget?.canStartRun === false,
  );
  const allowance = resolveBillingAllowance(summary, memberBudget);
  return (
    <Pressable
      testID="billing-mini-badge"
      accessibilityRole="button"
      accessibilityLabel={billingAllowanceLabel(allowance.source)}
      onPress={onPress}
      hitSlop={8}
      style={[styles.pill, { backgroundColor: colors.muted }]}
    >
      <EntityIcons.credits
        size={ICON_SIZE.inline}
        color={toneColor(tone, colors)}
        strokeWidth={ICON_STROKE.default}
      />
      <Text style={[styles.pillLabel, { color: toneColor(tone, colors) }]}>
        {formatBillingCredits(allowance.credits)}
      </Text>
    </Pressable>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  const colors = useColors();
  const styles = useBadgeStyles(colors);
  return (
    <View style={styles.statRow}>
      <Text style={[styles.statLabel, { color: colors.mutedForeground }]} numberOfLines={1}>
        {label}
      </Text>
      <Text style={[styles.statValue, { color: colors.foreground }]}>{value}</Text>
    </View>
  );
}

export function BillingDetailOverlay({
  data,
  isAdmin,
  onDismiss,
}: {
  data: BillingBadgeData;
  isAdmin: boolean;
  onDismiss: () => void;
}) {
  const colors = useColors();
  const styles = useBadgeStyles(colors);
  const { summary, sessionSummary, memberBudget } = data;
  const allowance = useMemo(
    () => (summary ? resolveBillingAllowance(summary, memberBudget) : null),
    [summary, memberBudget],
  );
  if (!isBillingBadgeVisible(summary) || !summary || !allowance) return null;

  return (
    <Modal transparent visible animationType="fade" onRequestClose={onDismiss}>
      <Pressable
        testID="billing-detail-backdrop"
        accessibilityLabel="关闭积分详情"
        style={[StyleSheet.absoluteFill, { backgroundColor: colors.overlay }]}
        onPress={onDismiss}
      />
      <View style={styles.cardWrap} pointerEvents="box-none">
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <ScrollView bounces={false}>
            <View style={[styles.heroBox, { backgroundColor: colors.muted }]}>
              <View style={styles.heroHead}>
                <Text style={[styles.heroTitle, { color: colors.foreground }]}>
                  {billingAllowanceLabel(allowance.source)}
                </Text>
                <Text
                  style={[
                    styles.modeTag,
                    { color: colors.mutedForeground, backgroundColor: colors.card },
                  ]}
                >
                  {billingModeLabel(summary.billingMode)}
                </Text>
              </View>
              <View style={styles.heroValueRow}>
                <Text style={[styles.heroValue, { color: colors.foreground }]}>
                  {formatBillingCreditsDetailed(allowance.credits)}
                </Text>
                <Text style={[styles.heroHint, { color: colors.mutedForeground }]}>
                  {allowance.source === 'member' ? '本月可用' : '可用'}
                </Text>
                {summary.lowBalance ? (
                  <Text
                    style={[
                      styles.lowBalance,
                      {
                        color: colors.dangerFamily.ink,
                        backgroundColor: colors.dangerFamily.subtle,
                      },
                    ]}
                  >
                    余额较低
                  </Text>
                ) : null}
              </View>
            </View>

            <View style={styles.section}>
              <View style={styles.statRow}>
                <Text style={[styles.sectionTitle, { color: colors.foreground }]}>我的本月</Text>
                {memberBudget ? (
                  <Text
                    style={[styles.statusText, { color: statusColor(memberBudget.status, colors) }]}
                  >
                    {memberBudget.canStartRun
                      ? `${formatBudgetUsageRatio(memberBudget.usageRatioBps)} · ${budgetStatusLabel(memberBudget.status)}`
                      : '后续动作已停止'}
                  </Text>
                ) : null}
              </View>
              {memberBudget ? (
                <>
                  {memberBudget.monthlyLimitCredits !== null ? (
                    <View style={[styles.barTrack, { backgroundColor: colors.muted }]}>
                      <View
                        style={[
                          styles.barFill,
                          {
                            backgroundColor: statusColor(memberBudget.status, colors),
                            flex: budgetBarRatio(memberBudget.usageRatioBps),
                          },
                        ]}
                      />
                    </View>
                  ) : null}
                  <StatRow
                    label="已结算用量"
                    value={formatBillingCreditsDetailed(memberBudget.monthUsedCredits)}
                  />
                  <StatRow
                    label="我的月度额度"
                    value={
                      memberBudget.monthlyLimitCredits === null
                        ? '未设置'
                        : formatBillingCreditsDetailed(memberBudget.monthlyLimitCredits)
                    }
                  />
                </>
              ) : (
                <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>
                  个人预算数据暂不可用
                </Text>
              )}
            </View>

            {isAdmin ? (
              <View
                style={[styles.section, styles.sectionDivided, { borderTopColor: colors.border }]}
              >
                <Text style={[styles.sectionTitle, { color: colors.foreground }]}>
                  公司共享积分池
                </Text>
                <StatRow
                  label="总余额"
                  value={formatBillingCreditsDetailed(summary.balanceCredits)}
                />
                <StatRow
                  label="组织本月消耗"
                  value={formatBillingCreditsDetailed(summary.currentMonthCreditsUsed)}
                />
              </View>
            ) : null}

            {sessionSummary ? (
              <View
                style={[styles.section, styles.sectionDivided, { borderTopColor: colors.border }]}
              >
                <StatRow
                  label={`当前会话${sessionSummary.childSessionCount ? `（含 ${sessionSummary.childSessionCount} 个子 Agent）` : ''}`}
                  value={formatBillingCreditsDetailed(sessionSummary.creditsUsed)}
                />
              </View>
            ) : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function useBadgeStyles(colors: ThemeColors) {
  return useMemo(
    () =>
      StyleSheet.create({
        pill: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.xs,
          paddingHorizontal: spacing.sm,
          paddingVertical: spacing.xs / 2,
          borderRadius: radius.md,
        },
        pillLabel: { ...fontScale.xs, fontWeight: fontWeight.medium },
        cardWrap: {
          flex: 1,
          alignItems: 'flex-end',
          justifyContent: 'flex-start',
          paddingTop: spacing['4xl'] * 2,
          paddingHorizontal: spacing.md,
        },
        card: {
          width: '100%',
          maxWidth: 360,
          maxHeight: '70%',
          borderRadius: radius['2xl'],
          borderWidth: StyleSheet.hairlineWidth,
          padding: spacing.sm,
        },
        heroBox: {
          borderRadius: radius.xl,
          padding: spacing.md,
          gap: spacing.sm,
        },
        heroHead: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: spacing.sm,
        },
        heroTitle: { ...fontScale.sm, fontWeight: fontWeight.semibold },
        modeTag: {
          ...fontScale.xs2,
          fontWeight: fontWeight.medium,
          paddingHorizontal: spacing.sm,
          paddingVertical: spacing.xs / 2,
          borderRadius: radius.full,
          overflow: 'hidden',
        },
        heroValueRow: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm },
        heroValue: { ...fontScale.xl2, fontWeight: fontWeight.semibold },
        heroHint: { ...fontScale.xs },
        lowBalance: {
          ...fontScale.xs2,
          fontWeight: fontWeight.medium,
          marginLeft: 'auto',
          paddingHorizontal: spacing.sm,
          paddingVertical: spacing.xs / 2,
          borderRadius: radius.full,
          overflow: 'hidden',
        },
        section: { paddingHorizontal: spacing.md, paddingVertical: spacing.md, gap: spacing.sm },
        sectionDivided: { borderTopWidth: StyleSheet.hairlineWidth },
        sectionTitle: { ...fontScale.sm, fontWeight: fontWeight.medium },
        statusText: { ...fontScale.xs2, fontWeight: fontWeight.medium },
        statRow: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: spacing.md,
        },
        statLabel: { ...fontScale.sm, flexShrink: 1 },
        statValue: { ...fontScale.sm, fontVariant: ['tabular-nums'] },
        barTrack: {
          flexDirection: 'row',
          height: 6,
          borderRadius: radius.full,
          overflow: 'hidden',
        },
        barFill: { borderRadius: radius.full },
      }),
    [colors],
  );
}

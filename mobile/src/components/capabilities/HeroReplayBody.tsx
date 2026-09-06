/**
 * Hero 剧本回放（移动端）。
 *
 * 与 Web `ScenarioReplayView` 同一份剧本、同一条投影：消息走 `chat/MessageList`，
 * 人审步骤同样阻断推进，退回同样有下文（不是死按钮）。移动端不渲染右侧企业系统
 * 面板，产物 HTML 仍按既有 Artifact 交付策略处理，不为演示另开预览通道。
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  heroReplayMessages,
  heroReplayStepState,
  type ReplayDecisionMap,
  type ReplayScript,
} from '../../lib/capabilities/heroReplay';
import { MessageList } from '../chat/MessageList';
import { Badge, Button } from '../ui';
import { radius, spacing, typography, useColors } from '../../theme';

export function HeroReplayBody({ script, onClose }: { script: ReplayScript; onClose: () => void }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [stepIndex, setStepIndex] = useState(0);
  const [decisions, setDecisions] = useState<ReplayDecisionMap>({});
  const shouldScrollRef = useRef(true);
  const isNearBottomRef = useRef(true);

  const messages = useMemo(
    () => heroReplayMessages(script, stepIndex, decisions),
    [decisions, script, stepIndex],
  );
  const state = useMemo(
    () => heroReplayStepState(script, stepIndex, decisions),
    [decisions, script, stepIndex],
  );
  const currentStepIndex = stepIndex - 1;

  const next = useCallback(() => {
    if (state.blocked) return;
    setStepIndex((current) => Math.min(state.total, current + 1));
  }, [state.blocked, state.total]);
  const prev = useCallback(() => setStepIndex((current) => Math.max(0, current - 1)), []);
  const reset = useCallback(() => {
    setStepIndex(0);
    setDecisions({});
  }, []);
  const approve = useCallback(() => {
    if (currentStepIndex < 0) return;
    setDecisions((current) => ({ ...current, [currentStepIndex]: 'approved' }));
    setStepIndex((current) => Math.min(state.total, current + 1));
  }, [currentStepIndex, state.total]);
  const reject = useCallback(() => {
    if (currentStepIndex < 0) return;
    setDecisions((current) => ({ ...current, [currentStepIndex]: 'rejected' }));
  }, [currentStepIndex]);
  const reopenReview = useCallback(() => {
    setDecisions((current) => {
      const nextDecisions = { ...current };
      delete nextDecisions[currentStepIndex];
      return nextDecisions;
    });
  }, [currentStepIndex]);

  const close = useCallback(() => {
    reset();
    onClose();
  }, [onClose, reset]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        root: { flex: 1, backgroundColor: colors.background, paddingTop: insets.top },
        header: {
          paddingHorizontal: spacing.lg,
          paddingBottom: spacing.sm,
          gap: spacing.xs,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.border,
        },
        headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
        title: { ...typography.subtitle, color: colors.foreground, flex: 1 },
        approval: {
          marginHorizontal: spacing.lg,
          marginBottom: spacing.sm,
          backgroundColor: colors.warningFamily.subtle,
          borderRadius: radius.lg,
          padding: spacing.md,
          gap: spacing.xs,
        },
        approvalTitle: { ...typography.bodySmall, color: colors.warningFamily.ink },
        approvalText: { ...typography.caption, color: colors.mutedForeground },
        fact: {
          backgroundColor: colors.card,
          borderRadius: radius.md,
          paddingHorizontal: spacing.sm,
          paddingVertical: spacing.xs,
          gap: 2,
        },
        factLabel: { ...typography.meta, color: colors.mutedForeground },
        factValue: { ...typography.caption, color: colors.foreground },
        bar: {
          paddingHorizontal: spacing.lg,
          paddingTop: spacing.sm,
          paddingBottom: spacing.sm + insets.bottom,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: colors.border,
          backgroundColor: colors.card,
          gap: spacing.sm,
        },
        caption: { ...typography.bodySmall, color: colors.foreground },
        progress: { ...typography.meta, color: colors.mutedForeground },
        actions: { flexDirection: 'row', gap: spacing.sm },
        action: { flex: 1 },
      }),
    [colors, insets.bottom, insets.top],
  );

  const rejected = state.decision === 'rejected';
  const nextLabel = state.atEnd ? '演示完成' : state.blocked ? '需先批准' : '下一步';

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <Text style={styles.title} numberOfLines={1}>
            {script.title}
          </Text>
          <Badge
            label={script.mode === 'quick' ? '回放 · 快速体验' : '回放 · 完整闭环'}
            variant="warning"
            size="sm"
          />
          <Button label="退出" variant="ghost" size="sm" onPress={close} testID="replay-exit" />
        </View>
      </View>

      <MessageList
        messages={messages}
        loading={false}
        shouldScrollRef={shouldScrollRef}
        isNearBottomRef={isNearBottomRef}
      />

      {state.approval && state.decision !== 'approved' ? (
        <View style={styles.approval} testID="replay-approval">
          {rejected ? (
            <>
              <Text style={styles.approvalTitle}>已退回修改，未写入业务系统</Text>
              <Text style={styles.approvalText}>
                当前流程停在审核点。重新提交后，仍需再次明确批准。
              </Text>
              <Button
                label="重新提交审核"
                variant="outline"
                size="sm"
                onPress={reopenReview}
                testID="replay-reopen"
              />
            </>
          ) : (
            <>
              <Text style={styles.approvalTitle}>{state.approval.title}</Text>
              <Text style={styles.approvalText}>{state.approval.description}</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <View style={styles.actions}>
                  {state.approval.facts.map((fact) => (
                    <View key={`${fact.label}-${fact.value}`} style={styles.fact}>
                      <Text style={styles.factLabel}>{fact.label}</Text>
                      <Text style={styles.factValue}>{fact.value}</Text>
                    </View>
                  ))}
                </View>
              </ScrollView>
              <View style={styles.actions}>
                <Button
                  label={state.approval.rejectLabel ?? '退回修改'}
                  variant="outline"
                  size="sm"
                  style={styles.action}
                  onPress={reject}
                  testID="replay-reject"
                />
                <Button
                  label={state.approval.approveLabel}
                  variant="primary"
                  size="sm"
                  style={styles.action}
                  onPress={approve}
                  testID="replay-approve"
                />
              </View>
            </>
          )}
        </View>
      ) : null}

      <View style={styles.bar}>
        <Text style={styles.progress}>
          第 {Math.min(stepIndex, state.total)} / {state.total} 步
        </Text>
        <Text style={styles.caption}>{state.caption}</Text>
        <View style={styles.actions}>
          <Button
            label="上一步"
            variant="outline"
            style={styles.action}
            disabled={stepIndex === 0}
            onPress={prev}
            testID="replay-prev"
          />
          <Button
            label={nextLabel}
            variant="primary"
            style={styles.action}
            disabled={state.blocked || state.atEnd}
            onPress={next}
            testID="replay-next"
          />
        </View>
        <Button
          label="重放"
          variant="ghost"
          size="sm"
          disabled={stepIndex === 0 && Object.keys(decisions).length === 0}
          onPress={reset}
          testID="replay-reset"
        />
      </View>
    </View>
  );
}

/**
 * 场景回放全屏页 —— 对齐 Web `scenarios/replay/ScenarioReplayView.tsx` 的核心约束：
 * 回放消息走**与真实会话完全相同**的渲染路径（这里是 `chat/MessageList`），
 * 演示能表达的形态 = 真实会话能表达的形态；剧本只提供数据，不另起一套皮。
 *
 * 剧本有两个来源，优先级从高到低：
 * 1. shared 的手写 Hero 剧本（`shared/src/scenarios/replay/`，与 Web 同一份数据），
 *    由 `HeroReplayBody` 渲染；
 * 2. 目录接口自带的 presentation 章节或按公开业务定义合成的 6 章兜底
 *    （`lib/capabilities/replayScript.ts`），头部常驻「合成场景演示」标识与
 *    limitation 文案，不暗示已连接客户系统。
 *
 * 人审是工作流的一部分：`interaction.kind === 'confirm'` 的章节会阻断「下一步」，
 * 必须点「批准并继续」才推进（Web 回放器同语义）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Modal, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { CatalogScenarioPublic } from '@agent/shared';
import { MessageList } from '../chat/MessageList';
import { Badge, Button } from '../ui';
import { radius, spacing, typography, useColors } from '../../theme';
import {
  buildScenarioReplayScript,
  replayMessagesUpTo,
  replayStepRequiresApproval,
} from '../../lib/capabilities/replayScript';
import { loadHeroReplayScript, type ReplayScript } from '../../lib/capabilities/heroReplay';
import { HeroReplayBody } from './HeroReplayBody';

export interface ScenarioReplayModalProps {
  scenario: CatalogScenarioPublic | null;
  onClose: () => void;
}

export function ScenarioReplayModal({ scenario, onClose }: ScenarioReplayModalProps) {
  const [hero, setHero] = useState<ReplayScript | null>(null);
  const [resolved, setResolved] = useState(false);

  // 场景一变就重新解析：手写剧本命中就用 Hero，未命中回落章节合成。
  useEffect(() => {
    if (!scenario) {
      setHero(null);
      setResolved(false);
      return;
    }
    let cancelled = false;
    setHero(null);
    setResolved(false);
    loadHeroReplayScript(scenario)
      .then((script) => {
        if (cancelled) return;
        setHero(script);
        setResolved(true);
      })
      .catch(() => {
        if (cancelled) return;
        setHero(null);
        setResolved(true);
      });
    return () => {
      cancelled = true;
    };
  }, [scenario]);

  if (!scenario) return null;
  return (
    <Modal visible animationType="slide" onRequestClose={onClose} testID="scenario-replay-modal">
      {!resolved ? (
        <View style={LOADING_STYLES.root}>
          <ActivityIndicator testID="scenario-replay-loading" />
        </View>
      ) : hero ? (
        <HeroReplayBody script={hero} onClose={onClose} />
      ) : (
        <SyntheticReplayBody scenario={scenario} onClose={onClose} />
      )}
    </Modal>
  );
}

const LOADING_STYLES = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

function SyntheticReplayBody({
  scenario,
  onClose,
}: {
  scenario: CatalogScenarioPublic;
  onClose: () => void;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [stepIndex, setStepIndex] = useState(0);
  const [approved, setApproved] = useState<Record<number, boolean>>({});
  const shouldScrollRef = useRef(true);
  const isNearBottomRef = useRef(true);

  const script = useMemo(() => (scenario ? buildScenarioReplayScript(scenario) : null), [scenario]);
  const messages = useMemo(
    () =>
      script
        ? replayMessagesUpTo(script, stepIndex, {
            entryContent: scenario?.launch.entry.content,
          })
        : [],
    [script, stepIndex, scenario],
  );

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
        limitation: { ...typography.meta, color: colors.mutedForeground },
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
        approval: {
          backgroundColor: colors.warningFamily.subtle,
          borderRadius: radius.lg,
          padding: spacing.md,
          gap: spacing.xs,
        },
        approvalText: { ...typography.caption, color: colors.warningFamily.ink },
        actions: { flexDirection: 'row', gap: spacing.sm },
        action: { flex: 1 },
      }),
    [colors, insets.bottom, insets.top],
  );

  const chapter = script?.chapters[stepIndex];
  const needsApproval = script ? replayStepRequiresApproval(script, stepIndex) : false;
  const blocked = needsApproval && !approved[stepIndex];
  const isLast = script ? stepIndex >= script.chapters.length - 1 : true;

  const next = useCallback(() => {
    if (blocked) return;
    setStepIndex((current) =>
      script ? Math.min(current + 1, script.chapters.length - 1) : current,
    );
  }, [blocked, script]);

  const back = useCallback(() => setStepIndex((current) => Math.max(0, current - 1)), []);

  const close = useCallback(() => {
    setStepIndex(0);
    setApproved({});
    onClose();
  }, [onClose]);

  if (!script) return null;

  return (
    <View style={styles.root}>
        <View style={styles.header}>
          <View style={styles.headerRow}>
            <Text style={styles.title} numberOfLines={1}>
              {script.title}
            </Text>
            <Badge label={script.dataLabel} variant="warning" size="sm" />
            <Button label="退出" variant="ghost" size="sm" onPress={close} testID="replay-exit" />
          </View>
          <Text style={styles.limitation}>{script.limitation}</Text>
        </View>

        <MessageList
          messages={messages}
          loading={false}
          shouldScrollRef={shouldScrollRef}
          isNearBottomRef={isNearBottomRef}
        />

        <View style={styles.bar}>
          <Text style={styles.progress}>
            第 {stepIndex + 1} / {script.chapters.length} 步 · {chapter?.title}
          </Text>
          <Text style={styles.caption}>{chapter?.narration}</Text>
          {blocked ? (
            <View style={styles.approval}>
              <Text style={styles.approvalText}>
                这一步需要有权人确认后才会继续，演示同样不跳过人审。
              </Text>
              <Button
                label={chapter?.interaction.label ?? '批准并继续'}
                variant="primary"
                size="sm"
                onPress={() => setApproved((current) => ({ ...current, [stepIndex]: true }))}
                testID="replay-approve"
              />
            </View>
          ) : null}
          <View style={styles.actions}>
            <Button
              label="上一步"
              variant="outline"
              style={styles.action}
              disabled={stepIndex === 0}
              onPress={back}
              testID="replay-prev"
            />
            <Button
              label={isLast ? '演示完成' : (chapter?.interaction.label ?? '下一步')}
              variant="primary"
              style={styles.action}
              disabled={blocked}
              onPress={isLast ? close : next}
              testID="replay-next"
            />
          </View>
      </View>
    </View>
  );
}

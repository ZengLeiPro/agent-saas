/**
 * 空会话推荐卡 —— 对齐 Web `web/src/components/scenarios/EmptyChatRecommendCards.tsx`
 * （v2：三张推荐卡）与 `EmptySessionScenarios.tsx`（v1：起手行）。
 *
 * 数据面：
 * - 开关取自 `GET /api/scenarios/config`（`useRoleKitConfig`），`roleKitV2Enabled`
 *   决定走 v2 推荐卡还是 v1 起手行；
 * - 场景取自 `GET /api/scenarios`（`useScenarioLibrary`）；
 * - 排序、岗位匹配、动作文案全部走 shared 纯函数（`pickRoleTopScenarios` /
 *   `pickRecommendedScenarios` / `matchRoleIdByPosition` / `resolveScenarioActionMeta`），
 *   与 Web 同一套规则，不在原生侧另写打分。
 *
 * 与 Web 的差异（有意）：原生端暂无能力中心，因此不渲染「查看全部能力」入口。
 */
import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { ScenarioItem } from '@agent/shared';
import {
  RECOMMENDATION_COUNT,
  buildScenarioPrompt,
  matchRoleIdByPosition,
  pickRecommendedScenarios,
  pickRoleTopScenarios,
  resolveScenarioActionMeta,
  sanitizeScenario,
} from '@agent/shared';
import { useAuth } from '../../contexts/AuthContext';
import { useRoleKitConfig } from '../../hooks/useRoleKitConfig';
import { useScenarioLibrary } from '../../hooks/useScenarioLibrary';
import { SuggestionCard } from './SuggestionCard';
import { useColors, spacing, typography } from '../../theme';

export interface EmptyChatRecommendCardsProps {
  /** 点卡片：把起手指令预填进输入框（与 Web `onTryScenario` 同语义） */
  onTryScenario: (prompt: string, scenario: ScenarioItem) => void;
}

/** v1 起手行的动作文案固定为「预填任务」，与 Web `EmptySessionScenarios` 一致。 */
const V1_ACTION = { label: '预填任务', tone: 'muted' } as const;

function safeScenario(scenario: ScenarioItem): ScenarioItem {
  return sanitizeScenario({ ...scenario }).scenario as ScenarioItem;
}

export function EmptyChatRecommendCards({ onTryScenario }: EmptyChatRecommendCardsProps) {
  const colors = useColors();
  const { user } = useAuth();
  const { config, loading: configLoading } = useRoleKitConfig();
  const { library, loading, error } = useScenarioLibrary();

  const styles = useMemo(
    () =>
      StyleSheet.create({
        wrap: { paddingHorizontal: spacing.md, paddingTop: spacing.lg, gap: spacing.sm },
        heading: {
          ...typography.meta,
          color: colors.mutedForeground,
          fontWeight: '500',
          marginBottom: spacing.xs,
        },
      }),
    [colors],
  );

  const cards = useMemo(() => {
    if (!library || library.scenarios.length === 0) return [];
    const preferredRoleId =
      user?.preferences?.activeRoleId &&
      library.roles.some((role) => role.id === user.preferences?.activeRoleId)
        ? user.preferences.activeRoleId
        : matchRoleIdByPosition(library.roles, user?.position);
    const picked = config.roleKitV2Enabled
      ? pickRoleTopScenarios(library.scenarios, preferredRoleId, RECOMMENDATION_COUNT)
      : pickRecommendedScenarios(library.scenarios, RECOMMENDATION_COUNT, preferredRoleId);
    return picked.slice(0, RECOMMENDATION_COUNT).map(safeScenario);
  }, [library, config.roleKitV2Enabled, user?.preferences?.activeRoleId, user?.position]);

  if (loading || configLoading || error || cards.length === 0) return null;

  return (
    <View style={styles.wrap} testID="empty-chat-recommend-cards">
      <Text style={styles.heading}>{config.roleKitV2Enabled ? '为你推荐' : '常用起手任务'}</Text>
      {cards.map((scenario) => {
        const meta = config.roleKitV2Enabled ? resolveScenarioActionMeta(scenario) : V1_ACTION;
        return (
          <SuggestionCard
            key={scenario.id}
            testID={`scenario-card-${scenario.id}`}
            title={scenario.title}
            action={meta.label}
            tone={meta.tone}
            onPress={() => onTryScenario(buildScenarioPrompt(scenario), scenario)}
          />
        );
      })}
    </View>
  );
}

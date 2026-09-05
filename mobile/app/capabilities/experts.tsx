/**
 * 能力中心 · 专家 —— 对齐 Web `CapabilityCenter/index.tsx` 专家页：
 * 「我的企业专家」由组织为你配置，可以直接开始对话。
 *
 * 数据来源与 Web 一致：`GET /api/org-agents/mine` 的 Agent 目标目录
 * （`agentTargetCatalog.orgAgents`），「开始对话」走既有 Agent 目标切换流程。
 */
import React, { useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { CapabilityTabBar } from '../../src/components/capabilities/CapabilityTabBar';
import { ExpertCard } from '../../src/components/capabilities/ExpertCard';
import { EmptyState, Input } from '../../src/components/ui';
import { EntityIcons } from '../../src/lib/icons';
import { useCapabilityContext } from '../../src/hooks/useCapabilityContext';
import { spacing, typography, useColors } from '../../src/theme';

export default function CapabilityExpertsScreen() {
  const colors = useColors();
  const { personalAgentEnabled, experts, catalogLoading, startExpertConversation } =
    useCapabilityContext();
  const [query, setQuery] = useState('');

  const styles = useMemo(
    () =>
      StyleSheet.create({
        root: { flex: 1, backgroundColor: colors.background },
        content: { padding: spacing.lg, gap: spacing.md },
        heading: { ...typography.heading, color: colors.foreground },
        description: { ...typography.caption, color: colors.mutedForeground },
        center: { paddingVertical: spacing['4xl'], alignItems: 'center' },
      }),
    [colors],
  );

  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return experts;
    return experts.filter((expert) =>
      [expert.name, expert.description, ...expert.starterPrompts].some((value) =>
        value.toLocaleLowerCase().includes(normalized),
      ),
    );
  }, [experts, query]);

  return (
    <View style={styles.root}>
      <CapabilityTabBar active="experts" personalAgentEnabled={personalAgentEnabled} />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.heading}>我的企业专家</Text>
        <Text style={styles.description}>
          由组织为你配置，可以直接开始对话。当前共 {experts.length} 位专家。
        </Text>
        {experts.length > 0 ? (
          <Input
            value={query}
            onChangeText={setQuery}
            placeholder="搜索专家名称、职责或示例问题"
            testID="capability-expert-search"
          />
        ) : null}

        {catalogLoading && experts.length === 0 ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : experts.length === 0 ? (
          <EmptyState icon={EntityIcons.expert} title="当前没有指派给你的企业专家" />
        ) : filtered.length === 0 ? (
          <EmptyState icon={EntityIcons.expert} title="没有找到匹配的企业专家" />
        ) : (
          filtered.map((expert) => (
            <ExpertCard
              key={expert.id}
              expert={expert}
              onStart={startExpertConversation}
              testID={`expert-card-${expert.id}`}
            />
          ))
        )}
      </ScrollView>
    </View>
  );
}

/**
 * 能力中心 · 工作流 —— 对齐 Web `scenarios/ScenariosPanel.tsx`：
 * 行业 + 垂直行业 + 岗位筛选 → 目录卡 → 详情（BottomSheet）→ 回放（全屏）。
 *
 * 目录版本按 `useWorkflowCatalog` 决定（v3 / legacy / legacy-fallback），
 * 深链 `?workflow=<id>&intent=<view|run|connect|presentation>` 与 Web 同语义：
 * 只消费一次，run 直接开会话、presentation 直接进回放、其余停在详情。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Redirect, useLocalSearchParams } from 'expo-router';
import type { CatalogScenarioPublic } from '@agent/shared';
import { resolveScenarioSlug } from '@agent/shared';
import { CapabilityTabBar } from '../../src/components/capabilities/CapabilityTabBar';
import {
  ScenarioDetailSheet,
  type WorkflowDetailAction,
} from '../../src/components/capabilities/ScenarioDetailSheet';
import { ScenarioReplayModal } from '../../src/components/capabilities/ScenarioReplayModal';
import { WorkflowCard } from '../../src/components/capabilities/WorkflowCard';
import { WorkflowFilterBar } from '../../src/components/capabilities/WorkflowFilterBar';
import { EmptyState } from '../../src/components/ui';
import { EntityIcons } from '../../src/lib/icons';
import { useCapabilityContext } from '../../src/hooks/useCapabilityContext';
import { useWorkflowCatalog } from '../../src/hooks/useWorkflowCatalog';
import {
  EMPTY_WORKFLOW_FILTERS,
  filterWorkflowScenarios,
  isHookScenario,
  verticalOptionsFor,
  type WorkflowFilterState,
} from '../../src/lib/capabilities/workflowFilters';
import {
  workflowDiagnosisMessage,
  workflowTrialMessage,
} from '../../src/lib/capabilities/workflowLaunch';
import { spacing, typography, useColors } from '../../src/theme';

export default function CapabilityWorkflowsScreen() {
  const colors = useColors();
  const params = useLocalSearchParams<{ workflow?: string; intent?: string }>();
  const { personalAgentEnabled, startPersonalConversation } = useCapabilityContext();
  const catalog = useWorkflowCatalog();
  const [filters, setFilters] = useState<WorkflowFilterState>(EMPTY_WORKFLOW_FILTERS);
  const [detail, setDetail] = useState<CatalogScenarioPublic | null>(null);
  const [replay, setReplay] = useState<CatalogScenarioPublic | null>(null);
  const [deferredNotice, setDeferredNotice] = useState<string | null>(null);
  const deepLinkConsumed = useRef(false);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        root: { flex: 1, backgroundColor: colors.background },
        content: { padding: spacing.lg, gap: spacing.md },
        heading: { ...typography.heading, color: colors.foreground },
        description: { ...typography.caption, color: colors.mutedForeground },
        notice: { ...typography.caption, color: colors.warningFamily.ink },
        center: { paddingVertical: spacing['4xl'], alignItems: 'center' },
      }),
    [colors],
  );

  const library = catalog.workflowLibrary;
  const roles = useMemo(() => library?.roles ?? [], [library]);
  const roleLabels = useMemo(
    () => Object.fromEntries(roles.map((role) => [role.id, role.name])),
    [roles],
  );
  const catalogScenarios = useMemo(
    () => (library?.scenarios ?? []).filter((scenario) => !isHookScenario(scenario)),
    [library],
  );
  const scenarios = useMemo(
    () => filterWorkflowScenarios(catalogScenarios, filters),
    [catalogScenarios, filters],
  );
  const verticalOptions = useMemo(
    () => verticalOptionsFor(catalogScenarios, filters.industry),
    [catalogScenarios, filters.industry],
  );

  const handleAction = useCallback(
    (action: WorkflowDetailAction, scenario: CatalogScenarioPublic) => {
      if (action === 'presentation') {
        setDetail(null);
        setReplay(scenario);
        return;
      }
      if (action === 'chat') {
        setDetail(null);
        startPersonalConversation(workflowTrialMessage(scenario));
        return;
      }
      if (action === 'diagnosis') {
        setDetail(null);
        startPersonalConversation(workflowDiagnosisMessage(scenario));
        return;
      }
      // connector：与 Web 一致，把用户引到连接器目录去接自己的系统
      setDetail(scenario);
    },
    [startPersonalConversation],
  );

  // 深链只消费一次（与 Web `deepLinkConsumed` 同语义）
  useEffect(() => {
    if (!library || deepLinkConsumed.current) return;
    const slug = params.workflow;
    if (!slug) return;
    deepLinkConsumed.current = true;
    const resolved = resolveScenarioSlug(library, slug);
    if (!resolved) return;
    if (resolved.resolution === 'deferred') {
      setDeferredNotice(resolved.deferredObject.reason);
      if (resolved.roleId) setFilters((current) => ({ ...current, role: resolved.roleId! }));
      return;
    }
    if (resolved.roleId) setFilters((current) => ({ ...current, role: resolved.roleId! }));
    if (params.intent === 'presentation') {
      setReplay(resolved.scenario);
      return;
    }
    if (params.intent === 'run' && resolved.scenario.launch.startMode === 'chat') {
      startPersonalConversation(workflowTrialMessage(resolved.scenario));
      return;
    }
    setDetail(resolved.scenario);
  }, [library, params.workflow, params.intent, startPersonalConversation]);

  // 未开放个人通用 Agent 的租户没有工作流目录（Web `showTemplates=false`），
  // 直接落回专家 Tab，而不是渲染一个空壳。
  if (!personalAgentEnabled) return <Redirect href="/capabilities/experts" />;

  return (
    <View style={styles.root}>
      <CapabilityTabBar active="workflows" personalAgentEnabled={personalAgentEnabled} />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.heading}>AI 同事能做的事</Text>
        <Text style={styles.description}>按目标或岗位挑一个，先看演示，再实际融入你的工作流</Text>
        {catalog.fallbackReason ? (
          <Text style={styles.notice}>{catalog.fallbackReason}</Text>
        ) : null}
        {deferredNotice ? <Text style={styles.notice}>{deferredNotice}</Text> : null}

        {catalog.loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : catalog.error || !library ? (
          <EmptyState
            icon={EntityIcons.workflow}
            title="AI 同事工作流暂时不可用"
            description={catalog.error ?? '工作流目录加载失败，请稍后重试。'}
            actionLabel="重试"
            onAction={catalog.reload}
          />
        ) : (
          <>
            <WorkflowFilterBar
              filters={filters}
              verticalOptions={verticalOptions}
              roleOptions={roles}
              onChange={setFilters}
            />
            {scenarios.length === 0 ? (
              <EmptyState
                icon={EntityIcons.workflow}
                title="没有符合筛选条件的工作流"
                description="换一个行业或岗位试试。"
                actionLabel="清除筛选"
                onAction={() => setFilters(EMPTY_WORKFLOW_FILTERS)}
              />
            ) : (
              scenarios.map((scenario) => (
                <WorkflowCard
                  key={scenario.id}
                  scenario={scenario}
                  roleLabels={roleLabels}
                  onOpenDetail={setDetail}
                  onReplay={setReplay}
                  onTry={(item) => handleAction('chat', item)}
                  testID={`workflow-card-${scenario.id}`}
                />
              ))
            )}
          </>
        )}
      </ScrollView>

      <ScenarioDetailSheet
        scenario={detail}
        roleLabels={roleLabels}
        onClose={() => setDetail(null)}
        onAction={handleAction}
      />
      <ScenarioReplayModal scenario={replay} onClose={() => setReplay(null)} />
    </View>
  );
}

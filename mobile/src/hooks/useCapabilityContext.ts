/**
 * 能力中心的会话上下文桥接。
 *
 * `personalAgentEnabled` 的判定来源与 Web `App.tsx` 完全一致：
 * `agentTargetCatalog.personal.availability.status === 'available'`，
 * 不在 UI 侧另行推断；专家列表同样直接取目录里的 `orgAgents`。
 *
 * 「开始对话 / 试一试」一律走既有 Agent 目标切换流程
 * （`resolveTargetSessionAction` + `startAgentTargetSession`），
 * 不新增第二条新建会话路径。
 */
import { useCallback, useMemo } from 'react';
import { Alert } from 'react-native';
import { useRouter } from 'expo-router';
import type { AgentTarget, OrgAgentSummary } from '@agent/shared';
import { resolveTargetSessionAction } from '@agent/shared';
import { useChatAppState } from '../contexts/ChatAppStateContext';

export interface CapabilityContext {
  personalAgentEnabled: boolean;
  experts: OrgAgentSummary[];
  catalogLoading: boolean;
  /** 以企业专家身份开新会话 */
  startExpertConversation: (expertId: string) => void;
  /** 以个人通用 Agent 开新会话并预填起手消息 */
  startPersonalConversation: (prompt: string) => void;
}

export function useCapabilityContext(): CapabilityContext {
  const chat = useChatAppState();
  const router = useRouter();
  const catalog = chat.agentTargetCatalog;

  const personalAgentEnabled = catalog?.personal.availability.status === 'available';

  const experts = useMemo(
    () =>
      (catalog?.orgAgents ?? [])
        .map((option) => option.presentation)
        .filter((presentation): presentation is OrgAgentSummary => Boolean(presentation)),
    [catalog],
  );

  const launch = useCallback(
    (target: AgentTarget, prompt?: string) => {
      const action = resolveTargetSessionAction({ target, current: null });
      if (action.kind !== 'new-session') return;
      chat.startAgentTargetSession(action.target);
      if (prompt) chat.setInput(prompt);
      router.push('/chat/new');
    },
    [chat, router],
  );

  const startExpertConversation = useCallback(
    (expertId: string) => {
      if (!catalog) {
        Alert.alert(
          '无法开始对话',
          chat.agentTargetCatalogReason?.message ?? 'Agent 目录仍在加载，请稍后重试。',
        );
        return;
      }
      const option = catalog.orgAgents.find(
        (item) => item.target.kind === 'org-agent' && item.target.orgAgentId === expertId,
      );
      if (!option) {
        Alert.alert('无法开始对话', '该企业专家已不在你的可用目录中。');
        return;
      }
      if (option.availability.status !== 'available') {
        Alert.alert('该专家当前不可用', option.availability.reason.message);
        return;
      }
      launch(option.target);
    },
    [catalog, chat.agentTargetCatalogReason, launch],
  );

  const startPersonalConversation = useCallback(
    (prompt: string) => {
      if (!catalog || catalog.personal.availability.status !== 'available') {
        Alert.alert(
          '无法开始对话',
          catalog?.personal.availability.status === 'unavailable'
            ? catalog.personal.availability.reason.message
            : (chat.agentTargetCatalogReason?.message ?? 'Agent 目录仍在加载，请稍后重试。'),
        );
        return;
      }
      launch(catalog.personal.target, prompt);
    },
    [catalog, chat.agentTargetCatalogReason, launch],
  );

  return {
    personalAgentEnabled,
    experts,
    catalogLoading: chat.agentTargetCatalogLoading,
    startExpertConversation,
    startPersonalConversation,
  };
}

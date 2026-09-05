/**
 * 「新建会话」入口 —— 从 `(tabs)/chat/index.tsx` 抽出，行为不变。
 *
 * 身份边界不变量：管理员「全部用户」视图不混入个人 Agent 选择器；
 * 目标选择一律走 shared 的 `resolveNewSessionAgentTarget` /
 * `resolveTargetSessionAction`，不在 UI 侧推断。
 */
import { useCallback } from 'react';
import { Alert } from 'react-native';
import type { AgentTarget } from '@agent/shared';
import { resolveNewSessionAgentTarget, resolveTargetSessionAction } from '@agent/shared';
import type { ChatAppState } from '../../hooks/useChatAppState';
import { hapticLight } from '../../lib/haptics';

export function useNewSessionLauncher(options: {
  chat: ChatAppState;
  isAdminUser: boolean;
  onNavigate: (path: string) => void;
}): () => void {
  const { chat, isAdminUser, onNavigate } = options;

  return useCallback(() => {
    hapticLight();
    if (isAdminUser && chat.ownerFilter === null) {
      Alert.alert('无法新建会话', '管理员全部用户视图不混入个人 Agent 选择器，请先选择具体用户。');
      return;
    }
    if (!chat.agentTargetCatalog) {
      Alert.alert(
        '无法新建会话',
        chat.agentTargetCatalogReason?.message ?? 'Agent 目录仍在加载，请稍后重试。',
      );
      return;
    }
    const selection = resolveNewSessionAgentTarget({
      catalog: chat.agentTargetCatalog,
      activeTarget: chat.activeAgentTarget,
    });
    const launch = (target: AgentTarget) => {
      const action = resolveTargetSessionAction({ target, current: null });
      if (action.kind !== 'new-session') return;
      chat.startAgentTargetSession(action.target);
      onNavigate('/chat/new');
    };
    if (selection.kind === 'selected') {
      launch(selection.target);
      return;
    }
    if (selection.kind === 'unavailable') {
      Alert.alert('暂无可用 Agent', selection.reason.message);
      return;
    }
    const buttons = selection.options.flatMap((target) => {
      if (target.kind !== 'org-agent') return [];
      const option = chat.agentTargetCatalog?.orgAgents.find(
        (candidate) =>
          candidate.target.kind === 'org-agent' &&
          candidate.target.orgAgentId === target.orgAgentId,
      );
      return [{ text: option?.presentation?.name ?? '企业专家', onPress: () => launch(target) }];
    });
    Alert.alert('选择企业专家', '当前组织未开放个人通用 Agent，请选择要开始对话的企业专家。', [
      ...buttons,
      { text: '取消', style: 'cancel' },
    ]);
  }, [chat, isAdminUser, onNavigate]);
}

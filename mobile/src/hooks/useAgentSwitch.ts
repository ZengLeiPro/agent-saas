import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert } from 'react-native';
import {
  evaluateAgentTargetTransition,
  type AgentTarget,
  type AgentTargetTransitionImpact,
  type ApiSessionListItem,
} from '@agent/shared';
import { useChatAppState } from '../contexts/ChatAppStateContext';
import { agentTargetLabel } from '../lib/agentTargetPresentation';

/**
 * Agent 切换编排：目标选择 → shared 决策 → 确认 → 取消活动 → 开新会话。
 *
 * 决策全部来自 shared `evaluateAgentTargetTransition`（阻断/复用/直开/需确认），
 * 本 hook 只负责把决策接到移动端的 sheet 与导航上，不重新判定可用性。
 */

const ACTIVE_QUEUE_STATUS = ['queued', 'running', 'cancel_pending'];

export interface AgentSwitchConfirmationState {
  target: AgentTarget;
  targetName: string;
  impacts: AgentTargetTransitionImpact[];
}

export interface UseAgentSwitchResult {
  pickerVisible: boolean;
  openPicker: () => void;
  closePicker: () => void;
  requestAgentSwitch: (target: AgentTarget) => void;
  confirmation: AgentSwitchConfirmationState | null;
  cancelling: boolean;
  cancelError: string | null;
  keepOldOpen: () => void;
  cancelActive: () => void;
  dismissConfirmation: () => void;
}

export function useAgentSwitch(input: {
  sessionId: string | null;
  currentSession?: ApiSessionListItem;
  /** 切到新目标后的导航动作（会话页里是 `router.replace('/chat/new')`）。 */
  onLaunchNewSession: () => void;
}): UseAgentSwitchResult {
  const { sessionId, currentSession, onLaunchNewSession } = input;
  const chat = useChatAppState();
  const [pickerVisible, setPickerVisible] = useState(false);
  const [confirmation, setConfirmation] = useState<AgentSwitchConfirmationState | null>(null);
  const [pendingAgentSwitch, setPendingAgentSwitch] = useState<AgentTarget | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const launchAgentSwitch = useCallback(
    (target: AgentTarget) => {
      chat.startAgentTargetSession(target);
      onLaunchNewSession();
    },
    [chat.startAgentTargetSession, onLaunchNewSession],
  ); // 依赖故意收窄（react-hooks/exhaustive-deps 在本仓库未启用）

  const findOption = useCallback(
    (target: AgentTarget) =>
      target.kind === 'personal'
        ? chat.agentTargetCatalog?.personal
        : chat.agentTargetCatalog?.orgAgents.find(
            (candidate) =>
              candidate.target.kind === 'org-agent' &&
              candidate.target.orgAgentId === target.orgAgentId,
          ),
    [chat.agentTargetCatalog],
  );

  const requestAgentSwitch = useCallback(
    (target: AgentTarget) => {
      const option = findOption(target);
      const queueItems = chat.chatQueueItems.filter(
        (item) => item.sessionId === sessionId && ACTIVE_QUEUE_STATUS.includes(item.status),
      );
      const decision = evaluateAgentTargetTransition({
        currentSession:
          sessionId && currentSession?.agentTarget
            ? {
                sessionId,
                target: currentSession.agentTarget,
                bindingVersion: currentSession.agentTargetBindingVersion ?? 0,
              }
            : null,
        requestedTarget: target,
        runLiveness: chat.loading
          ? { state: 'active', recoveryActions: ['cancel'], version: 1 }
          : { state: 'terminal', recoveryActions: [], version: 1 },
        queueSnapshot:
          sessionId && queueItems.length
            ? {
                version: 1,
                sessionId,
                generatedAt: new Date().toISOString(),
                items: queueItems,
              }
            : null,
        pendingInteraction: currentSession?.activeInteraction ?? null,
        availability: option?.availability ?? {
          status: 'unavailable',
          reason: {
            code: 'no_available_target',
            message: '该 Agent 当前不可用',
            contactAdmin: true,
          },
        },
        generation: 1,
        availabilityVersion: currentSession?.agentTargetSnapshot?.version ?? 1,
      });
      if (decision.kind === 'blocked') {
        Alert.alert('无法切换 Agent', decision.reason.message);
        return;
      }
      if (decision.kind === 'reuse') {
        chat.selectSession(decision.sessionId);
        return;
      }
      if (decision.kind === 'new-session') {
        launchAgentSwitch(decision.target);
        return;
      }
      setCancelError(null);
      setConfirmation({
        target: decision.target,
        targetName: option ? agentTargetLabel(option) : '该 Agent',
        impacts: decision.impacts,
      });
    },
    [chat, currentSession, findOption, launchAgentSwitch, sessionId],
  );

  const keepOldOpen = useCallback(() => {
    const target = confirmation?.target;
    setConfirmation(null);
    if (target) launchAgentSwitch(target);
  }, [confirmation, launchAgentSwitch]);

  const cancelActive = useCallback(() => {
    const target = confirmation?.target;
    if (!target) return;
    setPendingAgentSwitch(target);
    setCancelError(null);
    chat.stopGeneration();
    void chat.cancelAgentSwitchQueue().then((ok) => {
      if (ok) return;
      setPendingAgentSwitch(null);
      setCancelError('服务端未确认排队消息取消，请重试。');
    });
  }, [chat.cancelAgentSwitchQueue, chat.stopGeneration, confirmation]); // 依赖故意收窄（react-hooks/exhaustive-deps 在本仓库未启用）

  // 取消动作是异步的：等 loading / 队列 / 待处理交互都清空后再真正开新会话。
  useEffect(() => {
    if (!pendingAgentSwitch) return;
    const activeQueue = chat.chatQueueItems.some(
      (item) => item.sessionId === sessionId && ACTIVE_QUEUE_STATUS.includes(item.status),
    );
    if (chat.loading || activeQueue || currentSession?.activeInteraction) return;
    const target = pendingAgentSwitch;
    setPendingAgentSwitch(null);
    setConfirmation(null);
    launchAgentSwitch(target);
  }, [
    chat.chatQueueItems,
    chat.loading,
    currentSession?.activeInteraction,
    launchAgentSwitch,
    pendingAgentSwitch,
    sessionId,
  ]);

  return useMemo(
    () => ({
      pickerVisible,
      openPicker: () => setPickerVisible(true),
      closePicker: () => setPickerVisible(false),
      requestAgentSwitch,
      confirmation,
      cancelling: pendingAgentSwitch !== null,
      cancelError,
      keepOldOpen,
      cancelActive,
      dismissConfirmation: () => setConfirmation(null),
    }),
    [
      pickerVisible,
      requestAgentSwitch,
      confirmation,
      pendingAgentSwitch,
      cancelError,
      keepOldOpen,
      cancelActive,
    ],
  );
}

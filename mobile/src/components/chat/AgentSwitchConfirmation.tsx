/**
 * Agent 切换确认（对齐 `web/src/components/AgentSwitchConfirmationDialog.tsx`）。
 *
 * 触发条件与影响项完全来自 shared `evaluateAgentTargetTransition` 的
 * `needs-confirmation` 决策，客户端不自行判断「有没有活儿在跑」。
 */
import React, { useMemo } from 'react';
import type { AgentTargetTransitionImpact } from '@agent/shared';
import { ActionSheet, type ActionMenuItem } from '../ui';

export interface AgentSwitchConfirmationProps {
  visible: boolean;
  targetName: string;
  impacts: AgentTargetTransitionImpact[];
  /** 服务端尚未确认取消排队时为真：两个动作都禁用，标题改为等待文案。 */
  cancelling?: boolean;
  cancelError?: string | null;
  onKeepOldOpen: () => void;
  onCancelActive: () => void;
  onClose: () => void;
}

/** 与 Web `impactText` 逐字一致。 */
export function describeAgentSwitchImpacts(impacts: AgentTargetTransitionImpact[]): string[] {
  return impacts.map((impact) => {
    if (impact.kind === 'running') {
      return `当前任务仍在${impact.liveness === 'waiting_interaction' ? '等待交互' : '运行'}`;
    }
    if (impact.kind === 'queued') return `${impact.count} 条消息仍在排队`;
    return '有一项待处理交互';
  });
}

export function AgentSwitchConfirmation({
  visible,
  targetName,
  impacts,
  cancelling,
  cancelError,
  onKeepOldOpen,
  onCancelActive,
  onClose,
}: AgentSwitchConfirmationProps) {
  const message = useMemo(() => {
    const detail = describeAgentSwitchImpacts(impacts).join('；');
    const head = detail
      ? `当前会话仍有运行中、排队中或待处理交互：${detail}。`
      : '当前会话仍有运行中、排队中或待处理交互。';
    const body = '不同 Agent 必须开启新会话，当前会话不会改绑，草稿和附件会保留。';
    return cancelError ? `${head}${body}\n取消失败：${cancelError}` : `${head}${body}`;
  }, [impacts, cancelError]);

  const actions = useMemo<ActionMenuItem[]>(
    () => [
      { label: '保留旧会话运行并切换', disabled: cancelling, onPress: onKeepOldOpen },
      {
        label: cancelling ? '等待服务端确认取消…' : '取消进行中任务后切换',
        destructive: true,
        disabled: cancelling,
        onPress: onCancelActive,
      },
    ],
    [cancelling, onKeepOldOpen, onCancelActive],
  );

  return (
    <ActionSheet
      testID="agent-switch-confirmation"
      visible={visible}
      onClose={onClose}
      title={`切换到 ${targetName}？`}
      message={message}
      actions={actions}
      cancelText="暂不切换"
    />
  );
}

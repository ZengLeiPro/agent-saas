import type { RuntimeFailureKind, RuntimeRecoveryAction } from '../../types/index.js';

type SubagentLifecycleEventBase = {
  id: string;
  timestamp: string;
  runId: string;
  sessionId: string;
  toolCallId: string;
  agentType: string;
  description: string;
  childSessionId: string;
  childRunId: string;
  /** 跨多次物理 run 稳定的逻辑子 Agent 标识；存量事件可缺失。 */
  agentId?: string;
  effort?: string;
};

export type SubagentStartedPlatformEvent = SubagentLifecycleEventBase & {
  type: 'subagent_started';
  model: string;
};

export type SubagentFinishedPlatformEvent = SubagentLifecycleEventBase & {
  type: 'subagent_finished';
  model?: string;
  status: 'completed' | 'failed' | 'cancelled' | 'timeout';
  totalTokens: number;
  toolUseCount: number;
  /** 存量事件可能缺失；新事件始终写入。 */
  turnCount?: number;
  durationMs: number;
  errorMessage?: string;
  failureKind?: RuntimeFailureKind;
  recoveryAction?: RuntimeRecoveryAction;
  resultPreview?: string;
};

export type SubagentLifecyclePlatformEvent =
  SubagentStartedPlatformEvent | SubagentFinishedPlatformEvent;

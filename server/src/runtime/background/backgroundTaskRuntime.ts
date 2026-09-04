import type { ToolCallContext } from '../../agent/toolRuntime.js';
import type { RunRecord } from '../runStore.js';

export const BACKGROUND_COMMAND_MONITOR_HANDOFF_REASON = 'background_command_monitor_handoff';

export interface BackgroundTaskLease {
  workerId?: string;
  leaseToken?: string;
  renew(): Promise<void>;
  handoff?(reason: string, metadataPatch?: Record<string, unknown>): Promise<void>;
  release(finalStatus?: import('../runStore.js').RunStatus, reason?: string): Promise<void>;
}

export interface BackgroundAgentRequest {
  description: string;
  prompt: string;
  agentType: 'general' | 'explore';
  model?: string;
  includeCompanyInfo: boolean;
}

export interface BackgroundTaskStartResult {
  taskId: string;
  shortTaskId: string;
  status: 'pending';
  description: string;
  model: string;
}

export interface BackgroundCommandRequest {
  command: string;
  timeoutMs: number;
}

export interface BackgroundCommandReservation {
  taskId: string;
  status: 'starting';
}

/**
 * BackgroundTask(action=output) 的入参（2026-08-03 工具面收敛批次）：
 * 后台命令增量续读，语义与 hand 端 BashOutput 协议一一对应。
 */
export interface BackgroundCommandOutputRequest {
  taskId: string;
  stdoutOffset?: number;
  stderrOffset?: number;
  limitBytes?: number;
  waitMs?: number;
}

export interface BackgroundTaskRuntime {
  enqueue(context: ToolCallContext, request: BackgroundAgentRequest): Promise<BackgroundTaskStartResult>;
  reserveCommand(context: ToolCallContext, request: BackgroundCommandRequest): Promise<BackgroundCommandReservation>;
  activateCommand(context: ToolCallContext, taskId: string): Promise<void>;
  failCommandStart(context: ToolCallContext, taskId: string, message: string): Promise<void>;
  handoffCommandMonitor(record: RunRecord): void;
  execute(record: RunRecord, lease?: BackgroundTaskLease): Promise<void>;
  failInterrupted(record: RunRecord): Promise<void>;
  fail(record: RunRecord, message: string, reason?: string): Promise<void>;
  reconcileWakeDeliveries(): Promise<void>;
  list(context: ToolCallContext, limit?: number): Promise<RunRecord[]>;
  get(context: ToolCallContext, taskId: string): Promise<RunRecord | null>;
  cancel(context: ToolCallContext, taskId: string): Promise<RunRecord>;
  /**
   * 运行中后台命令的增量输出续读（内部按 hand 协议名 BashOutput 透传，ACS 零改动）。
   * 仅对 taskType=command 且未进终态的任务有效；其余情况抛出带引导的错误。
   */
  readCommandOutput(context: ToolCallContext, request: BackgroundCommandOutputRequest): Promise<{ content: string }>;
}

export function isBackgroundTaskRun(record: Pick<RunRecord, 'metadata'>): boolean {
  return record.metadata?.backgroundTask === true;
}

export function isBackgroundAgentTaskRun(record: Pick<RunRecord, 'metadata'>): boolean {
  return isBackgroundTaskRun(record) && record.metadata?.backgroundTaskType !== 'command';
}

export function isBackgroundCommandTaskRun(record: Pick<RunRecord, 'metadata'>): boolean {
  return isBackgroundTaskRun(record) && record.metadata?.backgroundTaskType === 'command';
}

export function isBackgroundTaskReady(record: Pick<RunRecord, 'metadata'>): boolean {
  return !isBackgroundTaskRun(record) || record.metadata?.backgroundTaskReady === true;
}

export function isBackgroundTaskWakeRun(record: Pick<RunRecord, 'metadata'>): boolean {
  return record.metadata?.backgroundTaskWake === true;
}

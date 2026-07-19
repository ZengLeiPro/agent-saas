import type { ToolCallContext } from '../../agent/toolRuntime.js';
import type { RunRecord } from '../runStore.js';

export interface BackgroundTaskLease {
  renew(): Promise<void>;
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
  status: 'pending';
  description: string;
  model: string;
}

export interface BackgroundTaskRuntime {
  enqueue(context: ToolCallContext, request: BackgroundAgentRequest): Promise<BackgroundTaskStartResult>;
  execute(record: RunRecord, lease?: BackgroundTaskLease): Promise<void>;
  failInterrupted(record: RunRecord): Promise<void>;
  fail(record: RunRecord, message: string, reason?: string): Promise<void>;
  reconcileWakeDeliveries(): Promise<void>;
  list(context: ToolCallContext, limit?: number): Promise<RunRecord[]>;
  get(context: ToolCallContext, taskId: string): Promise<RunRecord | null>;
  cancel(context: ToolCallContext, taskId: string): Promise<RunRecord>;
}

export function isBackgroundTaskRun(record: Pick<RunRecord, 'metadata'>): boolean {
  return record.metadata?.backgroundTask === true;
}

export function isBackgroundTaskWakeRun(record: Pick<RunRecord, 'metadata'>): boolean {
  return record.metadata?.backgroundTaskWake === true;
}

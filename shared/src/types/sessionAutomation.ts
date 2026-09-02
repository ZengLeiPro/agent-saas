export type SessionAutomationKind = 'loop' | 'goal';
export type SessionAutomationMode = 'fixed' | 'adaptive' | 'goal';
export type SessionAutomationStatus =
  | 'active' | 'paused' | 'blocked' | 'completing' | 'cancelling'
  | 'completed' | 'cancelled' | 'failed' | 'expired' | 'reconcile_required';
export type SessionAutomationPhase =
  | 'idle' | 'waiting' | 'dispatching' | 'running' | 'evaluating' | 'draining' | 'terminal';

export interface SessionAutomationBudget {
  maxRuns?: number;
  maxTurns?: number;
  maxTokens?: number;
  maxCredits?: number;
  expiresAt?: string;
}
export interface SessionAutomationSpec {
  kind: SessionAutomationKind;
  mode: SessionAutomationMode;
  prompt?: string;
  condition?: string;
  intervalMs?: number;
  budget: SessionAutomationBudget;
}
export interface SessionAutomationSnapshot {
  automationId: string;
  incarnationId: string;
  tenantId: string;
  sessionId: string;
  ownerUserId: string;
  status: SessionAutomationStatus;
  phase: SessionAutomationPhase;
  generation: number;
  specVersion: number;
  controlVersion: number;
  projectionVersion: number;
  continuationEpoch?: number;
  spec: SessionAutomationSpec;
  nextWakeupAt?: string;
  activeRunId?: string;
  runCount: number;
  noProgressCount: number;
  lastProgressFingerprint?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}
export type SessionAutomationControlAction = 'pause' | 'resume' | 'run' | 'clear';
export interface SessionAutomationCommandRequest {
  clientMessageId: string;
  command: string;
  expectedControlVersion?: number;
  expectedIncarnationId?: string;
}
export interface SessionAutomationControlRequest {
  clientMessageId: string;
  action: SessionAutomationControlAction;
  expectedControlVersion: number;
  expectedIncarnationId: string;
}
export interface SessionAutomationCommandResponse {
  result: 'created' | 'updated' | 'status' | 'accepted' | 'idempotent_replay';
  snapshot?: SessionAutomationSnapshot;
}
export interface SessionAutomationListResponse { items: SessionAutomationSnapshot[]; }
export interface SessionAutomationApiErrorBody {
  code: 'INVALID_COMMAND' | 'NOT_FOUND' | 'FORBIDDEN' | 'CONFLICT' | 'CONFIRM_REPLACE_REQUIRED' |
    'STALE_CONTROL_VERSION' | 'FEATURE_DISABLED' | 'PG_REQUIRED' | 'EXECUTION_DISABLED';
  message: string;
  current?: SessionAutomationSnapshot;
}

export interface ScheduleWakeupInput {
  automationId: string;
  incarnationId: string;
  generation: number;
  specVersion: number;
  runId: string;
  action: 'schedule' | 'stop';
  delayMs?: number;
  reason?: string;
}
export interface UpdateGoalInput {
  automationId: string;
  incarnationId: string;
  generation: number;
  specVersion: number;
  runId: string;
  action: 'continue' | 'blocked' | 'complete_candidate';
  summary: string;
  evidenceRefs?: string[];
}

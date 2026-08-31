import type { ChatQueueSnapshot, RunLiveness } from '@agent/shared';

export const AUTHORITATIVE_SYNC_RECOVERY_VERSION = 1 as const;

export interface SyncRuntimeSnapshot {
  active: boolean;
  streamId?: string;
  runId?: string;
  status?: string;
  liveness?: RunLiveness;
}

export interface SyncPendingInteractionSnapshot {
  interactionId: string;
  type: 'ask_user' | 'permission_request' | 'approval';
  version?: number;
  order?: number;
  receipt?: { status: 'approved' | 'rejected' | 'answered' | 'failed' | 'cancelled' | 'expired'; requestId?: string; reason?: string; respondedAt?: string };
  runId?: string;
  toolCallId?: string;
  invocationId?: string;
  questions?: unknown[];
  toolId?: string;
  toolName?: string;
  displayName?: string;
  toolInput?: Record<string, unknown>;
  planContent?: string;
}

export interface SyncSessionSnapshot {
  sessionId: string;
  queueSnapshot?: ChatQueueSnapshot;
  runtime?: SyncRuntimeSnapshot;
  /** 权威替换集合；空数组表示当前没有 pending interaction；N-1 项可缺少 revision/order。 */
  pendingInteractions?: SyncPendingInteractionSnapshot[];
}

/** Overflow recovery always rehydrates interaction state from server authority, never a local outbox. */
export interface SyncOverflowRecovery {
  version: typeof AUTHORITATIVE_SYNC_RECOVERY_VERSION;
  authoritative: true;
  refresh: {
    sessions: { method: 'GET'; path: '/api/sessions' };
    sessionDetail: {
      method: 'GET';
      pathTemplate: '/api/sessions/{sessionId}';
      includes: readonly ['queueSnapshot', 'lastRunState'];
    };
    runtime: { method: 'GET'; pathTemplate: '/api/sessions/{sessionId}/stream-status' };
    pendingInteractions: { transport: 'ws'; action: 'resume'; responseType: 'pending_interactions' };
  };
  session?: SyncSessionSnapshot;
}

export interface SyncOverflowFrame {
  type: 'sync_overflow';
  seq: number;
  epoch: string;
  recovery: SyncOverflowRecovery;
}

export function buildSyncOverflowFrame(seq: number, epoch: string, session?: SyncSessionSnapshot): SyncOverflowFrame {
  return {
    type: 'sync_overflow', seq, epoch,
    recovery: {
      version: AUTHORITATIVE_SYNC_RECOVERY_VERSION,
      authoritative: true,
      refresh: {
        sessions: { method: 'GET', path: '/api/sessions' },
        sessionDetail: { method: 'GET', pathTemplate: '/api/sessions/{sessionId}', includes: ['queueSnapshot', 'lastRunState'] },
        runtime: { method: 'GET', pathTemplate: '/api/sessions/{sessionId}/stream-status' },
        pendingInteractions: { transport: 'ws', action: 'resume', responseType: 'pending_interactions' },
      },
      ...(session ? { session } : {}),
    },
  };
}

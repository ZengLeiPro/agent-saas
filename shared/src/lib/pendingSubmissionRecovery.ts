/** M50-05 durable local pending metadata. It is evidence to verify, never replay authority. */

export const PENDING_SUBMISSION_VERSION = 1 as const;

export interface DurablePendingAttachmentSelection {
  attachmentId?: string;
  displayName: string;
  mimeType?: string;
  size?: number;
}

export type DurablePendingStatus =
  | 'pending_verification'
  | 'acknowledged'
  | 'failed_unconfirmed'
  | 'failed_upgrade';

export interface DurablePendingSubmission {
  version: typeof PENDING_SUBMISSION_VERSION;
  clientMsgId: string;
  sessionId?: string;
  appProtocolVersion: number;
  schemaVersion: number;
  authGeneration: number;
  createdAt: number;
  status: DurablePendingStatus;
  /** Preserved for the composer only. Never used by automatic replay. */
  draft: string;
  /** Preserved picker choices; uploaded IDs still require server-side ownership validation. */
  attachments: DurablePendingAttachmentSelection[];
  failureMessage?: string;
}

export interface PendingRecoveryVersion {
  appProtocolVersion: number;
  schemaVersion: number;
  authGeneration: number;
}

export type PendingRecoveryDecision =
  | { action: 'query_server_ack'; requestId: string; pending: DurablePendingSubmission; autoReplay: false }
  | { action: 'mark_failed_upgrade'; pending: DurablePendingSubmission; autoReplay: false }
  | { action: 'discard_identity_mismatch'; clientMsgId: string; autoReplay: false }
  | { action: 'none'; pending: DurablePendingSubmission; autoReplay: false };

export function recoverDurablePending(
  pending: DurablePendingSubmission,
  current: PendingRecoveryVersion,
): PendingRecoveryDecision {
  if (pending.authGeneration !== current.authGeneration) {
    return { action: 'discard_identity_mismatch', clientMsgId: pending.clientMsgId, autoReplay: false };
  }
  if (pending.appProtocolVersion !== current.appProtocolVersion || pending.schemaVersion !== current.schemaVersion) {
    const failed: DurablePendingSubmission = {
      ...pending,
      status: 'failed_upgrade',
      failureMessage: '应用已升级，此消息未自动重发。请检查草稿和附件后重新发送。',
    };
    return { action: 'mark_failed_upgrade', pending: failed, autoReplay: false };
  }
  if (pending.status === 'pending_verification') {
    return {
      action: 'query_server_ack',
      requestId: `pending-ack:${pending.authGeneration}:${pending.appProtocolVersion}:${pending.clientMsgId}`,
      pending,
      autoReplay: false,
    };
  }
  return { action: 'none', pending, autoReplay: false };
}

export interface AuthoritativePendingAck {
  clientMsgId: string;
  accepted: boolean;
  sessionId?: string;
  runId?: string;
}

/** ACK lookup settles presentation only. A miss never dispatches the original payload. */
export function settlePendingAck(
  pending: DurablePendingSubmission,
  ack: AuthoritativePendingAck | null,
): DurablePendingSubmission {
  if (ack?.clientMsgId === pending.clientMsgId && ack.accepted) {
    return { ...pending, status: 'acknowledged', failureMessage: undefined };
  }
  return {
    ...pending,
    status: 'failed_unconfirmed',
    failureMessage: '服务器未确认收到此消息，未自动重发。请确认内容后手动重新发送。',
  };
}

/** Queue/runtime restoration always starts from a server snapshot, never pending storage. */
export function authoritativeQueueOnly<T>(serverSnapshot: readonly T[]): T[] {
  return [...serverSnapshot];
}

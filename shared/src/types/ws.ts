import type {
    ContextUsageData,
    PluginInstallData,
    NotificationData,
    MemoryRecallData,
    SandboxProfile,
} from './session';
import type { MessageAttachmentDisplay, SubagentStatus } from './message';
import type { TenantFeatureFlags } from './auth';
import type { RuntimeFailureKind, RuntimeRecoveryAction } from './runtimeFailure';
import type { ChatQueueItem, ChatQueueSnapshot } from '../lib/chatQueue';
import type { RunLiveness } from '../lib/runLiveness';
import type { CanonicalInteractionReceipt } from '../lib/activeInteraction';

export interface WsSyncRuntimeSnapshot {
    active: boolean;
    streamId?: string;
    runId?: string;
    status?: string;
    liveness?: RunLiveness;
}

export interface WsSyncPendingInteractionSnapshot {
    interactionId: string;
    type: 'ask_user' | 'permission_request' | 'approval';
    version?: number;
    order?: number;
    receipt?: CanonicalInteractionReceipt;
    runId?: string;
    toolCallId?: string;
    invocationId?: string;
    questions?: WsAskUserQuestion[];
    toolId?: string;
    toolName?: string;
    displayName?: string;
    toolInput?: Record<string, unknown>;
    planContent?: string;
}

export interface WsSyncSessionSnapshot {
    sessionId: string;
    queueSnapshot?: ChatQueueSnapshot;
    runtime?: WsSyncRuntimeSnapshot;
    /** Authoritative replacement; an empty array means no pending interaction remains. N-1 items may omit revision/order. */
    pendingInteractions?: WsSyncPendingInteractionSnapshot[];
}

export interface WsSyncOverflowRecovery {
    version: 1;
    authoritative: true;
    refresh: {
        sessions: { method: 'GET'; path: '/api/sessions' };
        sessionDetail: { method: 'GET'; pathTemplate: string; includes: readonly ['queueSnapshot', 'lastRunState'] };
        runtime: { method: 'GET'; pathTemplate: string };
        pendingInteractions: { transport: 'ws'; action: 'resume'; responseType: 'pending_interactions' };
    };
    session?: WsSyncSessionSnapshot;
}

export type WsBlockType = 'thinking' | 'text' | 'tool_use';
export type ChatDeliveryMode = 'queue' | 'steer';

export interface WsAskUserQuestion {
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect: boolean;
}

/**
 * 聊天消息拒绝原因码（与 server/src/channels/web/wsTypes.ts 保持一致）
 */
export type ChatRejectReasonCode =
    | 'empty_message'
    | 'access_denied'
    | 'stt_failed'
    | 'stt_not_configured'
    | 'session_locked'
    | 'server_draining'
    | 'model_not_allowed'
    | 'duplicate_inflight'
    | 'invalid_submission'
    | 'attachment_id_missing'
    | 'attachment_id_invalid'
    | 'attachment_not_found'
    | 'attachment_state_failed'
    | 'personal_agent_disabled'
    | 'org_agent_unavailable';

type WsEventPayload =
    | { type: 'stream_id'; streamId: string; runId?: string; client_msg_id?: string; queued?: boolean; deliveryMode?: ChatDeliveryMode; targetRunId?: string; sessionId?: string; queuePosition?: number }
    | { type: 'interjection_applied'; sourceRunIds: string[]; clientMsgIds: string[]; sessionId?: string }
    // 统一排队区：普通 queue 与显式 steer 都由服务端 durable 快照恢复。
    | { type: 'queue_snapshot'; snapshot: ChatQueueSnapshot; requestId?: string; networkGeneration?: number }
    | { type: 'queue_item_updated'; item: ChatQueueItem }
    | { type: 'message_queued'; sessionId: string; runId: string; clientMsgId: string; deliveryMode: ChatDeliveryMode; content: string; attachments?: MessageAttachmentDisplay[]; timestamp: number; queuePosition?: number; targetRunId?: string }
    // 旧 steering 广播保留兼容。
    | { type: 'steering_queued'; sessionId: string; sourceRunId: string; targetRunId: string; clientMsgId: string; content: string; attachments?: MessageAttachmentDisplay[]; timestamp: number }
    | { type: 'steering_cancelled'; sessionId: string; sourceRunId: string; clientMsgId?: string; reason: string }
    | { type: 'cancel_queued_result'; ok: boolean; sourceRunId: string; clientMsgId?: string; sessionId?: string; status?: ChatQueueItem['status']; item?: ChatQueueItem; snapshot?: ChatQueueSnapshot; reason?: 'too_late' | 'not_found' | 'unsupported' | 'error' }
    | { type: 'chat_ack'; client_msg_id: string; server_recv_ts: number; sessionId?: string; runId?: string; sourceRunId?: string; status?: 'accepted' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'; deliveryMode?: ChatDeliveryMode; queuePosition?: number }
    | { type: 'chat_rejected'; client_msg_id: string; reason_code: ChatRejectReasonCode; reason: string; code?: string; correlationId?: string; retryAfter?: number }
    | { type: 'session'; sessionId: string; client_msg_id?: string; sandboxProfile?: SandboxProfile }
    | { type: 'block_start'; blockType: WsBlockType; toolName?: string; toolId?: string; draftId?: string; runId?: string }
    | { type: 'draft_reset'; draftId: string; attempt?: number }
    | { type: 'draft_commit'; draftId: string }
    | { type: 'thinking'; content: string }
    | { type: 'text'; content: string; guardrailEventId?: string }
    | { type: 'tool_input'; content: string; toolName?: string; toolId?: string }
    | { type: 'block_end'; blockType: WsBlockType; toolName?: string }
    | { type: 'tool_execution'; phase: 'started' | 'progress' | 'completed'; toolName?: string; toolId?: string; invocationId?: string; status?: 'success' | 'error' | 'cancelled'; durationMs?: number; content?: string; error?: string }
    // presentation/metadata：与历史加载（transcript）同源的「给人看」摘要与结构化执行事实。
    // 跨进程边界属不可信输入，前端必须过 normalizeToolPresentation / normalizeToolResultMetadata 再入渲染层
    | { type: 'tool_result'; toolName?: string; toolId?: string; result?: string; isError?: boolean; presentation?: unknown; metadata?: unknown }
    | { type: 'permission_request'; interactionId: string; version?: number; order?: number; toolName: string; toolInput: Record<string, unknown>; toolId?: string; displayName?: string; planContent?: string }
    | { type: 'ask_user'; interactionId: string; version?: number; order?: number; questions: WsAskUserQuestion[] }
    | { type: 'subagent_start'; toolId: string; agentType: string; childSessionId?: string; childRunId?: string; model?: string }
    | { type: 'subagent_end'; toolId: string; agentType?: string; status?: Exclude<SubagentStatus, 'running'>; childSessionId?: string; childRunId?: string; model?: string; durationMs?: number; totalTokens?: number; toolUseCount?: number; turnCount?: number; errorMessage?: string; failureKind?: RuntimeFailureKind; recoveryAction?: RuntimeRecoveryAction; resultPreview?: string }
    | { type: 'moderation_outcome'; moderationId: string; outcome: 'allowed' | 'blocked' | 'flagged'; reasonCode?: string }
    | { type: 'file_download'; fileName: string; fileType: string; filePath: string; fileSize: number; owner?: string }
    | { type: 'artifact_created'; artifactId: string; fileName: string; kind: 'file' | 'screenshot' | 'patch' | 'log' | 'blob'; sourcePath?: string; sizeBytes?: number; mimeType?: string; sha256?: string; owner?: string }
    | { type: 'voice'; text: string; voice?: string; speed?: number; standalone?: boolean }
    | { type: 'voice_transcribed'; text: string; error?: boolean }
    | { type: 'title_updated'; sessionId: string; title: string; serverVersion?: number; updatedAt?: string; sourceSeq?: number }
    | { type: 'session_updated'; sessionId: string; preview?: string; updatedAtMs: number; title?: string; model?: string; username?: string; isNew?: boolean; serverVersion?: number; updatedAt?: string; sourceSeq?: number }
    | { type: 'buffer_overflow' }
    | { type: 'done'; sessionId?: string; streamId?: string; runId?: string; client_msg_id?: string; error?: string; failureKind?: RuntimeFailureKind; recoveryAction?: RuntimeRecoveryAction; finalOutput?: boolean }
    | { type: 'error'; message: string; code?: string; correlationId?: string; retryAfter?: number }
    | { type: 'respond_error'; sessionId?: string; interactionId: string; requestId?: string; clientAttemptId?: string; version?: number; authEpoch?: number; generation?: number; status?: 'rejected' | 'not_found' | 'expired'; error: string; reason?: string; retryable?: boolean }
    | { type: 'respond_ok'; sessionId?: string; interactionId: string; requestId?: string; clientAttemptId?: string; version?: number; authEpoch?: number; generation?: number; status?: 'accepted' | 'duplicate' | 'resolved'; response?: Record<string, unknown> }
    | { type: 'abort_ok'; streamId?: string; runId?: string }
    | { type: 'pending_interactions'; sessionId?: string; interactions: WsSyncPendingInteractionSnapshot[] }
    | { type: 'active_stream'; sessionId: string; active: boolean; streamId?: string; runId?: string; status?: string; liveness?: RunLiveness; requestId?: string; networkGeneration?: number }
    | { type: 'stream_started'; sessionId: string; streamId: string; runId?: string }
    | { type: 'interaction_resolved'; sessionId: string; interactionId: string; version?: number; order?: number; status?: 'resolved' | 'rejected' | 'failed' | 'cancelled' | 'expired'; response?: Record<string, unknown>; reason?: string; retryable?: boolean; receipt?: CanonicalInteractionReceipt }
    | { type: 'session_deleted'; sessionId: string; serverVersion?: number; updatedAt?: string; sourceSeq?: number }
    | { type: 'session_read_state_changed'; sessionId: string; hasUnreadAiReply: boolean; readSeq?: number; serverVersion?: number; updatedAt?: string; sourceSeq?: number }
    | { type: 'user_message'; content: string; attachments?: MessageAttachmentDisplay[]; timestamp: number; client_msg_id?: string; sourceRunId?: string; sessionId?: string }
    | { type: 'session_status'; sessionId: string; status: 'busy' | 'idle' | 'queued' | 'running' | 'waiting_approval' | 'waiting_user' | 'waiting_hand' | 'completed' | 'failed' | 'cancelled' | 'orphaned'; streamId?: string; runId?: string; liveness?: RunLiveness; reason?: string; failureKind?: RuntimeFailureKind; recoveryAction?: RuntimeRecoveryAction }
    | { type: 'groups_changed' }
    | { type: 'tenant_features_changed'; tenantId: string; tenantFeatures: TenantFeatureFlags; debugMode: boolean }
    // ── SDK 0.2.112+ 新增事件 ──
    | { type: 'context_usage'; contextUsage: ContextUsageData }
    | { type: 'plugin_install'; pluginInstall: PluginInstallData }
    | { type: 'notification'; notification: NotificationData }
    | { type: 'memory_recall'; memoryRecall: MemoryRecallData }
    // epoch/recovery are optional for N-1 servers; current servers always include them.
    | { type: 'sync_ok'; seq: number; epoch?: string; events: Array<{ seq: number; event: WsEvent }>; requestId?: string; networkGeneration?: number }
    | { type: 'sync_overflow'; seq: number; epoch?: string; recovery?: WsSyncOverflowRecovery; code?: 'sync_overflow'; correlationId?: string; retryAfter?: number; requestId?: string; networkGeneration?: number }
    | { type: 'recovery_rejected'; requestId: string; reason: 'stale_network_generation'; latestNetworkGeneration: number }
    | { type: 'pong'; seq?: number; epoch?: string; probe?: boolean };


export interface WsProjectionMetadata {
    eventId: string;
    domain: 'message' | 'tool' | 'subagent' | 'moderation';
    runId: string;
    messageId: string;
    blockId?: string;
    toolCallId?: string;
    subagentId?: string;
}

/** Stable canonical identity is present on modern server projections; absent only on legacy frames. */
export type WsEvent = WsEventPayload & { projection?: WsProjectionMetadata };

export interface WsOutboundEnvelope {
    eventId?: number;
    eventCursor?: string;
    seq?: number;
    data: WsEvent;
}

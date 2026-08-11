import type {
    ContextUsageData,
    PluginInstallData,
    NotificationData,
    MemoryRecallData,
} from './session';
import type { SubagentStatus } from './message';

export type WsBlockType = 'thinking' | 'text' | 'tool_use';

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
    | 'personal_agent_disabled'
    | 'org_agent_unavailable';

export type WsEvent =
    | { type: 'stream_id'; streamId: string; runId?: string; client_msg_id?: string; queued?: boolean; targetRunId?: string; sessionId?: string }
    | { type: 'interjection_applied'; sourceRunIds: string[]; clientMsgIds: string[]; sessionId?: string }
    // 插话队列区（2026-08-04 终态设计）：user scope 多端同步
    | { type: 'steering_queued'; sessionId: string; sourceRunId: string; targetRunId: string; clientMsgId: string; content: string; attachments?: Array<{ name: string; isImage?: boolean; relativePath?: string }>; timestamp: number }
    | { type: 'steering_cancelled'; sessionId: string; sourceRunId: string; clientMsgId?: string; reason: string }
    | { type: 'cancel_queued_result'; ok: boolean; sourceRunId: string; reason?: 'too_late' | 'not_found' | 'unsupported' | 'error' }
    | { type: 'chat_ack'; client_msg_id: string; server_recv_ts: number }
    | { type: 'chat_rejected'; client_msg_id: string; reason_code: ChatRejectReasonCode; reason: string }
    | { type: 'session'; sessionId: string; client_msg_id?: string }
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
    | { type: 'permission_request'; interactionId: string; toolName: string; toolInput: Record<string, unknown>; toolId?: string; displayName?: string; planContent?: string }
    | { type: 'ask_user'; interactionId: string; questions: WsAskUserQuestion[] }
    | { type: 'subagent_start'; toolId: string; agentType: string; childSessionId?: string; childRunId?: string; model?: string }
    | { type: 'subagent_end'; toolId: string; agentType?: string; status?: Exclude<SubagentStatus, 'running'>; childSessionId?: string; childRunId?: string; model?: string; durationMs?: number; totalTokens?: number; toolUseCount?: number; turnCount?: number; errorMessage?: string; resultPreview?: string }
    | { type: 'file_download'; fileName: string; fileType: string; filePath: string; fileSize: number; owner?: string }
    | { type: 'artifact_created'; artifactId: string; fileName: string; kind: 'file' | 'screenshot' | 'patch' | 'log' | 'blob'; sourcePath?: string; sizeBytes?: number; mimeType?: string; sha256?: string; owner?: string }
    | { type: 'voice'; text: string; voice?: string; speed?: number; standalone?: boolean }
    | { type: 'voice_transcribed'; text: string; error?: boolean }
    | { type: 'title_updated'; sessionId: string; title: string }
    | { type: 'session_updated'; sessionId: string; preview?: string; updatedAtMs: number; title?: string; model?: string; username?: string; isNew?: boolean }
    | { type: 'buffer_overflow' }
    | { type: 'done'; sessionId?: string; streamId?: string; runId?: string; client_msg_id?: string; error?: string; finalOutput?: boolean }
    | { type: 'error'; message: string }
    | { type: 'respond_error'; interactionId: string; error: string }
    | { type: 'respond_ok'; interactionId: string }
    | { type: 'abort_ok'; streamId?: string; runId?: string }
    | { type: 'pending_interactions'; interactions: Array<{ interactionId: string; type: string; questions?: WsAskUserQuestion[]; toolId?: string; toolName?: string; displayName?: string; toolInput?: Record<string, unknown>; planContent?: string }> }
    | { type: 'active_stream'; sessionId: string; active: boolean; streamId?: string; runId?: string; status?: string }
    | { type: 'stream_started'; sessionId: string; streamId: string; runId?: string }
    | { type: 'interaction_resolved'; sessionId: string; interactionId: string }
    | { type: 'session_deleted'; sessionId: string }
    | { type: 'session_read_state_changed'; sessionId: string; hasUnreadAiReply: boolean }
    | { type: 'user_message'; content: string; attachments?: Array<{ name: string; isImage?: boolean; relativePath?: string }>; timestamp: number; client_msg_id?: string; sourceRunId?: string; sessionId?: string }
    | { type: 'session_status'; sessionId: string; status: 'busy' | 'idle' | 'queued' | 'running' | 'waiting_approval' | 'waiting_user' | 'waiting_hand' | 'completed' | 'failed' | 'cancelled' | 'orphaned'; streamId?: string; runId?: string; reason?: string }
    | { type: 'groups_changed' }
    // ── SDK 0.2.112+ 新增事件 ──
    | { type: 'context_usage'; contextUsage: ContextUsageData }
    | { type: 'plugin_install'; pluginInstall: PluginInstallData }
    | { type: 'notification'; notification: NotificationData }
    | { type: 'memory_recall'; memoryRecall: MemoryRecallData }
    | { type: 'sync_ok'; seq: number; events: Array<{ seq: number; event: object }> }
    | { type: 'sync_overflow'; seq: number };

export interface WsOutboundEnvelope {
    eventId?: number;
    eventCursor?: string;
    seq?: number;
    data: WsEvent;
}

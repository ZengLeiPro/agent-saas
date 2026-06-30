import type {
    ContextUsageData,
    PluginInstallData,
    NotificationData,
    MemoryRecallData,
} from './session';

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
    | 'duplicate_inflight';

export type WsEvent =
    | { type: 'stream_id'; streamId: string; runId?: string; client_msg_id?: string }
    | { type: 'chat_ack'; client_msg_id: string; server_recv_ts: number }
    | { type: 'chat_rejected'; client_msg_id: string; reason_code: ChatRejectReasonCode; reason: string }
    | { type: 'session'; sessionId: string }
    | { type: 'block_start'; blockType: WsBlockType; toolName?: string; toolId?: string }
    | { type: 'thinking'; content: string }
    | { type: 'text'; content: string }
    | { type: 'tool_input'; content: string; toolName?: string; toolId?: string }
    | { type: 'block_end'; blockType: WsBlockType; toolName?: string }
    | { type: 'tool_result'; toolName?: string; toolId?: string; result?: string }
    | { type: 'permission_request'; interactionId: string; toolName: string; toolInput: Record<string, unknown>; toolId?: string; displayName?: string; planContent?: string }
    | { type: 'ask_user'; interactionId: string; questions: WsAskUserQuestion[] }
    | { type: 'subagent_start'; toolId: string; agentType: string }
    | { type: 'subagent_end'; toolId: string }
    | { type: 'file_download'; fileName: string; fileType: string; filePath: string; fileSize: number; owner?: string }
    | { type: 'voice'; text: string; voice?: string; speed?: number; standalone?: boolean }
    | { type: 'voice_transcribed'; text: string; error?: boolean }
    | { type: 'title_updated'; sessionId: string; title: string }
    | { type: 'session_updated'; sessionId: string; preview?: string; updatedAtMs: number; title?: string; model?: string; username?: string; isNew?: boolean }
    | { type: 'buffer_overflow' }
    | { type: 'done'; client_msg_id?: string; error?: string }
    | { type: 'error'; message: string }
    | { type: 'respond_error'; interactionId: string; error: string }
    | { type: 'respond_ok'; interactionId: string }
    | { type: 'abort_ok'; streamId?: string; runId?: string }
    | { type: 'pending_interactions'; interactions: Array<{ interactionId: string; type: string; questions?: WsAskUserQuestion[]; toolId?: string; toolName?: string; displayName?: string; toolInput?: Record<string, unknown>; planContent?: string }> }
    | { type: 'active_stream'; sessionId: string; active: boolean; streamId?: string; runId?: string; status?: string }
    | { type: 'stream_started'; sessionId: string; streamId: string; runId?: string }
    | { type: 'interaction_resolved'; sessionId: string; interactionId: string }
    | { type: 'session_deleted'; sessionId: string }
    | { type: 'user_message'; content: string; attachments?: Array<{ name: string; isImage?: boolean }>; timestamp: number; client_msg_id?: string }
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

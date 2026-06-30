/**
 * WebSocket Message Protocol Types
 *
 * 定义 WS 上行（客户端 → 服务端）和下行（服务端 → 客户端）消息格式。
 * 下行事件复用原 SSE 事件类型，包裹在带 eventId 的信封中。
 */

import type {
    UploadedFileInfo,
    ContextUsageData,
    PluginInstallData,
    NotificationData,
    MemoryRecallData,
} from '../../types/index.js';

// ── 上行消息（客户端 → 服务端）──────────────────────────────

/**
 * 聊天消息拒绝原因码
 * 客户端据此展示友好文案并决定是否允许重试
 */
export type ChatRejectReasonCode =
    | 'empty_message'          // 内容为空
    | 'access_denied'          // 会话归属校验失败
    | 'stt_failed'             // 语音转写失败
    | 'stt_not_configured'     // 语音转写未配置
    | 'session_locked'         // 同会话上一条还在处理
    | 'server_draining'        // 服务端优雅关闭中
    | 'model_not_allowed'      // 组织模型策略不允许使用所选模型
    | 'duplicate_inflight';    // 同 client_msg_id 已在处理

export interface WsChatMessage {
    action: 'chat';
    /** 客户端生成的 UUID，贯穿全链路；老客户端可缺省，服务端生成占位 */
    client_msg_id?: string;
    message: string;
    sessionId?: string;
    attachments?: UploadedFileInfo[];
    model?: string;
    /** 内部管理员验收开关：选择工具执行后端。普通 UI 不暴露。 */
    executionTarget?: 'server-local' | 'server-container';
    approvalPolicy?: {
        autoApproveTools?: boolean;
        autoApproveRunShell?: boolean;
    };
    voiceFile?: {
        savedPath: string;
        relativePath: string;
        duration: number;
    };
}

export interface WsRespondMessage {
    action: 'respond';
    interactionId: string;
    sessionId?: string;
    [key: string]: unknown;
}

export interface WsAbortMessage {
    action: 'abort';
    /** Preferred durable control-plane identifier. */
    runId?: string;
    /** Legacy UI stream identifier kept for compatibility. */
    streamId?: string;
}

export interface WsApprovalPolicyMessage {
    action: 'approval_policy';
    sessionId?: string;
    runId?: string;
    approvalPolicy?: {
        autoApproveTools?: boolean;
        autoApproveRunShell?: boolean;
    };
}

export interface WsRunStatusMessage {
    action: 'run_status';
    runId: string;
}

export interface WsResumeMessage {
    action: 'resume';
    sessionId: string;
    /** Legacy per-process EventBuffer id. */
    lastEventId: number;
    /** Durable runtime EventStore cursor (PG session_sequence as opaque string). */
    lastEventCursor?: string;
    skipReplay?: boolean;
}

export interface WsDetachMessage {
    action: 'detach';
}

export interface WsPingMessage {
    action: 'ping';
    lastSeq?: number;
    clientTs?: number;
}

export interface WsSyncMessage {
    action: 'sync';
    lastSeq: number;
}

export type WsInboundMessage =
    | WsChatMessage
    | WsRespondMessage
    | WsAbortMessage
    | WsApprovalPolicyMessage
    | WsRunStatusMessage
    | WsResumeMessage
    | WsDetachMessage
    | WsPingMessage
    | WsSyncMessage;

// ── 下行消息（服务端 → 客户端）──────────────────────────────

/** 下行事件信封：每个事件可携带 eventId / seq 供断线重连和 gap 检测使用 */
export interface WsOutboundEnvelope {
    /** 递增事件 ID（per-session，缓冲模式下存在），用于断线重连回放 */
    eventId?: number;
    /** Durable runtime EventStore cursor for cross-process replay. */
    eventCursor?: string;
    /** 用户级事件序号（per-user，user/dual/admin scope 事件），用于 gap 检测和主动 sync */
    seq?: number;
    /** 事件数据（与原 SSE data 完全一致） */
    data: WsDownstreamEvent;
}

export type WsBlockType = 'thinking' | 'text' | 'tool_use';

export interface WsAskUserQuestion {
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect: boolean;
}

export type WsDownstreamEvent =
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
    | { type: 'pending_interactions'; interactions: Array<{ interactionId: string; type: string; runId?: string; toolCallId?: string; invocationId?: string; questions?: WsAskUserQuestion[]; toolId?: string; toolName?: string; displayName?: string; toolInput?: Record<string, unknown>; planContent?: string }> }
    | { type: 'active_stream'; sessionId: string; active: boolean; streamId?: string; runId?: string; status?: string }
    | { type: 'stream_started'; sessionId: string; streamId: string; runId?: string }
    | { type: 'interaction_resolved'; sessionId: string; interactionId: string }
    | { type: 'session_deleted'; sessionId: string }
    | { type: 'user_message'; content: string; timestamp: number; client_msg_id?: string; attachments?: Array<{ name: string; isImage?: boolean }> }
    | { type: 'session_status'; sessionId: string; status: 'busy' | 'idle' | 'queued' | 'running' | 'waiting_approval' | 'waiting_user' | 'waiting_hand' | 'completed' | 'failed' | 'cancelled' | 'orphaned'; streamId?: string; runId?: string; reason?: string }
    | { type: 'groups_changed' }
    // ── SDK 0.2.112+ 新增系统事件 ──
    | { type: 'context_usage'; contextUsage: ContextUsageData }
    | { type: 'plugin_install'; pluginInstall: PluginInstallData }
    | { type: 'notification'; notification: NotificationData }
    | { type: 'memory_recall'; memoryRecall: MemoryRecallData }
    | { type: 'sync_ok'; seq: number; events: Array<{ seq: number; event: object }> }
    | { type: 'sync_overflow'; seq: number }
    | { type: 'pong'; seq?: number };

/**
 * Send Chat — 发送消息到 Agent 的核心逻辑
 *
 * 从两端 useChatAppState.sendChatViaWs 提取的共享逻辑。
 */

import { getChatStore } from '../index';
import { INITIAL_BLOCK_STATE } from '../types';
import { wsClient, type CanonicalWsChatMessage } from '../../lib/wsClient';
import {
  canonicalChatAttachmentToDisplay,
  normalizeChatSubmission,
  toCanonicalChatSubmissionWireMessage,
} from '../../lib/chatSubmission';
import { getPlatform } from '../../platform/context';
import type { AgentTarget } from '../../lib/agentTarget';

export interface SendChatOptions {
  inputText: string;
  attachments?: Array<{
    attachmentId?: string;
    originalName: string;
    savedPath?: string;
    relativePath: string;
    size: number;
    mimeType: string;
    isImage?: boolean;
  }>;
  showBubble?: boolean;
  selectedModel?: string | null;
  autoApproveRunShell?: boolean;
  /** Required for a new session; existing sessions use their persisted list projection. */
  agentTarget?: AgentTarget;
}

/**
 * 通过 WS 发送聊天消息
 * @returns false 如果发送失败
 */
export async function sendChatViaWs(opts: SendChatOptions): Promise<boolean> {
  const {
    inputText,
    attachments = [],
    showBubble = true,
    selectedModel,
    autoApproveRunShell,
  } = opts;
  const store = getChatStore();
  const state = store.getState();
  const activeSessionId = state.activeSessionId;
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const clientMsgId = cryptoApi?.randomUUID?.()
    ?? `c-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const agentTarget = activeSessionId
    ? state.sessions.find(session => session.sessionId === activeSessionId)?.agentTarget
    : opts.agentTarget;
  if (!agentTarget) return false;
  const normalized = normalizeChatSubmission({
    text: inputText,
    clientMsgId,
    target: { ...(activeSessionId ? { sessionId: activeSessionId } : {}), agentTarget },
    deliveryMode: 'queue',
    model: selectedModel ?? undefined,
    attachments,
  });
  // Fail closed before mutating chat state; callers retain their draft/upload state.
  if (!normalized.ok) return false;
  const submission = normalized.value;

  // 初始化 WS refs
  store.setState({
    latestStreamSessionId: activeSessionId,
    blockState: { ...INITIAL_BLOCK_STATE },
    lastEventId: null,
    lastEventCursor: null,
    streamNonce: state.streamNonce + 1,
    isAttached: true,
  });

  // 添加/复用用户消息气泡
  if (showBubble) {
    state.triggerScroll();
    const userMsgIndex = state.addMessage({
      type: 'user',
      content: inputText,
      ...(submission.attachments.length > 0
        ? { attachments: submission.attachments.map(canonicalChatAttachmentToDisplay) }
        : {}),
      status: 'pending',
      clientMsgId: submission.clientMsgId,
      timestamp: Date.now(),
    });
    store.setState({ userMsgIndex });

    // 乐观更新会话列表
    if (activeSessionId) {
      state.updateSessionMeta(activeSessionId, {
        preview: inputText.slice(0, 200),
        updatedAtMs: Date.now(),
      });
    }
  } else {
    // 排队消息复用：找到最后一个 pending 用户消息的 index
    const msgs = state.getMessagesRef();
    let retryIndex = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].type === 'user' && (msgs[i] as { status?: string }).status === 'pending') {
        retryIndex = i;
        break;
      }
    }
    store.setState({ userMsgIndex: retryIndex });
  }

  // 设置 loading
  store.setState({ loading: true });
  store.getState().dispatchConnection('connect');

  // 构造唯一的 canonical V1 WS 消息；附件路径不会进入抓包 DTO。
  const wsMsg: CanonicalWsChatMessage = {
    ...toCanonicalChatSubmissionWireMessage(submission, ['replaceable_drafts']),
    ...(autoApproveRunShell ? { approvalPolicy: { autoApproveTools: true } } : {}),
  };

  // 发送
  const ok = await wsClient.ensureConnectedSend(wsMsg);
  if (!ok) {
    // 发送失败：标记消息为 failed
    const s = store.getState();
    if (s.userMsgIndex >= 0) {
      s.updateMessageAt(s.userMsgIndex, m =>
        m.type === 'user' && m.status === 'pending' ? { ...m, status: 'failed' as const } : m
      );
    }
    store.setState({ isAttached: false, loading: false });
    return false;
  }

  // 持久化模型选择
  if (selectedModel && activeSessionId) {
    void getPlatform().storage.setItem(`agentChat.model.${activeSessionId}`, selectedModel);
  }

  return true;
}

/**
 * Send Chat — 发送消息到 Agent 的核心逻辑
 *
 * 从两端 useChatAppState.sendChatViaWs 提取的共享逻辑。
 */

import { getChatStore } from '../index';
import { INITIAL_BLOCK_STATE } from '../types';
import { wsClient, type WsChatMessage } from '../../lib/wsClient';
import { getPlatform } from '../../platform/context';

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
  voiceFile?: { savedPath: string; relativePath: string; duration: number };
  selectedModel?: string | null;
  autoApproveRunShell?: boolean;
  workflowDemo?: { runId: string; eventId: string };
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
    voiceFile,
    selectedModel,
    autoApproveRunShell,
    workflowDemo,
  } = opts;
  const store = getChatStore();
  const state = store.getState();
  const activeSessionId = state.activeSessionId;

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
      ...(attachments.length > 0 ? { attachments: attachments.map(f => ({ name: f.originalName, isImage: (f as { isImage?: boolean }).isImage })) } : {}),
      status: 'pending',
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

  // 构造 WS 消息
  const wsMsg: WsChatMessage = {
    action: 'chat',
    message: inputText || 'Please check the attachments I uploaded',
    sessionId: activeSessionId || undefined,
    model: selectedModel || undefined,
    ...(autoApproveRunShell ? { approvalPolicy: { autoApproveTools: true } } : {}),
    ...(workflowDemo ? { workflowDemo } : {}),
    ...(attachments.length > 0 ? {
      attachments: attachments.map(f => ({
        ...(f.attachmentId ? { attachmentId: f.attachmentId } : {}),
        originalName: f.originalName,
        ...(f.savedPath ? { savedPath: f.savedPath } : {}),
        relativePath: f.relativePath,
        size: f.size,
        mimeType: f.mimeType,
        isImage: f.isImage ?? false,
      })),
    } : {}),
    ...(voiceFile ? { voiceFile } : {}),
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

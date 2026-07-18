/**
 * sendChatViaWs 测试 —— 发送消息核心逻辑
 *
 * mock 外部边界：wsClient.ensureConnectedSend（发送结果）、platform.storage（模型持久化）。
 * 覆盖：初始化 WS refs、气泡添加、loading/connection 置位、成功 true、失败标记消息 failed、
 * 无气泡（排队重试）复用 pending 消息 index。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const wsEnsureSend = vi.fn(async () => true);
vi.mock('../../lib/wsClient', () => ({
  wsClient: { ensureConnectedSend: (...a: unknown[]) => wsEnsureSend(...a) },
}));

import { sendChatViaWs } from './sendChat';
import { getChatStore, resetChatStore } from '../index';
import { initPlatform } from '../../platform/context';
import type { PlatformDeps } from '../../platform/types';

let storageSetSpy: ReturnType<typeof vi.fn>;

function makePlatform(): PlatformDeps {
  storageSetSpy = vi.fn();
  return {
    storage: { getItem: () => null, setItem: (...a) => { storageSetSpy(...a); }, removeItem: () => {} },
    secureStorage: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
    messageCache: { save: () => {}, load: async () => null, clear: async () => {} },
    platformConfig: { getBaseUrl: () => '', getWsUrl: () => '', platform: 'web' },
    scheduleFlush: (cb) => { cb(); return 0; },
    cancelFlush: () => {},
  };
}

beforeEach(() => {
  resetChatStore();
  initPlatform(makePlatform());
  wsEnsureSend.mockReset();
  wsEnsureSend.mockResolvedValue(true);
});

describe('sendChatViaWs — 成功路径', () => {
  it('初始化 WS refs：置 isAttached、递增 nonce、清 lastEventId', async () => {
    const store = getChatStore();
    store.setState({ activeSessionId: 's1', streamNonce: 2, lastEventId: 9 });

    await sendChatViaWs({ inputText: '你好' });

    const s = store.getState();
    expect(s.latestStreamSessionId).toBe('s1');
    expect(s.streamNonce).toBe(3);
    expect(s.lastEventId).toBeNull();
    expect(s.lastEventCursor).toBeNull();
  });

  it('showBubble 默认 true：添加 user 消息、置 userMsgIndex、loading、乐观更新会话', async () => {
    const store = getChatStore();
    store.setState({ activeSessionId: 's1' });
    store.getState().setSessions([{ sessionId: 's1', updatedAtMs: 1, source: { type: 'web', label: 'WEB' } }]);

    const ok = await sendChatViaWs({ inputText: '问题内容' });

    expect(ok).toBe(true);
    const s = store.getState();
    expect(s.userMsgIndex).toBe(0);
    expect(s.loading).toBe(true);
    expect(s.getMessagesRef()).toHaveLength(1);
    const msg = s.getMessagesRef()[0];
    expect(msg.type).toBe('user');
    expect((msg as { content: string }).content).toBe('问题内容');
    // 乐观更新会话 preview
    expect(s.sessions[0].preview).toBe('问题内容');
    // 发送内容正确
    expect(wsEnsureSend).toHaveBeenCalledWith(expect.objectContaining({
      action: 'chat', message: '问题内容', sessionId: 's1',
    }));
  });

  it('connection 状态机被推进到 connected', async () => {
    const store = getChatStore();
    store.setState({ activeSessionId: 's1' });
    await sendChatViaWs({ inputText: 'x' });
    expect(store.getState().connectionState).toBe('connected');
  });

  it('空 inputText 但有附件：message 回退为占位文案，附件带上', async () => {
    const store = getChatStore();
    store.setState({ activeSessionId: 's1' });
    await sendChatViaWs({
      inputText: '',
      attachments: [{ originalName: 'a.png', relativePath: 'x/a.png', size: 10, mimeType: 'image/png', isImage: true }],
    });
    expect(wsEnsureSend).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Please check the attachments I uploaded',
      attachments: expect.arrayContaining([expect.objectContaining({ originalName: 'a.png', isImage: true })]),
    }));
  });

  it('selectedModel + activeSessionId：成功后持久化模型选择', async () => {
    const store = getChatStore();
    store.setState({ activeSessionId: 's1' });
    await sendChatViaWs({ inputText: 'x', selectedModel: 'gpt-x' });
    expect(storageSetSpy).toHaveBeenCalledWith('agentChat.model.s1', 'gpt-x');
  });
});

describe('sendChatViaWs — 失败路径', () => {
  it('ensureConnectedSend 返回 false：标记 user 消息 failed、清 loading/isAttached、返回 false', async () => {
    wsEnsureSend.mockResolvedValue(false);
    const store = getChatStore();
    store.setState({ activeSessionId: 's1' });

    const ok = await sendChatViaWs({ inputText: '发送失败' });

    expect(ok).toBe(false);
    const s = store.getState();
    expect(s.loading).toBe(false);
    expect(s.isAttached).toBe(false);
    const msg = s.getMessagesRef()[s.userMsgIndex];
    expect((msg as { status: string }).status).toBe('failed');
  });

  it('失败时不持久化模型', async () => {
    wsEnsureSend.mockResolvedValue(false);
    const store = getChatStore();
    store.setState({ activeSessionId: 's1' });
    await sendChatViaWs({ inputText: 'x', selectedModel: 'gpt-x' });
    expect(storageSetSpy).not.toHaveBeenCalled();
  });
});

describe('sendChatViaWs — showBubble=false（排队重试复用）', () => {
  it('复用最后一条 pending user 消息的 index，不新增气泡', async () => {
    const store = getChatStore();
    store.setState({ activeSessionId: 's1' });
    // 预置：一条已发送 + 一条 pending user 消息
    store.getState().addMessage({ type: 'user', content: '已发', status: 'sent' });
    store.getState().addMessage({ type: 'user', content: '待发', status: 'pending' });
    store.getState().flushMessages();
    const beforeLen = store.getState().getMessagesRef().length;

    await sendChatViaWs({ inputText: '待发', showBubble: false });

    // 未新增消息
    expect(store.getState().getMessagesRef()).toHaveLength(beforeLen);
    // userMsgIndex 指向 pending 那条（index 1）
    expect(store.getState().userMsgIndex).toBe(1);
  });

  it('无 pending 消息时 userMsgIndex 置 -1', async () => {
    const store = getChatStore();
    store.setState({ activeSessionId: 's1' });
    store.getState().addMessage({ type: 'user', content: '已发', status: 'sent' });
    store.getState().flushMessages();

    await sendChatViaWs({ inputText: 'x', showBubble: false });

    expect(store.getState().userMsgIndex).toBe(-1);
  });
});

/**
 * wsEventProcessor.ts 测试
 *
 * 纯逻辑：输入单条 WS 事件 → 通过 MessagesController 输出状态变更 / 消息更新。
 * 逐类事件类型构造输入并断言输出的消息数组 / 回调触发正确。
 *
 * 关键做法：用一个基于内存数组的 fakeController 复刻 addMessage / updateMessageAt /
 * setMessages 的真实语义（addMessage 返回下标、updateMessageAt 就地替换），
 * 这样断言的就是真实的 messages 终态，而非 mock 调用次数。
 */
import { describe, expect, it } from 'vitest';
import type { MessageItem, MessageItemInput } from '../types/message';
import {
  upsertRuntimeStatusMessage,
  removeRuntimeStatusMessages,
  finalizeRunningSubagents,
  finalizeStreamingMessages,
  findUserMsgIndexByClientId,
  resolvePlanModeDisplay,
  type MessagesController,
} from './wsEventProcessor';

// ── 内存版 MessagesController：复刻真实语义，便于对终态数组断言 ──────────────
interface FakeController extends MessagesController {
  messages: MessageItem[];
  scrollCount: number;
}

let idSeq = 0;
function makeController(initial: MessageItem[] = []): FakeController {
  const messages: MessageItem[] = [...initial];
  const ctrl: FakeController = {
    messages,
    scrollCount: 0,
    messagesRef: { current: messages },
    addMessage: (m: MessageItemInput) => {
      const withId = { ...m, id: m.id ?? `m${idSeq++}` } as MessageItem;
      messages.push(withId);
      return messages.length - 1;
    },
    updateMessageAt: (index: number, updater: (msg: MessageItem) => MessageItem) => {
      if (index < 0 || index >= messages.length) return;
      messages[index] = updater(messages[index]);
    },
    setMessages: (next: MessageItemInput[]) => {
      messages.length = 0;
      for (const m of next) messages.push({ ...m, id: (m as MessageItem).id ?? `m${idSeq++}` } as MessageItem);
    },
    triggerScroll: () => {
      ctrl.scrollCount++;
    },
  };
  return ctrl;
}

// ── 构造一个最小可用的 WsProcessingContext ──────────────────────────────
describe('辅助函数', () => {
  it('resolvePlanModeDisplay：EnterPlanMode 返回中文名与固定描述', () => {
    expect(resolvePlanModeDisplay('EnterPlanMode', 'fallback')).toEqual({
      name: '进入规划模式',
      description: 'Agent 请求进入规划模式，将在只读模式下探索代码库并设计实现方案。',
    });
  });

  it('resolvePlanModeDisplay：ExitPlanMode 带 planContent 时用 planContent 作描述', () => {
    expect(resolvePlanModeDisplay('ExitPlanMode', 'fb', '方案正文')).toEqual({
      name: '规划方案审批',
      description: '方案正文',
    });
    // 无 planContent 时回退到固定描述
    expect(resolvePlanModeDisplay('ExitPlanMode', 'fb').description).toContain('已完成方案规划');
  });

  it('resolvePlanModeDisplay：未映射工具回退到 displayName / toolName + fallbackInput', () => {
    expect(resolvePlanModeDisplay('Bash', '{"cmd":"ls"}', undefined, '运行命令')).toEqual({
      name: '运行命令',
      description: '{"cmd":"ls"}',
    });
    // 无 displayName 时用 toolName
    expect(resolvePlanModeDisplay('Bash', 'input').name).toBe('Bash');
  });

  it('findUserMsgIndexByClientId：命中最后一条匹配的 user/user-voice', () => {
    const msgs: MessageItem[] = [
      { id: 'a', type: 'user', content: 'hi', clientMsgId: 'c1' },
      { id: 'b', type: 'text', content: 'x' },
      { id: 'c', type: 'user-voice', audioUrl: 'u', duration: 1, status: 'sent', clientMsgId: 'c2' },
    ];
    expect(findUserMsgIndexByClientId(msgs, 'c1')).toBe(0);
    expect(findUserMsgIndexByClientId(msgs, 'c2')).toBe(2);
    expect(findUserMsgIndexByClientId(msgs, 'missing')).toBe(-1);
  });

  it('upsertRuntimeStatusMessage：无既有状态则新增，再次调用则原地更新', () => {
    const ctrl = makeController();
    upsertRuntimeStatusMessage(ctrl, 'queued', { streamId: 's1' });
    expect(ctrl.messages).toHaveLength(1);
    expect(ctrl.messages[0]).toMatchObject({ type: 'runtime_status', status: 'queued', streamId: 's1' });

    upsertRuntimeStatusMessage(ctrl, 'running');
    // 仍然只有一条，状态被更新
    expect(ctrl.messages).toHaveLength(1);
    expect(ctrl.messages[0]).toMatchObject({ type: 'runtime_status', status: 'running', content: '正在思考' });
  });

  it('upsertRuntimeStatusMessage：runId 归属不同的状态行不得原地覆盖（2026-08-04）', () => {
    // 旧行为：目标 run 的 running 会把插话 run 的 queued 状态行覆盖成「正在思考」，
    // 用户误以为排队消息已开始处理。归属不同必须新建一条。
    const ctrl = makeController();
    upsertRuntimeStatusMessage(ctrl, 'queued', { runId: 'interjection-run' });
    upsertRuntimeStatusMessage(ctrl, 'running', { runId: 'target-run' });
    expect(ctrl.messages).toHaveLength(2);
    expect(ctrl.messages[0]).toMatchObject({ type: 'runtime_status', status: 'queued', runId: 'interjection-run' });
    expect(ctrl.messages[1]).toMatchObject({ type: 'runtime_status', status: 'running', runId: 'target-run' });

    // 同 runId 仍原地更新
    upsertRuntimeStatusMessage(ctrl, 'waiting_hand', { runId: 'target-run' });
    expect(ctrl.messages).toHaveLength(2);
    expect(ctrl.messages[1]).toMatchObject({ type: 'runtime_status', status: 'waiting_hand', runId: 'target-run' });
  });

  it('removeRuntimeStatusMessages：有 setMessages 时过滤掉 runtime_status', () => {
    const ctrl = makeController([
      { id: 'r', type: 'runtime_status', status: 'queued' },
      { id: 't', type: 'text', content: 'hi' },
    ]);
    removeRuntimeStatusMessages(ctrl);
    expect(ctrl.messages).toHaveLength(1);
    expect(ctrl.messages[0].type).toBe('text');
  });

  it('finalizeStreamingMessages：把半开的 streaming 文本与 running 工具收尾', () => {
    const ctrl = makeController([
      { id: 't', type: 'text', content: 'x', streaming: true },
      { id: 'k', type: 'thinking', content: 'y', streaming: true, startedAt: Date.now() - 100 },
      { id: 'u', type: 'tool_use', toolName: 'Bash', toolInput: '', toolId: 'i1', executionStatus: 'running' },
    ]);
    finalizeStreamingMessages(ctrl);
    expect((ctrl.messages[0] as Extract<MessageItem, { type: 'text' }>).streaming).toBe(false);
    const think = ctrl.messages[1] as Extract<MessageItem, { type: 'thinking' }>;
    expect(think.streaming).toBe(false);
    expect(typeof think.durationMs).toBe('number');
    // 无 resultReady 的 running 工具落到 pending
    expect((ctrl.messages[2] as Extract<MessageItem, { type: 'tool_use' }>).executionStatus).toBe('pending');
  });

  it('finalizeRunningSubagents：running 子 agent 翻成 completed', () => {
    const ctrl = makeController([
      { id: 's', type: 'subagent', toolId: 't1', agentType: 'coder', status: 'running' },
      { id: 's2', type: 'subagent', toolId: 't2', agentType: 'coder', status: 'failed' },
    ]);
    finalizeRunningSubagents(ctrl);
    expect((ctrl.messages[0] as Extract<MessageItem, { type: 'subagent' }>).status).toBe('completed');
    // 非 running 的不动
    expect((ctrl.messages[1] as Extract<MessageItem, { type: 'subagent' }>).status).toBe('failed');
  });
});

// ══════════════════════════════════════════════════════════════════════
// processWsEvent 逐事件类型
// ══════════════════════════════════════════════════════════════════════

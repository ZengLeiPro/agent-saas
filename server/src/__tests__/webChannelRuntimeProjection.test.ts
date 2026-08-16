import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import { WebChannel, type WebChannelConfig } from '../channels/web/channel.js';
import type { AgentRunDispatch } from '../agent/types.js';
import { createExecutionConfig } from '../runtime/executionConfig.js';
import type { OutboundEvent } from '../types/index.js';
import {
  chatMessage,
  FakeWebSocket,
  flushMicrotasks,
  wsClient,
} from './webChannelTestHelpers.js';

const USER = { sub: 'runtime-projection-user', username: 'runtime_projection_user', role: 'user' as const, tenantId: 'runtime-projection' };

describe('WebChannel runtime event projection', () => {
  const channels: WebChannel[] = [];

  interface Rig {
    channel: WebChannel;
    ws: FakeWebSocket;
    userEvents: any[];
    sessionEvents: any[];
    send(user: typeof USER | undefined, overrides: Record<string, unknown>): Promise<void>;
  }

  function makeRig(extra: Partial<WebChannelConfig> = {}, dispatch?: AgentRunDispatch): Rig {
    const channel = new WebChannel({
      executionConfig: createExecutionConfig(),
      ...extra,
    }, dispatch ?? (async function* () { yield { type: 'done' as const }; }));
    channels.push(channel);
    const ws = new FakeWebSocket();
    const userEvents: any[] = [];
    const sessionEvents: any[] = [];
    (channel as any).eventBus = {
      emitReply: (target: any, data: any) => { target?.send?.(JSON.stringify({ data })); },
      emitSession: (ctx: any, data: any) => {
        sessionEvents.push(data);
        ctx?.ws?.send?.(JSON.stringify({ data }));
      },
      emitUser: (_uid: string, data: any) => { userEvents.push(data); },
      emitDual: (_uid: string, _sid: string, data: any) => { userEvents.push(data); },
    };
    return {
      channel, ws, userEvents, sessionEvents,
      send: async (user, overrides) => {
        await (channel as any).processChatMessage(wsClient(ws, user), chatMessage(overrides));
        await flushMicrotasks();
      },
    };
  }

  afterEach(async () => {
    for (const channel of channels) await channel.stop();
    channels.length = 0;
  });
  describe('publishRuntimeOutboundEvent', () => {
    it('WebChannel 未 start（无 eventBus）时丢弃事件且不建 buffer', () => {
      const channel = new WebChannel({}, async function* () { yield { type: 'done' as const }; });
      channels.push(channel);
      const sessionId = randomUUID();
      expect(() => channel.publishRuntimeOutboundEvent({
        sessionId, runId: 'run-drop-1', event: { type: 'text_delta', content: 'x' },
      })).not.toThrow();
      expect((channel as any).eventBufferStore.get(sessionId)).toBeUndefined();
    });

    it('后台运行在 ask_user 前广播 stream_started，当前会话可及时订阅提问事件', () => {
      const rig = makeRig();
      const sessionId = randomUUID();
      const base = { sessionId, runId: 'run-ask-live', userId: USER.sub };

      rig.channel.publishRuntimeOutboundEvent({
        ...base,
        event: { type: 'session_init', sessionId },
      });
      rig.channel.publishRuntimeOutboundEvent({
        ...base,
        event: {
          type: 'ask_user',
          interactionId: 'interaction-ask-live',
          questions: [{
            question: '是否继续？',
            header: '确认',
            options: [
              { label: '继续', description: '继续执行' },
              { label: '停止', description: '停止执行' },
            ],
            multiSelect: false,
          }],
        },
      });

      expect(rig.userEvents.slice(0, 2)).toEqual([
        {
          type: 'stream_started',
          sessionId,
          streamId: 'run-ask-live',
          runId: 'run-ask-live',
        },
        {
          type: 'session_status',
          sessionId,
          status: 'running',
          streamId: 'run-ask-live',
          runId: 'run-ask-live',
        },
      ]);
      expect(rig.sessionEvents.at(-1)).toMatchObject({
        type: 'ask_user',
        interactionId: 'interaction-ask-live',
      });
    });

    it('全事件类型映射：session/text/thinking/tool/交互/compaction → 前端事件；done 收口终态', () => {
      const rig = makeRig();
      const sessionId = randomUUID();
      const base = { sessionId, runId: 'run-out-1', userId: USER.sub, clientMsgId: 'cm-out-1' };
      const feed = (event: OutboundEvent) => rig.channel.publishRuntimeOutboundEvent({ ...base, event });

      feed({ type: 'session_init', sessionId });
      feed({ type: 'text_start' });
      feed({ type: 'text_delta', content: 'A' });
      feed({ type: 'text_end' });
      feed({ type: 'thinking_start' });
      feed({ type: 'thinking_delta', content: 'T' });
      feed({ type: 'thinking_end' });
      feed({ type: 'tool_start', toolId: 't1', toolName: 'Read' });
      feed({ type: 'tool_input_delta', toolId: 't1', toolName: 'Read', partialJson: '{"pa' });
      feed({ type: 'tool_end', toolName: 'Read' });
      feed({ type: 'tool_execution_start', toolId: 't1', toolName: 'Read', invocationId: 'inv-9' });
      feed({ type: 'tool_execution_end', toolId: 't1', toolName: 'Read', invocationId: 'inv-9', status: 'success', durationMs: 12 });
      feed({ type: 'tool_start', toolId: 'q1', toolName: 'AskUserQuestion' });   // 专属工具 → skip
      feed({ type: 'permission_request', interactionId: 'i-1', toolId: 'Shell', toolName: 'Shell', displayName: 'Run Shell', toolInput: { command: 'ls' } });
      feed({ type: 'compaction_start' });
      feed({ type: 'compaction_end', compaction: { summary: 's', coveredEventCount: 3 } } as unknown as OutboundEvent);
      feed({ type: 'done' });

      expect(rig.sessionEvents).toEqual([
        { type: 'session', sessionId, client_msg_id: 'cm-out-1' },
        { type: 'block_start', blockType: 'text', runId: 'run-out-1' },
        { type: 'text', content: 'A' },
        { type: 'block_end', blockType: 'text' },
        { type: 'block_start', blockType: 'thinking' },
        { type: 'thinking', content: 'T' },
        { type: 'block_end', blockType: 'thinking' },
        { type: 'block_start', blockType: 'tool_use', toolId: 't1', toolName: 'Read' },
        { type: 'tool_input', toolId: 't1', toolName: 'Read', content: '{"pa' },
        { type: 'block_end', blockType: 'tool_use', toolName: 'Read' },
        { type: 'tool_execution', phase: 'started', toolId: 't1', toolName: 'Read', invocationId: 'inv-9' },
        { type: 'tool_execution', phase: 'completed', toolId: 't1', toolName: 'Read', invocationId: 'inv-9', status: 'success', durationMs: 12 },
        {
          type: 'permission_request', interactionId: 'i-1', toolId: 'Shell', toolName: 'Shell',
          displayName: 'Run Shell', toolInput: { command: 'ls' },
        },
        { type: 'compaction_status', phase: 'started' },
        { type: 'compaction_status', phase: 'completed', compaction: { summary: 's', coveredEventCount: 3 } },
        {
          type: 'done', sessionId, streamId: 'run-out-1', runId: 'run-out-1',
          client_msg_id: 'cm-out-1', finalOutput: true,
        },
      ]);
      // session_init → stream_started + running；done → completed + session_updated；buffer 收口
      expect(rig.userEvents.slice(0, 2)).toEqual([
        {
          type: 'stream_started', sessionId, streamId: 'run-out-1', runId: 'run-out-1',
        },
        {
          type: 'session_status', sessionId, status: 'running', streamId: 'run-out-1', runId: 'run-out-1',
        },
      ]);
      expect(rig.userEvents).toContainEqual(expect.objectContaining({ type: 'session_status', status: 'completed' }));
      expect(rig.userEvents).toContainEqual(expect.objectContaining({ type: 'session_updated', sessionId }));
      expect((rig.channel as any).eventBufferStore.isActive(sessionId)).toBe(false);
      expect((rig.channel as any).inProcessOutboundRuns.has('run-out-1')).toBe(false);
    });

    it('最终输出标记：实时文本绑定 runId，成功 done 追认 finalOutput', () => {
      const rig = makeRig();
      const sessionId = randomUUID();
      const base = { sessionId, runId: 'run-final-live', userId: USER.sub, clientMsgId: 'cm-final-live' };

      rig.channel.publishRuntimeOutboundEvent({ ...base, event: { type: 'session_init', sessionId } });
      rig.channel.publishRuntimeOutboundEvent({ ...base, event: { type: 'text_start' } });
      rig.channel.publishRuntimeOutboundEvent({ ...base, event: { type: 'text_delta', content: '最终回答' } });
      rig.channel.publishRuntimeOutboundEvent({ ...base, event: { type: 'text_end' } });
      rig.channel.publishRuntimeOutboundEvent({ ...base, event: { type: 'done' } });

      expect(rig.sessionEvents).toContainEqual({
        type: 'block_start', blockType: 'text', runId: 'run-final-live',
      });
      expect(rig.sessionEvents.at(-1)).toMatchObject({
        type: 'done', runId: 'run-final-live', finalOutput: true,
      });
    });

    it('error 事件：done 携带 error + session_status failed（带 reason），buffer 收口', () => {
      const rig = makeRig();
      const sessionId = randomUUID();
      const base = { sessionId, runId: 'run-out-err', userId: USER.sub, clientMsgId: 'cm-out-e' };
      rig.channel.publishRuntimeOutboundEvent({ ...base, event: { type: 'session_init', sessionId } });
      rig.channel.publishRuntimeOutboundEvent({ ...base, event: { type: 'error', error: 'runtime blew up' } });
      expect(rig.sessionEvents.at(-1)).toEqual({
        type: 'done',
        sessionId,
        streamId: 'run-out-err',
        runId: 'run-out-err',
        client_msg_id: 'cm-out-e',
        error: 'runtime blew up',
      });
      expect(rig.userEvents.at(-1)).toEqual({
        type: 'session_status', sessionId, status: 'failed',
        streamId: 'run-out-err', runId: 'run-out-err', reason: 'runtime blew up',
      });
      expect((rig.channel as any).eventBufferStore.isActive(sessionId)).toBe(false);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // 6. publishRuntimePlatformEvent 补充分支
  // ════════════════════════════════════════════════════════════════════

  describe('publishRuntimePlatformEvent 补充', () => {
    it('session_group_changed 跨进程刷新会话列表与分组', () => {
      const rig = makeRig();
      const sessionId = randomUUID();

      rig.channel.publishRuntimePlatformEvent({
        id: 'evt-group-1',
        timestamp: new Date().toISOString(),
        type: 'session_group_changed',
        sessionId,
        userId: USER.sub,
        groupId: 'cron:job-1',
      });

      expect(rig.userEvents).toEqual([
        {
          type: 'session_updated',
          sessionId,
          updatedAtMs: expect.any(Number),
          isNew: true,
        },
        { type: 'groups_changed' },
      ]);
    });

    it('非终态 run_state_changed 投影 lifecycle session_status；run_finished success 空投影跳过', () => {
      const rig = makeRig();
      const sessionId = randomUUID();
      rig.channel.publishRuntimePlatformEvent({
        id: 'evt-life-1', timestamp: new Date().toISOString(),
        type: 'run_state_changed', runId: 'run-life-1', sessionId,
        status: 'running', previousStatus: 'pending',
      } as any);
      const buffer = (rig.channel as any).eventBufferStore.get(sessionId);
      expect(buffer.events.map((e: { data: string }) => JSON.parse(e.data))).toEqual([
        { type: 'session_status', sessionId, status: 'running', runId: 'run-life-1' },
      ]);
      expect((rig.channel as any).eventBufferStore.isActive(sessionId)).toBe(true);

      const successSession = randomUUID();
      rig.channel.publishRuntimePlatformEvent({
        id: 'evt-life-2', timestamp: new Date().toISOString(),
        type: 'run_finished', runId: 'run-life-2', sessionId: successSession,
        subtype: 'success', numTurns: 1,
      } as any);
      expect((rig.channel as any).eventBufferStore.get(successSession)).toBeUndefined();
    });

    it('最终输出标记：跨进程 completed 终态携带 finalOutput', () => {
      const rig = makeRig();
      const sessionId = randomUUID();

      rig.channel.publishRuntimePlatformEvent({
        id: 'evt-final-cross', timestamp: new Date().toISOString(),
        type: 'run_state_changed', runId: 'run-final-cross', sessionId,
        status: 'completed', previousStatus: 'running',
      } as any);

      const buffer = (rig.channel as any).eventBufferStore.get(sessionId);
      expect(buffer.events.map((entry: { data: string }) => JSON.parse(entry.data))).toContainEqual({
        type: 'done', sessionId, runId: 'run-final-cross', finalOutput: true,
      });
    });

    it('run_state_changed(cancelled) 终态：正常结束流但不携带 error', () => {
      const rig = makeRig();
      const sessionId = randomUUID();
      (rig.channel as any).activeStreams.set('st-cancelled', {
        controller: new AbortController(), userId: USER.sub, ws: rig.ws,
        sessionId, runId: 'run-cancelled', clientMsgId: 'cm-cancelled',
      });
      (rig.channel as any).wsActiveStream.set(rig.ws, 'st-cancelled');

      rig.channel.publishRuntimePlatformEvent({
        id: 'evt-cancelled', timestamp: new Date().toISOString(),
        type: 'run_state_changed', runId: 'run-cancelled', sessionId,
        status: 'cancelled', previousStatus: 'running', reason: 'web_abort',
      } as any);

      expect(rig.ws.sent.map((message) => message.data)).toEqual([
        {
          type: 'session_status', sessionId, status: 'cancelled',
          runId: 'run-cancelled', reason: 'web_abort',
        },
        {
          type: 'done', sessionId, runId: 'run-cancelled', client_msg_id: 'cm-cancelled',
        },
      ]);
      expect(rig.userEvents).toContainEqual(expect.objectContaining({
        type: 'session_status', sessionId, status: 'cancelled',
      }));
      expect((rig.channel as any).activeStreams.has('st-cancelled')).toBe(false);
      expect((rig.channel as any).eventBufferStore.isActive(sessionId)).toBe(false);
    });

    it('run_finished(error) 终态：done+error 直推、幂等回填 failed、与后续 run_state_changed(failed) 跨事件去重', async () => {
      const rig = makeRig();
      const sessionId = randomUUID();
      (rig.channel as any).activeStreams.set('st-pe', {
        controller: new AbortController(), userId: USER.sub, ws: rig.ws,
        sessionId, runId: 'run-pe-1', clientMsgId: 'cm-pe-1',
      });
      (rig.channel as any).wsActiveStream.set(rig.ws, 'st-pe');
      rig.channel.publishRuntimePlatformEvent({
        id: 'evt-pe-1', timestamp: new Date().toISOString(),
        type: 'run_finished', runId: 'run-pe-1', sessionId,
        subtype: 'error', numTurns: 1, error: 'boom from worker',
      } as any);
      expect(rig.ws.sent.at(-1)?.data).toEqual({
        type: 'done',
        sessionId,
        runId: 'run-pe-1',
        client_msg_id: 'cm-pe-1',
        error: 'boom from worker',
      });
      expect(rig.userEvents).toContainEqual(expect.objectContaining({
        type: 'session_status', sessionId, status: 'failed', reason: 'boom from worker',
      }));
      expect((rig.channel as any).activeStreams.has('st-pe')).toBe(false);

      // 同 runId 的派生 run_state_changed(failed) 到达 → 去重，不再发第二次 done
      const sentBefore = rig.ws.sent.length;
      const bufferLenBefore = (rig.channel as any).eventBufferStore.get(sessionId).events.length;
      rig.channel.publishRuntimePlatformEvent({
        id: 'evt-pe-2', timestamp: new Date().toISOString(),
        type: 'run_state_changed', runId: 'run-pe-1', sessionId,
        status: 'failed', previousStatus: 'running', reason: 'boom from worker',
      } as any);
      expect(rig.ws.sent.length).toBe(sentBefore);
      expect((rig.channel as any).eventBufferStore.get(sessionId).events.length).toBe(bufferLenBefore);

      // 终态幂等回填：同 clientMsgId 再发 chat → 原 failed ACK，不创建新 run。
      rig.ws.sent.length = 0;
      await rig.send(USER, { client_msg_id: 'cm-pe-1', message: '重试' });
      expect(rig.ws.sent[0].data).toMatchObject({
        type: 'chat_ack', client_msg_id: 'cm-pe-1', runId: 'run-pe-1', status: 'failed',
      });
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // 7. 持久化交互恢复（file-backed runtime events）
  // ════════════════════════════════════════════════════════════════════

});

/**
 * WebChannel 覆盖补齐测试（channel.ts 专项，2026-07-19 第二批）
 *
 * 与既有 4 个 webChannel 测试文件的分工（本文件只补缺口，不重复）：
 *   - webChannelExecutionTarget.test.ts：executionTarget 门禁、enqueue-only 主路径、
 *     getStreamStatus runStore/buffer 事实源取舍、durable approval/failed run 投影。
 *   - webChannelGuardrail.test.ts：专职 Agent 门禁全链路（off/shadow/enforce 三档、
 *     org gate、personalAgent gate、F1a/F1b 收口、合成拒答气泡、guardrail_events 落库）。
 *   - webChannelReconnect.test.ts：handleResume/handleResumeAsync 重连回放、幽灵 buffer
 *     收口、resume 串行化、streamed 聚合展开、context_usage（outbound 路径）脱敏。
 *   - webChannelPureLogicCoverage.test.ts：兄弟模块（displayFilter/EventBufferStore/
 *     UserEventLog/EventBus）纯逻辑。
 *
 * 本文件覆盖 channel.ts 尚未触达的行为：
 *   1. WS 控制消息处理器：handleAbort（runId/streamId/终态/越权/durable 取消链）、
 *      handleApprovalPolicy、handleRunStatus、handleSync、handleDetach、
 *      handleRespond/resolveInteraction（内存交互 resolve + 归属校验）。
 *   2. processChatMessage 前置校验：drain、空消息、禁用租户、会话归属、消息幂等
 *      （in_flight 重发 / durable run 幂等）、model_not_allowed、语音 STT 三态。
 *   3. handleEvents 流式管道（非 enqueue dispatch 路径）：文本缓冲/VOICE 标记三态、
 *      FILE 标记 file_download、thinking/tool displayFilter、SDK error 终态、
 *      幽灵会话回滚、context_usage 脱敏、notification/memory_recall/plugin_install、
 *      onResult token 记账 + session cost 落盘。
 *   4. onInteraction 授权模式安全审计：安全工具白名单/mcp 前缀、Shell 命令审计
 *      （env 探测/越界文件操作/重定向/路径穿越）、文件工具路径字段审计（settings
 *      保护/extraDirs/共享 skills）、平台 admin 自动放行、用户停止拒绝、
 *      人工审批 round-trip（含 ExitPlanMode planContent）。
 *   5. publishRuntimeOutboundEvent：未 start 丢弃、全事件类型映射、done/error 终态。
 *   6. publishRuntimePlatformEvent：非终态 lifecycle、run_finished success 跳过、
 *      run_finished error + 跨事件终态去重 + 终态幂等回填。
 *   7. 持久化交互恢复（file-backed runtime events）：ask_user / approval 的
 *      enqueue resume、already-accepted 幂等、终态 run 拒绝、legacy
 *      resumeApprovalDispatch 路径。
 *   8. 自动命名：首条长消息提前生成、失败终态补偿、meta 落盘与会话级并发幂等。
 *   9. 生命周期杂项：disconnectUser/disconnectTenant、getActiveStreamCount、
 *      getStreamStatus runStore 异常降级、attachToServer 前置校验。
 */

import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { WebChannel, type WebChannelConfig } from '../channels/web/channel.js';
import { interactionStore } from '../channels/web/interactionStore.js';
import { UserEventLog } from '../channels/web/userEventLog.js';
import type { AgentRunDispatch, InteractionResponse } from '../agent/types.js';
import type { OutboundEvent, ChannelContext } from '../types/index.js';
import { createExecutionConfig } from '../runtime/executionConfig.js';
import { FileSessionCatalog } from '../runtime/sessionCatalog.js';
import { FileEventStore, getRuntimeEventLogPath } from '../runtime/fileEventStore.js';
import type { UpsertRunInput } from '../runtime/runStore.js';
import { runtimeRunController } from '../runtime/runController.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import { getTranscriptPath } from '../data/transcripts/index.js';
import { AGENT_LEGACY_TRANSCRIPTS_ROOT } from '../data/transcripts/projectKey.js';
import { readSessionMeta, writeSessionMeta, type SessionMeta } from '../data/transcripts/meta.js';
import { resolveUserCwd } from '../workspace/resolver.js';
import { speechToText } from '../integrations/stt/sttClient.js';
import type { SttConfig } from '../integrations/stt/sttClient.js';
import type { TenantStore } from '../data/tenants/store.js';
import type { UserStore } from '../data/users/store.js';
import type { TokenUsageStore } from '../data/usage/store.js';
import {
  chatMessage,
  enabledTenantStore,
  FakeWebSocket,
  flushMicrotasks,
  MemoryRunStore,
  wsClient,
} from './webChannelTestHelpers.js';

// ── 模块 mock ──────────────────────────────────────────────────────────

// STT：只拦上游语音识别调用，channel 侧编排逻辑真实执行
vi.mock('../integrations/stt/sttClient.js', () => ({ speechToText: vi.fn() }));
const sttMock = vi.mocked(speechToText);

// openai：自动命名（titleGenerator）上游，返回固定标题并记录调用
vi.mock('openai', () => {
  class MockOpenAI {
    constructor(_opts: unknown) {}
    chat = {
      completions: {
        create: async (req: { model: string }) => {
          const calls: string[] = ((globalThis as any).__covOpenAiCalls ??= []);
          calls.push(req.model);
          return {
            id: 'mock-title',
            choices: [{ message: { content: '覆盖补齐测试标题' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
          };
        },
      },
    };
  }
  return { default: MockOpenAI };
});

function openAiCalls(): string[] {
  return ((globalThis as any).__covOpenAiCalls ??= []);
}

// ── 测试基建（照 webChannelGuardrail / webChannelExecutionTarget 模式）──

/** 本文件专属租户/用户（唯一后缀防串扰；transcript 落 home 目录，afterAll 定点清理） */
const RUN_TAG = randomUUID().slice(0, 8);
const TENANT = `covw${RUN_TAG}`;
const USER = { sub: `cov-user-${RUN_TAG}`, username: `cov_user_${RUN_TAG}`, role: 'user' as const, tenantId: TENANT };
const OTHER_USER = { sub: `cov-other-${RUN_TAG}`, username: `cov_other_${RUN_TAG}`, role: 'user' as const, tenantId: TENANT };
const ORG_ADMIN = { sub: `cov-oadmin-${RUN_TAG}`, username: `cov_oadmin_${RUN_TAG}`, role: 'admin' as const, tenantId: TENANT };
const P_ADMIN = { sub: `cov-padmin-${RUN_TAG}`, username: `cov_padmin_${RUN_TAG}`, role: 'admin' as const, tenantId: DEFAULT_TENANT_ID };

type TestUser = typeof USER;

/** 会话固定资产：meta（可被 findTranscriptOrMetaPathBySessionId 全局定位）+ runtime 事件日志 */
async function seedRuntimeSession(
  user: TestUser | typeof ORG_ADMIN,
  metaExtra: Partial<SessionMeta> = {},
): Promise<{ sessionId: string; transcriptPath: string; eventStore: FileEventStore }> {
  const sessionId = randomUUID();
  const transcriptPath = getTranscriptPath('/unused-cwd', sessionId, { tenantId: user.tenantId, userId: user.sub });
  await writeSessionMeta(transcriptPath, {
    userId: user.sub,
    username: user.username,
    tenantId: user.tenantId,
    channel: 'web',
    createdAt: new Date().toISOString(),
    ...metaExtra,
  });
  return { sessionId, transcriptPath, eventStore: new FileEventStore(getRuntimeEventLogPath(transcriptPath), user.tenantId) };
}

describe('WebChannel channel.ts 覆盖补齐', () => {
  const channels: WebChannel[] = [];
  const dirs: string[] = [];

  interface Rig {
    channel: WebChannel;
    ws: FakeWebSocket;
    userEvents: any[];
    sessionEvents: any[];
    send(user: TestUser | typeof P_ADMIN | typeof ORG_ADMIN | undefined, overrides: Record<string, unknown>): Promise<void>;
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

  async function makeTmp(prefix: string): Promise<string> {
    const tmp = await mkdtemp(join(tmpdir(), prefix));
    dirs.push(tmp);
    return tmp;
  }

  afterEach(async () => {
    try {
      for (const channel of channels) await channel.stop();
    } finally {
      channels.length = 0;
    }
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
    dirs.length = 0;
    sttMock.mockReset();
  });

  afterAll(async () => {
    // transcript/meta 固定落 home canonical root，按本文件专属租户/用户定点清理
    await rm(join(AGENT_LEGACY_TRANSCRIPTS_ROOT, TENANT), { recursive: true, force: true });
    await rm(join(AGENT_LEGACY_TRANSCRIPTS_ROOT, DEFAULT_TENANT_ID, P_ADMIN.sub), { recursive: true, force: true });
  });

  // ════════════════════════════════════════════════════════════════════
  // 1. WS 控制消息处理器
  // ════════════════════════════════════════════════════════════════════

  describe('handleAbort', () => {
    it('缺 runId/streamId → error；runId 与 streamId 指向不同流 → error', async () => {
      const rig = makeRig();
      await (rig.channel as any).handleAbortAsync(wsClient(rig.ws, USER), { action: 'abort' });
      expect(rig.ws.sent.at(-1)?.data).toEqual({ type: 'error', message: 'runId is required' });

      (rig.channel as any).activeStreams.set('st-a', {
        controller: new AbortController(), userId: USER.sub, ws: rig.ws, sessionId: 's-a', runId: 'run-mm',
      });
      await (rig.channel as any).handleAbortAsync(wsClient(rig.ws, USER), { action: 'abort', runId: 'run-mm', streamId: 'st-other' });
      expect(rig.ws.sent.at(-1)?.data).toEqual({ type: 'error', message: 'runId and streamId do not match' });
    });

    it('非 admin 中止他人活跃流（legacy streamId 路径）→ Access denied，流不受影响', async () => {
      const rig = makeRig();
      const controller = new AbortController();
      (rig.channel as any).activeStreams.set('st-b', {
        controller, userId: OTHER_USER.sub, ws: rig.ws, sessionId: 's-b',
      });
      await (rig.channel as any).handleAbortAsync(wsClient(rig.ws, USER), { action: 'abort', streamId: 'st-b' });
      expect(rig.ws.sent.at(-1)?.data).toEqual({ type: 'error', message: 'Access denied' });
      expect(controller.signal.aborted).toBe(false);
    });

    it('legacy streamId-only：本人流被中止并回 abort_ok{streamId}', async () => {
      const rig = makeRig();
      const controller = new AbortController();
      (rig.channel as any).activeStreams.set('st-c', {
        controller, userId: USER.sub, ws: rig.ws, sessionId: 's-c',
      });
      await (rig.channel as any).handleAbortAsync(wsClient(rig.ws, USER), { action: 'abort', streamId: 'st-c' });
      expect(controller.signal.aborted).toBe(true);
      expect(controller.signal.reason).toBe('web_abort');
      expect(rig.ws.sent.at(-1)?.data).toEqual({ type: 'abort_ok', streamId: 'st-c' });
    });

    it('runId 指向终态 run → 幂等 abort_ok + 回放终态 session_status，不再改写 runStore', async () => {
      const runStore = new MemoryRunStore();
      await runStore.upsertPending({ runId: 'run-term-a', sessionId: 's-term-a', userId: USER.sub, model: 'm', channel: 'web' });
      await runStore.markStatus('run-term-a', 'completed', 'all done');
      const markSpy = vi.spyOn(runStore, 'markStatus');
      const rig = makeRig({
        enqueueRuntime: { scheduler: {} as any, runStore, sessionCatalog: {} as any, enabled: true },
      });
      await (rig.channel as any).handleAbortAsync(wsClient(rig.ws, USER), { action: 'abort', runId: 'run-term-a' });
      const types = rig.ws.sent.map((m) => m.data?.type);
      expect(types).toEqual(['abort_ok', 'session_status']);
      expect(rig.ws.sent[0].data).toEqual({ type: 'abort_ok', runId: 'run-term-a' });
      expect(rig.ws.sent[1].data).toEqual({
        type: 'session_status', sessionId: 's-term-a', status: 'completed', runId: 'run-term-a', reason: 'all done',
      });
      expect(markSpy).not.toHaveBeenCalled();
      expect((await runStore.get('run-term-a'))?.status).toBe('completed');
    });

    it.each(['completed', 'failed', 'orphaned'] as const)(
      'run 已 %s 的 stop 重试只回权威终态，不扫描或登记工具取消',
      async (terminalStatus) => {
        const runStore = new MemoryRunStore();
        const runId = `run-terminal-no-cancel-${terminalStatus}`;
        const sessionId = `session-terminal-no-cancel-${terminalStatus}`;
        await runStore.upsertPending({ runId, sessionId, userId: USER.sub, model: 'm', channel: 'web' });
        await runStore.markStatus(runId, terminalStatus, `${terminalStatus}-reason`);
        const cancelPendingSteering = vi.fn(async () => []);
        (runStore as any).cancelSteeringBeforeDispatchBySession = cancelPendingSteering;
        const toolInvocationStore = {
          listRunning: vi.fn(async () => [{
            invocationId: `inv-terminal-no-cancel-${terminalStatus}`,
            runId,
            sessionId,
            toolCallId: 'call-terminal-no-cancel',
            toolName: 'Shell',
          }]),
          requestCancelOnce: vi.fn(),
        };
        const rig = makeRig({
          enqueueRuntime: {
            scheduler: {} as any, runStore, sessionCatalog: {} as any,
            toolInvocationStore: toolInvocationStore as any, enabled: true,
          },
        });

        await (rig.channel as any).handleAbortAsync(wsClient(rig.ws, USER), { action: 'abort', runId });

        expect(cancelPendingSteering).not.toHaveBeenCalled();
        expect(toolInvocationStore.listRunning).not.toHaveBeenCalled();
        expect(toolInvocationStore.requestCancelOnce).not.toHaveBeenCalled();
        expect(rig.ws.sent.at(-2)?.data).toEqual({ type: 'abort_ok', runId });
        expect(rig.ws.sent.at(-1)?.data).toMatchObject({
          type: 'session_status', sessionId, status: terminalStatus, runId,
        });
      },
    );

    it('run 已 cancelled 的 stop 重试仍会重放 durable 工具取消，不依赖首次取消事件', async () => {
      const runStore = new MemoryRunStore();
      await runStore.upsertPending({ runId: 'run-term-tool', sessionId: 's-term-tool', userId: USER.sub, model: 'm', channel: 'web' });
      await runStore.markStatus('run-term-tool', 'cancelled', 'web_abort');
      const cancelPendingSteering = vi.fn(async () => []);
      (runStore as any).cancelSteeringBeforeDispatchBySession = cancelPendingSteering;
      const toolInvocationStore = {
        listRunning: vi.fn(async () => [{
          invocationId: 'inv-term-tool', runId: 'run-term-tool', sessionId: 's-term-tool',
          toolCallId: 'call-term-tool', toolName: 'Shell', cancelRequestedAt: '2026-08-15T00:00:00.000Z',
        }]),
        requestCancelOnce: vi.fn(async () => ({
          created: false,
          record: { invocationId: 'inv-term-tool', cancelRequestedAt: '2026-08-15T00:00:00.000Z', metadata: {} },
        })),
      };
      const rig = makeRig({
        enqueueRuntime: {
          scheduler: {} as any, runStore, sessionCatalog: {} as any,
          toolInvocationStore: toolInvocationStore as any, enabled: true,
        },
      });

      await (rig.channel as any).handleAbortAsync(wsClient(rig.ws, USER), { action: 'abort', runId: 'run-term-tool' });

      expect(cancelPendingSteering).not.toHaveBeenCalled();
      expect(toolInvocationStore.requestCancelOnce).toHaveBeenCalledWith(
        'inv-term-tool', 'web_abort', { requestedBy: USER.sub },
      );
      expect(rig.ws.sent.at(-2)?.data).toEqual({ type: 'abort_ok', runId: 'run-term-tool' });
      expect(rig.ws.sent.at(-1)?.data).toMatchObject({
        type: 'session_status', sessionId: 's-term-tool', status: 'cancelled', runId: 'run-term-tool',
      });
    });

    it('非 admin 通过 runId 中止他人 durable run → Access denied', async () => {
      const runStore = new MemoryRunStore();
      await runStore.upsertPending({ runId: 'run-other-1', sessionId: 's-other-1', userId: OTHER_USER.sub, model: 'm', channel: 'web' });
      await runStore.markStatus('run-other-1', 'running');
      const rig = makeRig({
        enqueueRuntime: { scheduler: {} as any, runStore, sessionCatalog: {} as any, enabled: true },
      });
      await (rig.channel as any).handleAbortAsync(wsClient(rig.ws, USER), { action: 'abort', runId: 'run-other-1' });
      expect(rig.ws.sent.at(-1)?.data).toEqual({ type: 'error', message: 'Access denied' });
      expect((await runStore.get('run-other-1'))?.status).toBe('running');
    });

    it('原子 stop 未实际更新 waiting target 时必须 fallback，不能仅凭 targetRunId 回 abort_ok', async () => {
      const runStore = new MemoryRunStore();
      await runStore.upsertPending({ runId: 'run-waiting-stop', sessionId: 'session-waiting-stop', userId: USER.sub, channel: 'web' });
      await runStore.markStatus('run-waiting-stop', 'waiting_user');
      (runStore as any).cancelSteeringBeforeDispatchBySessionWithEvent = vi.fn(async (
        _sessionId: string,
        _reason: string,
        _targetRunId: string,
        event: Record<string, unknown>,
      ) => ({
        cancelled: [],
        targetCancelled: false,
        event: { id: 'event-stop', timestamp: new Date().toISOString(), ...event },
        eventCreated: true,
      }));
      const markSpy = vi.spyOn(runStore, 'markStatus');
      const rig = makeRig({
        enqueueRuntime: { scheduler: {} as any, runStore, sessionCatalog: {} as any, enabled: true },
      });

      await (rig.channel as any).handleAbortAsync(
        wsClient(rig.ws, USER),
        { action: 'abort', runId: 'run-waiting-stop' },
      );

      expect(markSpy).toHaveBeenCalledWith('run-waiting-stop', 'cancelled', 'web_abort');
      await expect(runStore.get('run-waiting-stop')).resolves.toMatchObject({ status: 'cancelled' });
      expect(rig.ws.sent.at(-1)?.data).toEqual({ type: 'abort_ok', runId: 'run-waiting-stop' });
    });

    it('stop 锁到并发 completed target 时只回放权威终态，不补写取消事件', async () => {
      const runStore = new MemoryRunStore();
      await runStore.upsertPending({ runId: 'run-stop-race', sessionId: 'session-stop-race', userId: USER.sub, channel: 'web' });
      await runStore.markStatus('run-stop-race', 'running');
      (runStore as any).cancelSteeringBeforeDispatchBySessionWithEvent = vi.fn(async () => {
        const current = await runStore.get('run-stop-race');
        runStore.records.set('run-stop-race', { ...current!, status: 'completed' });
        return { cancelled: [], targetCancelled: false, eventCreated: false };
      });
      const originalMarkStatus = runStore.markStatus.bind(runStore);
      vi.spyOn(runStore, 'markStatus').mockImplementation(async (runId, status, reason, metadata) => (
        status === 'cancelled'
          ? runStore.get(runId)
          : originalMarkStatus(runId, status, reason, metadata)
      ));
      const rig = makeRig({
        enqueueRuntime: { scheduler: {} as any, runStore, sessionCatalog: {} as any, enabled: true },
      });

      await (rig.channel as any).handleAbortAsync(
        wsClient(rig.ws, USER),
        { action: 'abort', runId: 'run-stop-race' },
      );

      await expect(runStore.get('run-stop-race')).resolves.toMatchObject({ status: 'completed' });
      expect(rig.ws.sent.at(-2)?.data).toEqual({ type: 'abort_ok', runId: 'run-stop-race' });
      expect(rig.ws.sent.at(-1)?.data).toEqual({
        type: 'session_status', sessionId: 'session-stop-race', status: 'completed', runId: 'run-stop-race',
      });
    });

    it('durable 取消全链：落 run_cancel_requested + 工具 invocation 取消 + runStore cancelled + controller/runtimeRunController 双中止', async () => {
      const tmp = await makeTmp('cov-abort-');
      const { sessionId, transcriptPath, eventStore } = await seedRuntimeSession(USER);
      const runStore = new MemoryRunStore();
      await runStore.upsertPending({ runId: 'run-ab-1', sessionId, userId: USER.sub, model: 'm', channel: 'web' });
      await runStore.markStatus('run-ab-1', 'running');
      const toolInvocationStore = {
        listRunning: vi.fn(async () => [
          { invocationId: 'inv-1', runId: 'run-ab-1', toolCallId: 'call-1', toolName: 'Shell' },
          { invocationId: 'inv-x', runId: 'run-unrelated', toolCallId: 'call-x', toolName: 'Read' },
        ]),
        requestCancelOnce: vi.fn(async () => ({
          created: true,
          record: { metadata: { cancelledBy: 'ops' } },
        })),
      };
      const rig = makeRig({
        agentCwd: tmp,
        runtimeEventStoreFor: (tp) => new FileEventStore(getRuntimeEventLogPath(tp), TENANT),
        enqueueRuntime: {
          scheduler: {} as any, runStore, sessionCatalog: {} as any,
          toolInvocationStore: toolInvocationStore as any, enabled: true,
        },
      });
      const controller = new AbortController();
      (rig.channel as any).activeStreams.set('st-d', {
        controller, userId: USER.sub, ws: rig.ws, sessionId, runId: 'run-ab-1',
      });
      const runtimeController = new AbortController();
      runtimeRunController.register('run-ab-1', runtimeController);
      try {
        await (rig.channel as any).handleAbortAsync(wsClient(rig.ws, USER), { action: 'abort', runId: 'run-ab-1' });
      } finally {
        runtimeRunController.unregister('run-ab-1');
      }

      expect(rig.ws.sent.at(-1)?.data).toEqual({ type: 'abort_ok', streamId: 'st-d', runId: 'run-ab-1' });
      expect(controller.signal.aborted).toBe(true);
      expect(runtimeController.signal.aborted).toBe(true);
      const record = await runStore.get('run-ab-1');
      expect(record).toMatchObject({ status: 'cancelled', statusReason: 'web_abort' });
      // 只取消属于本 run 的 invocation
      expect(toolInvocationStore.requestCancelOnce).toHaveBeenCalledTimes(1);
      expect(toolInvocationStore.requestCancelOnce).toHaveBeenCalledWith('inv-1', 'web_abort', { requestedBy: USER.sub });
      // durable 事件日志：run_cancel_requested + tool_invocation_cancel_requested
      const events = await eventStore.list(TENANT, sessionId);
      expect(events.map((e) => e.type)).toEqual(['run_cancel_requested', 'tool_invocation_cancel_requested']);
      expect(events[0]).toMatchObject({ runId: 'run-ab-1', userId: USER.sub, reason: 'web_abort', streamId: 'st-d' });
      expect(events[1]).toMatchObject({
        invocationId: 'inv-1', toolCallId: 'call-1', toolName: 'Shell', metadata: { cancelledBy: 'ops' },
      });
      void transcriptPath;
    });
  });

  describe('handleApprovalPolicy', () => {
    function policyRig(runStore: MemoryRunStore): Rig {
      return makeRig({
        enqueueRuntime: { scheduler: {} as any, runStore, sessionCatalog: {} as any, enabled: true },
      });
    }

    it('无用户 / 缺 runId / run 不存在 → 各自错误码', async () => {
      const runStore = new MemoryRunStore();
      const rig = policyRig(runStore);
      await (rig.channel as any).handleApprovalPolicy(wsClient(rig.ws), { action: 'approval_policy', runId: 'r' });
      expect(rig.ws.sent.at(-1)?.data).toEqual({ type: 'error', message: 'Access denied' });
      await (rig.channel as any).handleApprovalPolicy(wsClient(rig.ws, USER), { action: 'approval_policy', runId: '  ' });
      expect(rig.ws.sent.at(-1)?.data).toEqual({ type: 'error', message: 'runId is required' });
      await (rig.channel as any).handleApprovalPolicy(wsClient(rig.ws, USER), { action: 'approval_policy', runId: 'missing' });
      expect(rig.ws.sent.at(-1)?.data).toEqual({ type: 'error', message: 'Run not found' });
    });

    it('组织 admin 不能改他人 run；owner 传错 sessionId 也拒绝', async () => {
      const runStore = new MemoryRunStore();
      await runStore.upsertPending({ runId: 'run-pol-1', sessionId: 's-pol-1', userId: USER.sub, model: 'm', channel: 'web' });
      const rig = policyRig(runStore);
      // 组织 admin（非平台租户）→ 只能改自己的 run
      await (rig.channel as any).handleApprovalPolicy(wsClient(rig.ws, ORG_ADMIN), {
        action: 'approval_policy', runId: 'run-pol-1', approvalPolicy: { autoApproveTools: true },
      });
      expect(rig.ws.sent.at(-1)?.data).toEqual({ type: 'error', message: 'Access denied' });
      // owner + sessionId 不匹配
      await (rig.channel as any).handleApprovalPolicy(wsClient(rig.ws, USER), {
        action: 'approval_policy', runId: 'run-pol-1', sessionId: 'wrong-session', approvalPolicy: { autoApproveTools: true },
      });
      expect(rig.ws.sent.at(-1)?.data).toEqual({ type: 'error', message: 'Access denied' });
      expect((await runStore.get('run-pol-1'))?.metadata?.approvalPolicy).toBeUndefined();
    });

    it('owner 开启（legacy autoApproveRunShell 同义）→ metadata.approvalPolicy 归一化；平台 admin 关闭他人 run → null', async () => {
      const runStore = new MemoryRunStore();
      await runStore.upsertPending({ runId: 'run-pol-2', sessionId: 's-pol-2', userId: USER.sub, model: 'm', channel: 'web' });
      await runStore.markStatus('run-pol-2', 'running');
      const rig = policyRig(runStore);

      await (rig.channel as any).handleApprovalPolicy(wsClient(rig.ws, USER), {
        action: 'approval_policy', runId: 'run-pol-2', sessionId: 's-pol-2',
        approvalPolicy: { autoApproveRunShell: true },
      });
      expect(rig.ws.sent.at(-1)?.data).toEqual({ type: 'approval_policy_ok', runId: 'run-pol-2', sessionId: 's-pol-2' });
      let record = await runStore.get('run-pol-2');
      // legacy 字段归一化为 { autoApproveTools: true }；status 保持不变
      expect(record).toMatchObject({
        status: 'running', statusReason: 'approval_policy_updated',
        metadata: { approvalPolicy: { autoApproveTools: true } },
      });

      // 平台 admin 可跨用户关闭
      await (rig.channel as any).handleApprovalPolicy(wsClient(rig.ws, P_ADMIN), {
        action: 'approval_policy', runId: 'run-pol-2', approvalPolicy: { autoApproveTools: false },
      });
      expect(rig.ws.sent.at(-1)?.data).toEqual({ type: 'approval_policy_ok', runId: 'run-pol-2', sessionId: 's-pol-2' });
      record = await runStore.get('run-pol-2');
      expect(record?.metadata?.approvalPolicy).toBeNull();
    });
  });

  describe('handleRunStatus', () => {
    it('缺 runId / run 不存在 / 非 admin 查他人 → 拒绝', async () => {
      const runStore = new MemoryRunStore();
      await runStore.upsertPending({ runId: 'run-st-0', sessionId: 's-st-0', userId: OTHER_USER.sub, model: 'm', channel: 'web' });
      const rig = makeRig({
        enqueueRuntime: { scheduler: {} as any, runStore, sessionCatalog: {} as any, enabled: true },
      });
      await (rig.channel as any).handleRunStatus(wsClient(rig.ws, USER), { action: 'run_status', runId: '' });
      expect(rig.ws.sent.at(-1)?.data).toEqual({ type: 'error', message: 'runId is required' });
      await (rig.channel as any).handleRunStatus(wsClient(rig.ws, USER), { action: 'run_status', runId: 'missing' });
      expect(rig.ws.sent.at(-1)?.data).toEqual({ type: 'error', message: 'Run not found' });
      await (rig.channel as any).handleRunStatus(wsClient(rig.ws, USER), { action: 'run_status', runId: 'run-st-0' });
      expect(rig.ws.sent.at(-1)?.data).toEqual({ type: 'error', message: 'Access denied' });
    });

    it('成功：回 session_status，携带 metadata.streamId 与 statusReason', async () => {
      const runStore = new MemoryRunStore();
      await runStore.upsertPending({
        runId: 'run-st-1', sessionId: 's-st-1', userId: USER.sub, model: 'm', channel: 'web',
        metadata: { streamId: 'st-77' },
      });
      await runStore.markStatus('run-st-1', 'waiting_approval', 'worker paused');
      const rig = makeRig({
        enqueueRuntime: { scheduler: {} as any, runStore, sessionCatalog: {} as any, enabled: true },
      });
      await (rig.channel as any).handleRunStatus(wsClient(rig.ws, USER), { action: 'run_status', runId: 'run-st-1' });
      expect(rig.ws.sent.at(-1)?.data).toEqual({
        type: 'session_status', sessionId: 's-st-1', status: 'waiting_approval',
        runId: 'run-st-1', streamId: 'st-77', reason: 'worker paused',
      });
    });
  });

  describe('handleSync / handleDetach', () => {
    it('sync：正常回放 lastSeq 之后事件；缓冲淘汰后回 sync_overflow；无用户静默', () => {
      const rig = makeRig();
      const log = new UserEventLog();
      // destroy 供 channel.stop() 调用（真 WsServer 的最小替身）
      (rig.channel as any).wsServer = {
        userEventLog: log,
        hasUserEventEpochMismatch: (_client: unknown, userId: string, epoch: string | undefined, lastSeq: number) => (
          log.hasEpochMismatch(userId, epoch, lastSeq)
        ),
        destroy: () => {},
      };
      try {
        log.push('sync-u1', { type: 'title_updated', sessionId: 'a' });
        log.push('sync-u1', { type: 'session_updated', sessionId: 'a' });
        log.push('sync-u1', { type: 'session_deleted', sessionId: 'a' });
        (rig.channel as any).handleSync(wsClient(rig.ws, { ...USER, sub: 'sync-u1' }), {
          action: 'sync', lastSeq: 1, epoch: log.getEpoch('sync-u1'),
        });
        expect(rig.ws.sent.at(-1)?.data).toMatchObject({ type: 'sync_ok', seq: 3, epoch: log.getEpoch('sync-u1') });
        expect(rig.ws.sent.at(-1)?.data.events.map((e: any) => e.seq)).toEqual([2, 3]);

        // 新实例可恰好追到相同 seq；正 seq 缺失/不匹配 epoch 仍必须强制全量恢复。
        (rig.channel as any).handleSync(wsClient(rig.ws, { ...USER, sub: 'sync-u1' }), {
          action: 'sync', lastSeq: 3, epoch: 'previous-instance',
        });
        expect(rig.ws.sent.at(-1)?.data).toEqual({ type: 'sync_overflow', seq: 3, epoch: log.getEpoch('sync-u1') });

        // 首次客户端 lastSeq=0 不要求 epoch，兼容滚动部署。
        (rig.channel as any).handleSync(wsClient(rig.ws, { ...USER, sub: 'sync-u1' }), {
          action: 'sync', lastSeq: 0,
        });
        expect(rig.ws.sent.at(-1)?.data).toMatchObject({ type: 'sync_ok', seq: 3, epoch: log.getEpoch('sync-u1') });

        for (let i = 0; i < 205; i += 1) log.push('sync-u2', { type: 'title_updated' });
        (rig.channel as any).handleSync(wsClient(rig.ws, { ...USER, sub: 'sync-u2' }), {
          action: 'sync', lastSeq: 1, epoch: log.getEpoch('sync-u2'),
        });
        expect(rig.ws.sent.at(-1)?.data).toEqual({ type: 'sync_overflow', seq: 205, epoch: log.getEpoch('sync-u2') });

        const before = rig.ws.sent.length;
        (rig.channel as any).handleSync(wsClient(rig.ws), { action: 'sync', lastSeq: 0 });
        expect(rig.ws.sent.length).toBe(before);
      } finally {
        log.stop();
      }
    });

    it('detach：清除 wsActiveStream 绑定并退订 EventBuffer', () => {
      const rig = makeRig();
      const unsub = vi.fn();
      (rig.channel as any).wsActiveStream.set(rig.ws, 'st-detach');
      (rig.channel as any).resumeSubscriptions.set(rig.ws, unsub);
      (rig.channel as any).handleDetach(wsClient(rig.ws, USER));
      expect(unsub).toHaveBeenCalledTimes(1);
      expect((rig.channel as any).wsActiveStream.get(rig.ws)).toBeUndefined();
      expect((rig.channel as any).resumeSubscriptions.get(rig.ws)).toBeUndefined();
    });
  });

  describe('handleRespond / resolveInteraction（内存交互）', () => {
    it('缺 interactionId → respond_error；禁用租户 → respond_error', async () => {
      const rig = makeRig();
      (rig.channel as any).handleRespond(wsClient(rig.ws, USER), { action: 'respond', interactionId: '', clientAttemptId: 'attempt-invalid' });
      expect(rig.ws.sent.at(-1)?.data).toEqual({ type: 'respond_error', interactionId: '', error: 'interactionId is required', clientAttemptId: 'attempt-invalid' });

      const disabledRig = makeRig({
        tenantStore: {
          findById: () => ({ id: TENANT, name: TENANT, disabled: true }),
          getSettings: () => ({}),
        } as unknown as TenantStore,
      });
      (disabledRig.channel as any).handleRespond(wsClient(disabledRig.ws, USER), { action: 'respond', interactionId: 'x-1' });
      expect(disabledRig.ws.sent.at(-1)?.data).toEqual({ type: 'respond_error', interactionId: 'x-1', error: '组织已被禁用' });
    });

    it('非 admin 回答他人创建的交互 → Access denied，pending 不被消费', async () => {
      const rig = makeRig();
      const id = `cov-own-${RUN_TAG}`;
      const pending = interactionStore.create(id, 'permission_request', { userId: OTHER_USER.sub, toolName: 'Shell' });
      (rig.channel as any).handleRespond(wsClient(rig.ws, USER), { action: 'respond', interactionId: id, allow: true });
      await flushMicrotasks();
      expect(rig.ws.sent.at(-1)?.data).toEqual({ type: 'respond_error', interactionId: id, error: 'Access denied' });
      expect(interactionStore.get(id)).toBeTruthy();
      interactionStore.resolve(id, { allow: false });
      await pending;
    });
    it('正常 resolve：dispatch 收到原始应答、respond_ok、同 session 其他连接收 interaction_resolved 广播', async () => {
      const tmp = await makeTmp('cov-respond-');
      const rig = makeRig({ agentCwd: tmp });
      const sessionId = randomUUID();
      const transcriptPath = getTranscriptPath(tmp, sessionId, { tenantId: TENANT, userId: USER.sub });
      await writeSessionMeta(transcriptPath, { userId: USER.sub, username: USER.username, tenantId: TENANT, channel: 'web', createdAt: new Date().toISOString() });
      const id = `cov-ok-${RUN_TAG}`;
      const pending = interactionStore.create(id, 'permission_request', {
        sessionId, userId: USER.sub, toolId: 'Shell', toolName: 'Shell',
      });
      (rig.channel as any).activeStreams.set('st-r', {
        controller: new AbortController(), userId: USER.sub, ws: rig.ws, sessionId,
      });
      (rig.channel as any).handleRespond(wsClient(rig.ws, USER), { action: 'respond', interactionId: id, clientAttemptId: 'attempt-success', allow: true, message: '同意执行' });
      await expect(pending).resolves.toEqual({ allow: true, message: '同意执行' });
      // respond_ok 在 appendDurableWebCommand（真实 fs 扫描）之后发出 → 等宏任务
      await vi.waitFor(() => { expect(rig.ws.sent.at(-1)?.data).toEqual({ type: 'respond_ok', interactionId: id, clientAttemptId: 'attempt-success', response: { allow: true, message: '同意执行' } }); }, { timeout: 5_000 });
      expect(rig.userEvents).toContainEqual({ type: 'interaction_resolved', sessionId, interactionId: id, response: { allow: true, message: '同意执行' } });
      expect(interactionStore.get(id)).toBeUndefined();
    });
    it('未知交互且无持久化兜底 → Interaction not found or expired', async () => {
      const tmp = await makeTmp('cov-respond-miss-');
      const rig = makeRig({ agentCwd: tmp });
      await (rig.channel as any).resolveInteraction(wsClient(rig.ws, USER), 'ghost-interaction', { allow: true }, undefined);
      expect(rig.ws.sent.at(-1)?.data).toEqual({
        type: 'respond_error', interactionId: 'ghost-interaction', error: 'Interaction not found or expired',
      });
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // 2. processChatMessage 前置校验与幂等
  // ════════════════════════════════════════════════════════════════════

  describe('processChatMessage 前置校验', () => {
    it('draining → server_draining；空消息 → empty_message；两者都不发 chat_ack', async () => {
      const draining = makeRig({ getIsDraining: () => true });
      await draining.send(USER, { client_msg_id: 'cm-drain', message: '你好' });
      expect(draining.ws.sent.map((m) => m.data.type)).toEqual(['chat_rejected']);
      expect(draining.ws.sent[0].data).toMatchObject({
        client_msg_id: 'cm-drain', reason_code: 'server_draining', reason: '服务即将关闭，请稍后重试',
      });

      const rig = makeRig();
      await rig.send(USER, { client_msg_id: 'cm-empty', message: '' });
      expect(rig.ws.sent.map((m) => m.data.type)).toEqual(['chat_rejected']);
      expect(rig.ws.sent[0].data).toMatchObject({ reason_code: 'empty_message', reason: '消息内容不能为空' });
    });

    it('已受理 durable 重放先于 draining 与空载荷校验，返回原 ACK', async () => {
      const runStore = new MemoryRunStore();
      await runStore.upsertPending({
        runId: 'run-durable-replay',
        sessionId: 'session-durable-replay',
        userId: USER.sub, tenantId: TENANT,
        idempotencyKey: 'cm-durable-replay',
        channel: 'web',
        metadata: { streamId: 'stream-durable-replay', deliveryMode: 'queue' },
      });
      const rig = makeRig({
        getIsDraining: () => true,
        enqueueRuntime: { scheduler: {} as any, runStore, sessionCatalog: {} as any, enabled: true },
      });

      await rig.send(USER, { client_msg_id: 'cm-durable-replay', message: '' });

      expect(rig.ws.sent.map((message) => message.data.type)).toEqual(['chat_ack', 'stream_id', 'session']);
      expect(rig.ws.sent[0].data).toMatchObject({
        runId: 'run-durable-replay', sessionId: 'session-durable-replay', status: 'accepted',
      });
    });

    it('跨租户 durable 记录不能命中当前租户幂等域', async () => {
      const runStore = new MemoryRunStore();
      await runStore.upsertPending({
        runId: 'run-cross-tenant-replay',
        sessionId: 'session-cross-tenant-replay',
        userId: USER.sub,
        tenantId: 'other-tenant',
        idempotencyKey: 'cm-cross-tenant-replay',
        channel: 'web',
      });
      const rig = makeRig({
        enqueueRuntime: { scheduler: {} as any, runStore, sessionCatalog: {} as any, enabled: true },
      });

      await rig.send(USER, { client_msg_id: 'cm-cross-tenant-replay', message: '' });

      expect(rig.ws.sent).toHaveLength(1);
      expect(rig.ws.sent[0].data).toMatchObject({
        type: 'chat_rejected', reason_code: 'empty_message', reason: '消息内容不能为空',
      });
    });

    it('平台 admin 可唯一回查自己代提交的跨租户消息，组织 admin 仍受租户域隔离', async () => {
      const runStore = new MemoryRunStore();
      await runStore.upsertPending({
        runId: 'run-platform-admin-replay',
        sessionId: 'session-platform-admin-replay',
        userId: USER.sub,
        submitterUserId: P_ADMIN.sub,
        tenantId: TENANT,
        idempotencyKey: 'cm-platform-admin-replay',
        channel: 'web',
      });
      await runStore.upsertPending({
        runId: 'run-org-admin-cross-tenant',
        sessionId: 'session-org-admin-cross-tenant',
        userId: USER.sub,
        submitterUserId: ORG_ADMIN.sub,
        tenantId: 'other-tenant',
        idempotencyKey: 'cm-org-admin-cross-tenant',
        channel: 'web',
      });
      const rig = makeRig({
        enqueueRuntime: { scheduler: {} as any, runStore, sessionCatalog: {} as any, enabled: true },
      });

      await rig.send(P_ADMIN, { client_msg_id: 'cm-platform-admin-replay', message: '' });
      expect(rig.ws.sent[0].data).toMatchObject({
        type: 'chat_ack', runId: 'run-platform-admin-replay', sessionId: 'session-platform-admin-replay',
      });
      rig.ws.sent.length = 0;

      await rig.send(ORG_ADMIN, { client_msg_id: 'cm-org-admin-cross-tenant', message: '' });
      expect(rig.ws.sent).toHaveLength(1);
      expect(rig.ws.sent[0].data).toMatchObject({ type: 'chat_rejected', reason_code: 'empty_message' });
    });

    it('禁用租户 → access_denied（组织已被禁用）', async () => {
      const rig = makeRig({
        tenantStore: {
          findById: () => ({ id: TENANT, name: TENANT, disabled: true }),
          getSettings: () => ({}),
        } as unknown as TenantStore,
      });
      await rig.send(USER, { client_msg_id: 'cm-tenant', message: '你好' });
      expect(rig.ws.sent[0].data).toMatchObject({
        type: 'chat_rejected', reason_code: 'access_denied', reason: '组织已被禁用',
      });
    });

    it('非 admin 续聊他人会话（meta.userId 不符）→ access_denied，且不 ack 不 dispatch', async () => {
      const tmp = await makeTmp('cov-owner-');
      const dispatchCalls: unknown[] = [];
      const dispatch: AgentRunDispatch = async function* (msg) {
        dispatchCalls.push(msg);
        yield { type: 'done' };
      };
      const rig = makeRig({ agentCwd: tmp }, dispatch);
      const sessionId = randomUUID();
      // meta 落在发起者自己的 transcript 路径上，但归属写的是他人 —— 必须拒绝
      const transcriptPath = getTranscriptPath('/unused', sessionId, { tenantId: USER.tenantId, userId: USER.sub });
      await writeSessionMeta(transcriptPath, {
        userId: OTHER_USER.sub, username: OTHER_USER.username, tenantId: TENANT,
        channel: 'web', createdAt: new Date().toISOString(),
      });
      await rig.send(USER, { client_msg_id: 'cm-owner', message: '继续', sessionId });
      expect(rig.ws.sent.map((m) => m.data.type)).toEqual(['chat_rejected']);
      expect(rig.ws.sent[0].data).toMatchObject({ reason_code: 'access_denied', reason: '无权访问该会话' });
      expect(dispatchCalls).toHaveLength(0);
    });

    it('同 client_msg_id 在途重发 → 只重发 ACK + stream_id，不二次 dispatch', async () => {
      const tmp = await makeTmp('cov-idem-');
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let dispatchCount = 0;
      const dispatch: AgentRunDispatch = async function* () {
        dispatchCount += 1;
        await gate;
        yield { type: 'done' };
      };
      const rig = makeRig({ agentCwd: tmp }, dispatch);
      const first = (rig.channel as any).processChatMessage(
        wsClient(rig.ws, USER), chatMessage({ client_msg_id: 'cm-dup-1', message: '第一条' }),
      );
      await vi.waitFor(() => {
        expect(rig.ws.sent.some((m) => m.data.type === 'chat_ack')).toBe(true);
      });

      await rig.send(USER, { client_msg_id: 'cm-dup-1', message: '第一条' });
      const acks = rig.ws.sent.filter((m) => m.data.type === 'chat_ack');
      expect(acks).toHaveLength(2);
      const streamIdMsg = rig.ws.sent.find((m) => m.data.type === 'stream_id');
      expect(streamIdMsg?.data).toMatchObject({ client_msg_id: 'cm-dup-1' });
      expect(streamIdMsg?.data.streamId).toBeTruthy();
      expect(dispatchCount).toBe(1);
      release();
      await first;
    });

    it('durable run 幂等：ACK 反映当前权威状态，且不伪造 streamId', async () => {
      const runStore = new MemoryRunStore();
      await runStore.upsertPending({
        runId: 'run-idem-a', sessionId: 's-idem-a', userId: USER.sub, tenantId: TENANT, model: 'm', channel: 'web',
        idempotencyKey: 'cm-durable-active', metadata: { streamId: 'st-9' },
      });
      await runStore.markStatus('run-idem-a', 'running');
      await runStore.upsertPending({
        runId: 'run-idem-b', sessionId: 's-idem-b', userId: USER.sub, tenantId: TENANT, model: 'm', channel: 'web',
        idempotencyKey: 'cm-durable-done',
      });
      await runStore.markStatus('run-idem-b', 'completed');
      const rig = makeRig({
        enqueueRuntime: { scheduler: {} as any, runStore, sessionCatalog: {} as any, enabled: true },
      });

      await rig.send(USER, { client_msg_id: 'cm-durable-active', message: '重试' });
      expect(rig.ws.sent.map((m) => m.data.type)).toEqual(['chat_ack', 'stream_id', 'session']);
      expect(rig.ws.sent[1].data).toEqual({
        type: 'stream_id', streamId: 'st-9', sessionId: 's-idem-a', runId: 'run-idem-a', client_msg_id: 'cm-durable-active',
      });
      expect(rig.ws.sent[2].data).toEqual({ type: 'session', sessionId: 's-idem-a', client_msg_id: 'cm-durable-active' });

      expect(rig.ws.sent[0].data).toMatchObject({
        type: 'chat_ack', client_msg_id: 'cm-durable-active', runId: 'run-idem-a', status: 'running',
      });

      rig.ws.sent.length = 0;
      await rig.send(USER, { client_msg_id: 'cm-durable-done', message: '重试' });
      expect(rig.ws.sent.map((m) => m.data.type)).toEqual(['chat_ack', 'session']);
      expect(rig.ws.sent[0].data).toMatchObject({
        type: 'chat_ack', client_msg_id: 'cm-durable-done', runId: 'run-idem-b', status: 'completed',
      });
      expect(rig.ws.sent.some((m) => m.data.type === 'stream_id')).toBe(false);
    });

    it('模型不在组织白名单（modelResolver 返回 null）→ model_not_allowed', async () => {
      const tmp = await makeTmp('cov-model-');
      const modelResolver = vi.fn(() => null);
      const rig = makeRig({ agentCwd: tmp, modelResolver });
      await rig.send(USER, { client_msg_id: 'cm-model', message: '你好', model: 'forbidden/model' });
      expect(rig.ws.sent.at(-1)?.data).toMatchObject({
        type: 'chat_rejected', reason_code: 'model_not_allowed', reason: '当前组织不可使用所选模型',
      });
      expect(modelResolver).toHaveBeenCalledWith('forbidden/model', TENANT);
    });
  });

  describe('语音消息 STT', () => {
    const voiceFile = { savedPath: '/tmp/cov-voice.wav', relativePath: 'voice/cov-voice.wav', duration: 1200 };

    it('未配置 STT → stt_not_configured + voice_transcribed(error)', async () => {
      const rig = makeRig();
      await rig.send(USER, { client_msg_id: 'cm-stt-0', message: '', voiceFile });
      const types = rig.ws.sent.map((m) => m.data.type);
      expect(types).toEqual(['voice_transcribed', 'chat_rejected']);
      expect(rig.ws.sent[0].data).toEqual({ type: 'voice_transcribed', text: '[语音识别未配置]', error: true });
      expect(rig.ws.sent[1].data).toMatchObject({ reason_code: 'stt_not_configured' });
      expect(rig.ws.sent.some((message) => message.data.type === 'chat_ack')).toBe(false);
    });

    it('识别成功：注入 VOICE_STT_TAG 前缀送 dispatch，先推 voice_transcribed', async () => {
      const tmp = await makeTmp('cov-stt-ok-');
      sttMock.mockResolvedValueOnce({ text: '今天天气不错', duration: 900 });
      const inbound: any[] = [];
      const dispatch: AgentRunDispatch = async function* (msg) {
        inbound.push(msg);
        yield { type: 'done' };
      };
      const rig = makeRig({ agentCwd: tmp, sttConfig: { apiKey: 'k' } as SttConfig }, dispatch);
      await rig.send(USER, { client_msg_id: 'cm-stt-1', message: '', voiceFile });
      expect(sttMock).toHaveBeenCalledWith('/tmp/cov-voice.wav', { apiKey: 'k' });
      expect(rig.ws.sent.find((m) => m.data.type === 'voice_transcribed')?.data).toEqual({
        type: 'voice_transcribed', text: '今天天气不错',
      });
      expect(inbound).toHaveLength(1);
      expect(inbound[0].content).toBe('[这是一条语音转文字的消息，可能存在识别准确度问题] 今天天气不错');
      expect(rig.ws.sent.find((m) => m.data.type === 'done')?.data).toMatchObject({ client_msg_id: 'cm-stt-1' });
    });

    it('识别为空（未检测到语音）与调用异常 → stt_failed，不进入 dispatch', async () => {
      const tmp = await makeTmp('cov-stt-fail-');
      const dispatchCalls: unknown[] = [];
      const dispatch: AgentRunDispatch = async function* (msg) {
        dispatchCalls.push(msg);
        yield { type: 'done' };
      };
      const rig = makeRig({ agentCwd: tmp, sttConfig: { apiKey: 'k' } as SttConfig }, dispatch);

      sttMock.mockResolvedValueOnce({ text: '', duration: 0 });
      await rig.send(USER, { client_msg_id: 'cm-stt-2', message: '', voiceFile });
      expect(rig.ws.sent.at(-1)?.data).toMatchObject({
        reason_code: 'stt_failed', reason: '语音无法识别：未检测到语音',
      });

      rig.ws.sent.length = 0;
      sttMock.mockRejectedValueOnce(new Error('asr down'));
      await rig.send(USER, { client_msg_id: 'cm-stt-3', message: '', voiceFile });
      expect(rig.ws.sent.find((m) => m.data.type === 'voice_transcribed')?.data).toEqual({
        type: 'voice_transcribed', text: '[语音识别失败]', error: true,
      });
      expect(rig.ws.sent.at(-1)?.data).toMatchObject({ reason_code: 'stt_failed', reason: '语音识别服务调用失败' });
      expect(dispatchCalls).toHaveLength(0);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // 3. handleEvents 流式管道（非 enqueue dispatch 路径）
  // ════════════════════════════════════════════════════════════════════

  describe('handleEvents 流式管道', () => {
    function scripted(events: OutboundEvent[]): AgentRunDispatch {
      return async function* () {
        for (const event of events) yield event;
      };
    }

    it('完整文本流：ack→stream_id→session→文本块→done，meta 落盘 + user_message 进 buffer + 终态广播 + 幂等 done', async () => {
      const tmp = await makeTmp('cov-flow-');
      const sessionId = randomUUID();
      const rig = makeRig({ agentCwd: tmp }, scripted([
        { type: 'session_init', sessionId },
        { type: 'text_start' },
        { type: 'text_delta', content: '你好，' },
        { type: 'text_delta', content: '世界' },
        { type: 'text_end' },
        { type: 'done' },
      ]));
      await rig.send(USER, { client_msg_id: 'cm-flow-1', message: '打个招呼', model: 'grp/std' });

      expect(rig.ws.sent.map((m) => m.data.type)).toEqual([
        'chat_ack', 'stream_id', 'session', 'block_start', 'text', 'text', 'block_end', 'done',
      ]);
      expect(rig.ws.sent[2].data).toEqual({ type: 'session', sessionId, client_msg_id: 'cm-flow-1' });
      expect(rig.ws.sent[4].data).toEqual({ type: 'text', content: '你好，' });
      expect(rig.ws.sent.at(-1)?.data).toEqual({
        type: 'done', client_msg_id: 'cm-flow-1', finalOutput: true,
      });

      // 用户消息注入 EventBuffer（其他设备 resume 用）
      const buffer = (rig.channel as any).eventBufferStore.get(sessionId);
      expect(JSON.parse(buffer.events[0].data)).toMatchObject({
        type: 'user_message', content: '打个招呼', client_msg_id: 'cm-flow-1',
      });

      // session meta 异步落盘（owner 归属 + modelRef）
      const transcriptPath = getTranscriptPath('/unused', sessionId, { tenantId: USER.tenantId, userId: USER.sub });
      await vi.waitFor(async () => {
        const meta = await readSessionMeta(transcriptPath);
        expect(meta).toMatchObject({
          userId: USER.sub, username: USER.username, userRole: 'user',
          tenantId: TENANT, channel: 'web', model: 'grp/std',
        });
      });

      // user scope 广播：新会话 → busy/isNew，done → preview，finally → idle
      expect(rig.userEvents).toContainEqual(expect.objectContaining({ type: 'session_status', sessionId, status: 'busy' }));
      expect(rig.userEvents).toContainEqual(expect.objectContaining({ type: 'session_updated', sessionId, isNew: true }));
      expect(rig.userEvents).toContainEqual(expect.objectContaining({ type: 'session_updated', sessionId, preview: '你好，世界' }));
      expect(rig.userEvents.at(-1)).toEqual({ type: 'session_status', sessionId, status: 'idle' });

      // 幂等：done 终态后同 id 重发只返回原终态 ACK，不二次 dispatch。
      rig.ws.sent.length = 0;
      await rig.send(USER, { client_msg_id: 'cm-flow-1', message: '打个招呼' });
      expect(rig.ws.sent.map((m) => m.data.type)).toEqual(['chat_ack']);
      expect(rig.ws.sent[0].data).toMatchObject({
        type: 'chat_ack', client_msg_id: 'cm-flow-1', status: 'completed',
      });
    });

    it('可撤销草稿：失败 attempt 被 reset 替换，预览只保留成功正文', async () => {
      const tmp = await makeTmp('cov-draft-recovery-');
      const sessionId = randomUUID();
      const rig = makeRig({ agentCwd: tmp }, scripted([
        { type: 'session_init', sessionId },
        { type: 'text_start', draftId: 'draft-1' },
        { type: 'text_delta', content: '失败轮正文' },
        { type: 'draft_reset', draftId: 'draft-1', attempt: 1 },
        { type: 'text_start', draftId: 'draft-1' },
        { type: 'text_delta', content: '最终答案' },
        { type: 'text_end' },
        { type: 'draft_commit', draftId: 'draft-1' },
        { type: 'done' },
      ]));

      await rig.send(USER, {
        client_msg_id: 'cm-draft-1',
        clientCapabilities: ['replaceable_drafts'],
        message: '恢复测试',
      });

      expect(rig.ws.sent.map((m) => m.data.type)).toEqual([
        'chat_ack',
        'stream_id',
        'session',
        'block_start',
        'text',
        'draft_reset',
        'block_start',
        'text',
        'block_end',
        'draft_commit',
        'done',
      ]);
      expect(rig.ws.sent[3].data).toEqual({
        type: 'block_start',
        blockType: 'text',
        draftId: 'draft-1',
      });
      expect(rig.ws.sent[5].data).toEqual({
        type: 'draft_reset',
        draftId: 'draft-1',
        attempt: 1,
      });
      expect(rig.userEvents).toContainEqual(expect.objectContaining({
        type: 'session_updated',
        sessionId,
        preview: '最终答案',
      }));
    });

    it('纯 VOICE 块：只发 standalone voice 事件，不发文本块', async () => {
      const tmp = await makeTmp('cov-voice-pure-');
      const rig = makeRig({ agentCwd: tmp }, scripted([
        { type: 'text_start' },
        { type: 'text_delta', content: '[VOICE voice=anna speed=1.2]你好[/VOICE]' },
        { type: 'text_end' },
        { type: 'done' },
      ]));
      await rig.send(USER, { client_msg_id: 'cm-vp', message: '语音回我' });
      expect(rig.ws.sent.map((m) => m.data.type)).toEqual(['chat_ack', 'stream_id', 'voice', 'done']);
      expect(rig.ws.sent[2].data).toEqual({
        type: 'voice', text: '你好', voice: 'anna', speed: 1.2, standalone: true,
      });
    });

    it('VOICE + 正文混合块：发清理后的文本块 + 非 standalone voice', async () => {
      const tmp = await makeTmp('cov-voice-mix-');
      const rig = makeRig({ agentCwd: tmp }, scripted([
        { type: 'text_start' },
        { type: 'text_delta', content: '[VOICE]提醒内容[/VOICE]这是正文' },
        { type: 'text_end' },
        { type: 'done' },
      ]));
      await rig.send(USER, { client_msg_id: 'cm-vm', message: 'hi' });
      expect(rig.ws.sent.map((m) => m.data.type)).toEqual([
        'chat_ack', 'stream_id', 'block_start', 'text', 'block_end', 'voice', 'done',
      ]);
      expect(rig.ws.sent[3].data).toEqual({ type: 'text', content: '这是正文' });
      expect(rig.ws.sent[5].data).toMatchObject({ type: 'voice', text: '提醒内容', standalone: false });
    });

    it('正常流式文本 + 尾部 VOICE：先流式推原文，block_end 后补 voice', async () => {
      const tmp = await makeTmp('cov-voice-tail-');
      const rig = makeRig({ agentCwd: tmp }, scripted([
        { type: 'text_start' },
        { type: 'text_delta', content: '正文先行 ' },
        { type: 'text_delta', content: '[VOICE]尾音[/VOICE]' },
        { type: 'text_end' },
        { type: 'done' },
      ]));
      await rig.send(USER, { client_msg_id: 'cm-vt', message: 'hi' });
      expect(rig.ws.sent.map((m) => m.data.type)).toEqual([
        'chat_ack', 'stream_id', 'block_start', 'text', 'text', 'block_end', 'voice', 'done',
      ]);
      // 非缓冲（首 delta 已判定非 VOICE 开头）→ 后续 delta 原样流式下发
      expect(rig.ws.sent[4].data).toEqual({ type: 'text', content: '[VOICE]尾音[/VOICE]' });
      expect(rig.ws.sent[6].data).toMatchObject({ type: 'voice', text: '尾音', standalone: false });
    });

    it('FILE 标记：workspace 内真实文件 → file_download（相对路径 + 实测大小 + owner）', async () => {
      const tmp = await makeTmp('cov-file-');
      const userCwd = resolveUserCwd(tmp, { id: USER.sub, username: USER.username, role: 'user', tenantId: TENANT });
      await mkdir(join(userCwd, 'assets'), { recursive: true });
      await writeFile(join(userCwd, 'assets', 'report.txt'), 'hello');
      const marker = '[FILE]{"filePath":"assets/report.txt","fileName":"report.txt","fileType":"text/plain"}[/FILE]';
      const rig = makeRig({ agentCwd: tmp }, scripted([
        { type: 'text_start' },
        { type: 'text_delta', content: `已生成 ${marker} 请下载` },
        { type: 'text_end' },
        { type: 'done' },
      ]));
      await rig.send(USER, { client_msg_id: 'cm-file', message: '导出' });
      expect(rig.ws.sent.find((m) => m.data.type === 'file_download')?.data).toEqual({
        type: 'file_download',
        fileName: 'report.txt',
        fileType: 'text/plain',
        filePath: 'assets/report.txt',
        fileSize: 5,
        owner: USER.username,
      });
    });

    it('displayFilter 接线：thinking:false 抑制思考块；专属工具（AskUserQuestion）不产生通用 tool 事件', async () => {
      const tmp = await makeTmp('cov-filter-');
      const rig = makeRig({ agentCwd: tmp, displayConfig: { thinking: false } }, scripted([
        { type: 'thinking_start' },
        { type: 'thinking_delta', content: '思考中' },
        { type: 'thinking_end' },
        { type: 'tool_start', toolId: 'r1', toolName: 'Read', runId: 'run-filter' },
        { type: 'tool_input_delta', toolId: 'r1', partialJson: '{"path":"a.txt"}' },
        { type: 'tool_end' },
        { type: 'tool_result', toolId: 'r1', toolResult: 'content-a' },
        { type: 'tool_start', toolId: 'q1', toolName: 'AskUserQuestion' },
        { type: 'tool_end' },
        { type: 'tool_result', toolId: 'q1', toolResult: 'answered' },
        { type: 'done' },
      ]));
      await rig.send(USER, { client_msg_id: 'cm-filter', message: 'hi' });
      expect(rig.ws.sent.map((m) => m.data.type)).toEqual([
        'chat_ack', 'stream_id', 'block_start', 'tool_input', 'block_end', 'tool_result', 'done',
      ]);
      expect(rig.ws.sent[2].data).toEqual({ type: 'block_start', blockType: 'tool_use', toolName: 'Read', toolId: 'r1', runId: 'run-filter' });
      expect(rig.ws.sent[3].data).toEqual({ type: 'tool_input', content: '{"path":"a.txt"}', toolName: 'Read', toolId: 'r1' });
      expect(rig.ws.sent[5].data).toEqual({ type: 'tool_result', toolId: 'r1', toolName: 'Read', result: 'content-a' });
    });

    it('SDK error：done 携带 error，幂等重发返回原 failed ACK', async () => {
      const tmp = await makeTmp('cov-err-');
      const rig = makeRig({ agentCwd: tmp }, scripted([
        { type: 'text_start' },
        { type: 'text_delta', content: '部分输出' },
        { type: 'text_end' },
        { type: 'error', error: 'model exploded' },
      ]));
      await rig.send(USER, { client_msg_id: 'cm-err', message: 'hi' });
      expect(rig.ws.sent.at(-1)?.data).toEqual({ type: 'done', client_msg_id: 'cm-err', error: 'model exploded' });
      rig.ws.sent.length = 0;
      await rig.send(USER, { client_msg_id: 'cm-err', message: 'hi' });
      expect(rig.ws.sent[0].data).toMatchObject({
        type: 'chat_ack', client_msg_id: 'cm-err', status: 'failed',
      });
    });

    it('用户主动停止后 SDK 返回 error：done 不携带 error', async () => {
      const tmp = await makeTmp('cov-user-abort-');
      const sessionId = randomUUID();
      const dispatch: AgentRunDispatch = async function* (_message, _context, options) {
        yield { type: 'session_init', sessionId };
        const signal = options?.abortController?.signal;
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        yield { type: 'error', error: 'The operation was aborted' };
      };
      const rig = makeRig({ agentCwd: tmp }, dispatch);

      const sendPromise = rig.send(USER, { client_msg_id: 'cm-user-abort', message: '停止我' });
      await flushMicrotasks();
      const streamId = rig.ws.sent.find((message) => message.data.type === 'stream_id')?.data.streamId;
      expect(streamId).toBeTypeOf('string');

      await (rig.channel as any).handleAbortAsync(
        wsClient(rig.ws, USER),
        { action: 'abort', streamId },
      );
      await sendPromise;

      expect(rig.ws.sent.filter((message) => message.data.type === 'done').at(-1)?.data).toEqual({
        type: 'done', client_msg_id: 'cm-user-abort',
      });
    });

    it('幽灵会话回滚：新会话无真实内容 → 删 transcript + session_deleted 广播 + buffer 清理', async () => {
      const tmp = await makeTmp('cov-phantom-');
      const rig = makeRig({ agentCwd: tmp });
      const sessionId = randomUUID();
      const transcriptPath = getTranscriptPath('/unused', sessionId, { tenantId: USER.tenantId, userId: USER.sub });
      await mkdir(dirname(transcriptPath), { recursive: true });
      await writeFile(transcriptPath, JSON.stringify({ type: 'system', sessionId }) + '\n');
      const events = (async function* (): AsyncGenerator<OutboundEvent> {
        yield { type: 'session_init', sessionId };
        yield { type: 'done' };
      })();
      const context: ChannelContext = {
        channel: 'web',
        user: { id: USER.sub, username: USER.username, role: 'user', tenantId: TENANT },
      };
      // 直接驱动 handleEvents 固化回滚分支：userDisplayContent 为空 → 不标记真实内容
      await (rig.channel as any).handleEvents(events, rig.ws, context, undefined, { streamId: 'ph-1' }, {
        userMessage: '', userDisplayContent: '', isNewSession: true, getSessionId: () => sessionId,
      });
      await expect(readFile(transcriptPath, 'utf-8')).rejects.toThrow();
      expect(rig.userEvents).toContainEqual({ type: 'session_deleted', sessionId });
      expect((rig.channel as any).eventBufferStore.get(sessionId)).toBeUndefined();
    });

    it('非 enqueue 路径透传 compaction 事件为 compaction_status（修复后与 enqueue 路径同口径）', async () => {
      // handleEvents 的 handler 已实现 onCompactionStart/onCompactionEnd：
      // dispatch 直连（非 enqueue）路径与 enqueue 路径（publishRuntimeOutboundEvent）
      // 同口径映射 started/completed 两条 compaction_status。
      const tmp = await makeTmp('cov-compact-');
      const rig = makeRig({ agentCwd: tmp }, scripted([
        { type: 'compaction_start' },
        { type: 'compaction_end', compaction: { summary: 's', coveredEventCount: 3 } } as unknown as OutboundEvent,
        { type: 'done' },
      ]));
      await rig.send(USER, { client_msg_id: 'cm-compact', message: '/compact', deliveryMode: 'steer' });
      expect(rig.ws.sent[0]?.data).toMatchObject({ type: 'chat_ack', deliveryMode: 'queue' });
      expect(rig.ws.sent.map((m) => m.data.type)).toEqual([
        'chat_ack', 'stream_id', 'compaction_status', 'compaction_status', 'done',
      ]);
      expect(rig.ws.sent[2].data).toEqual({ type: 'compaction_status', phase: 'started' });
      expect(rig.ws.sent[3].data).toEqual({
        type: 'compaction_status',
        phase: 'completed',
        compaction: { summary: 's', coveredEventCount: 3 },
      });
      expect(rig.ws.sent.at(-1)?.data).toMatchObject({ type: 'done' });
    });

    it('context_usage：租户不允许明细 → categories/memoryFiles/mcpTools 置空', async () => {
      const tmp = await makeTmp('cov-ctx-');
      const rig = makeRig({
        agentCwd: tmp,
        tenantStore: {
          findById: (id: string) => ({ id, name: id, disabled: false }),
          getSettings: () => ({ models: { showContextTokens: true, allowContextTokenDetails: false } }),
        } as unknown as TenantStore,
      }, scripted([
        {
          type: 'context_usage',
          contextUsage: {
            totalTokens: 100,
            categories: [{ name: 'system', tokens: 10, color: '#000' }],
            memoryFiles: [{ path: 'MEMORY.md', type: 'long-term', tokens: 5 }],
            mcpTools: [{ name: 'Search', serverName: 'memory', tokens: 3 }],
          },
        },
        { type: 'done' },
      ]));
      await rig.send(USER, { client_msg_id: 'cm-ctx', message: 'hi' });
      expect(rig.ws.sent.find((m) => m.data.type === 'context_usage')?.data).toEqual({
        type: 'context_usage',
        contextUsage: { totalTokens: 100, categories: [], memoryFiles: [], mcpTools: [] },
      });
    });

    it('notification 走 user scope，memory_recall / plugin_install 走会话流', async () => {
      const tmp = await makeTmp('cov-notify-');
      const rig = makeRig({ agentCwd: tmp }, scripted([
        { type: 'notification', notification: { text: '记忆已更新' } as any },
        { type: 'memory_recall', memoryRecall: { snippets: ['s1'] } as any },
        { type: 'plugin_install', pluginInstall: { name: 'p1', status: 'installing' } as any },
        { type: 'done' },
      ]));
      await rig.send(USER, { client_msg_id: 'cm-notify', message: 'hi' });
      expect(rig.userEvents).toContainEqual({ type: 'notification', notification: { text: '记忆已更新' } });
      expect(rig.ws.sent.map((m) => m.data.type)).toEqual([
        'chat_ack', 'stream_id', 'memory_recall', 'plugin_install', 'done',
      ]);
      expect(rig.ws.sent[2].data).toEqual({ type: 'memory_recall', memoryRecall: { snippets: ['s1'] } });
    });

    it('onResult：token 用量按操作者记账（channel=web），session cost 原子累加进 meta', async () => {
      const tmp = await makeTmp('cov-result-');
      const { sessionId, transcriptPath } = await seedRuntimeSession(USER);
      const recordResult = vi.fn();
      const dispatch: AgentRunDispatch = async function* (_msg, _ctx, _opts, hooks) {
        await hooks?.onSessionStart?.(sessionId, transcriptPath);
        await hooks?.onResult?.({
          totalCostUsd: 0.42,
          modelUsage: { 'gpt-x': { inputTokens: 100, outputTokens: 20 } },
        });
        yield { type: 'done' };
      };
      const rig = makeRig({
        agentCwd: tmp,
        tokenUsageStore: { recordResult } as unknown as TokenUsageStore,
      }, dispatch);
      await rig.send(USER, { client_msg_id: 'cm-result', message: 'hi' });
      expect(recordResult).toHaveBeenCalledTimes(1);
      expect(recordResult.mock.calls[0][0]).toMatchObject({
        username: USER.username, tenantId: TENANT, channel: 'web',
        modelUsage: { 'gpt-x': { inputTokens: 100, outputTokens: 20 } },
      });
      await vi.waitFor(async () => {
        const meta = await readSessionMeta(transcriptPath);
        expect(meta?.totalCostUsd).toBeCloseTo(0.42);
      });
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // 4. onInteraction 授权模式安全审计
  // ════════════════════════════════════════════════════════════════════

  describe('onInteraction 授权模式安全审计', () => {
    /** 跑一轮 chat，dispatch 内依次探测 onInteraction 决策并收集结果 */
    async function probe(
      user: { sub: string; username: string; role: 'user' | 'admin'; tenantId: string },
      events: Array<Record<string, unknown>>,
      extra: Partial<WebChannelConfig> = {},
      msgOverrides: Record<string, unknown> = {},
    ): Promise<{ responses: InteractionResponse[]; rig: Rig; tmp: string }> {
      const tmp = await makeTmp('cov-audit-');
      const responses: InteractionResponse[] = [];
      const dispatch: AgentRunDispatch = async function* (_msg, _ctx, _opts, hooks) {
        for (const event of events) {
          responses.push(await hooks!.onInteraction!(event as any));
        }
        yield { type: 'done' };
      };
      const rig = makeRig({ agentCwd: tmp, ...extra }, dispatch);
      await rig.send(user, { approvalPolicy: { autoApproveTools: true }, ...msgOverrides });
      return { responses, rig, tmp };
    }

    const perm = (toolName: string, toolInput?: Record<string, unknown>, toolId?: string) => ({
      type: 'permission_request', interactionId: `pi-${randomUUID().slice(0, 8)}`,
      toolName, toolId: toolId ?? toolName, toolInput,
    });

    it('安全工具与 mcp__ 前缀直接放行', async () => {
      const { responses } = await probe(USER, [
        perm('WebSearch', { query: 'x' }),
        perm('TodoWrite', {}),
        perm('mcp__dingtalk__send', { to: 'a' }),
      ]);
      expect(responses).toEqual([{ allow: true }, { allow: true }, { allow: true }]);
    });

    it('Shell 审计：env 探测/越界 cat/越界重定向/相对与 ~ 穿越被拒；域内命令与 /dev/null 放行', async () => {
      const tmp = await makeTmp('cov-audit-shell-');
      const userCwd = resolveUserCwd(tmp, { id: USER.sub, username: USER.username, role: 'user', tenantId: TENANT });
      const responses: InteractionResponse[] = [];
      const commands = [
        'env',                                    // env 探测
        `cat /etc/passwd`,                        // 越界绝对路径文件操作
        `cat ${userCwd}/notes.txt`,               // 域内 → 放行
        'echo hi > /etc/evil.txt',                // 越界重定向
        'echo hi > /dev/null',                    // /dev/null 豁免
        'cat ../../../../etc/passwd',             // 相对路径穿越
        'ls ~/secrets',                           // ~ 展开穿越
      ];
      const dispatch: AgentRunDispatch = async function* (_msg, _ctx, _opts, hooks) {
        for (const command of commands) {
          responses.push(await hooks!.onInteraction!(perm('Shell', { command }) as any));
        }
        yield { type: 'done' };
      };
      const rig = makeRig({ agentCwd: tmp }, dispatch);
      await rig.send(USER, { approvalPolicy: { autoApproveTools: true } });

      expect(responses[0]).toEqual({ allow: false, message: '安全限制：不允许执行环境变量探测命令' });
      expect(responses[1].allow).toBe(false);
      expect(responses[1].message).toContain('/etc/passwd');
      expect(responses[1].message).toContain(userCwd);
      expect(responses[2]).toEqual({ allow: true });
      expect(responses[3].allow).toBe(false);
      expect(responses[3].message).toContain('不允许将输出重定向到工作目录外');
      expect(responses[4]).toEqual({ allow: true });
      expect(responses[5].allow).toBe(false);
      expect(responses[5].message).toContain('../../../../etc/passwd');
      expect(responses[6].allow).toBe(false);
      expect(responses[6].message).toContain('~/secrets');
    });

    it('文件工具路径审计：域内读写放行、settings 文件写保护、越界与缺路径拒绝', async () => {
      const tmp = await makeTmp('cov-audit-file-');
      const userCwd = resolveUserCwd(tmp, { id: USER.sub, username: USER.username, role: 'user', tenantId: TENANT });
      const { responses } = await probe(USER, [
        perm('Read', { path: join(userCwd, 'doc.md') }),
        perm('Write', { path: join(userCwd, 'out.md') }),
        perm('Write', { path: join(userCwd, '.ky-agent/settings.json') }),
        perm('Edit', { file_path: join(userCwd, '.claude/settings.local.json') }),
        perm('Read', { path: '/etc/hosts' }),
        perm('Edit', {}),                       // 必填路径缺失
      ], { agentCwd: tmp });
      expect(responses[0]).toEqual({ allow: true });
      expect(responses[1]).toEqual({ allow: true });
      expect(responses[2]).toEqual({ allow: false, message: 'Access denied: cannot modify agent settings files' });
      expect(responses[3]).toEqual({ allow: false, message: 'Access denied: cannot modify agent settings files' });
      expect(responses[4]).toEqual({ allow: false, message: 'Access denied: path outside your workspace' });
      expect(responses[5]).toEqual({ allow: false, message: 'Access denied: missing file path' });
    });

    it('extraDirs 与共享 skills 目录放行；未知工具一律拒绝', async () => {
      const tmp = await makeTmp('cov-audit-extra-');
      const extraDir = join(tmp, 'extra-data');
      const sharedDir = join(tmp, 'shared');
      const { responses } = await probe(USER, [
        perm('Read', { path: join(extraDir, 'ref.csv') }),
        perm('Read', { path: join(sharedDir, '.ky-agent', 'skills', 'guide.md') }),
        perm('Read', { path: join(sharedDir, '.ky-agent', 'secrets', 'k.txt') }),
        perm('SomeUnknownTool', { anything: 1 }),
      ], {
        agentCwd: tmp,
        sharedDir,
        userOverrides: { [USER.username]: { extraDirs: [extraDir] } },
      });
      expect(responses[0]).toEqual({ allow: true });
      expect(responses[1]).toEqual({ allow: true });
      expect(responses[2]).toEqual({ allow: false, message: 'Access denied: path outside your workspace' });
      expect(responses[3]).toEqual({ allow: false, message: 'Operation not permitted' });
    });

    it('平台 admin 授权模式：非交互工具直批 auto-approved by policy', async () => {
      const { responses } = await probe(P_ADMIN, [
        perm('Bash', { command: 'rm -rf /anything' }, 'toolu_1'),
      ]);
      expect(responses).toEqual([{ allow: true, message: 'auto-approved by policy' }]);
    });

    it('用户已点停止 → 所有交互立即拒绝', async () => {
      const tmp = await makeTmp('cov-audit-stop-');
      const responses: InteractionResponse[] = [];
      const dispatch: AgentRunDispatch = async function* (_msg, _ctx, opts, hooks) {
        opts?.abortController?.abort();
        responses.push(await hooks!.onInteraction!(perm('WebSearch', {}) as any));
        yield { type: 'done' };
      };
      const rig = makeRig({ agentCwd: tmp }, dispatch);
      await rig.send(USER, { approvalPolicy: { autoApproveTools: true } });
      expect(responses).toEqual([{ allow: false, message: 'User stopped generation' }]);
    });
    it('人工审批 round-trip：permission_request 推 WS（含 ExitPlanMode planContent），respond 后 dispatch 拿到应答', async () => {
      const tmp = await makeTmp('cov-audit-rt-');
      const userCwd = resolveUserCwd(tmp, { id: USER.sub, username: USER.username, role: 'user', tenantId: TENANT });
      const plansDir = join(userCwd, '.ky-agent', 'plans');
      await mkdir(plansDir, { recursive: true });
      await writeFile(join(plansDir, 'latest.md'), '# PLAN BODY');
      const sessionId = randomUUID();
      const transcriptPath = getTranscriptPath(tmp, sessionId, { tenantId: TENANT, userId: USER.sub });
      await writeSessionMeta(transcriptPath, { userId: USER.sub, username: USER.username, tenantId: TENANT, channel: 'web', createdAt: new Date().toISOString() });
      const interactionId = `rt-${RUN_TAG}`;
      let resolved: InteractionResponse | undefined;
      const dispatch: AgentRunDispatch = async function* (_msg, _ctx, _opts, hooks) {
        await hooks?.onSessionStart?.(sessionId, transcriptPath);
        resolved = await hooks!.onInteraction!({
          type: 'permission_request', interactionId,
          toolId: 'ExitPlanMode', toolName: 'ExitPlanMode', toolInput: {},
        });
        yield { type: 'done' };
      };
      const rig = makeRig({ agentCwd: tmp }, dispatch);
      // 不开授权模式 → 走人工审批
      const chatPromise = (rig.channel as any).processChatMessage(
        wsClient(rig.ws, USER), chatMessage({ client_msg_id: 'cm-rt', message: '按计划执行' }),
      );
      await vi.waitFor(() => {
        expect(rig.ws.sent.some((m) => m.data.type === 'permission_request')).toBe(true);
      }, { timeout: 5_000 });
      const request = rig.ws.sent.find((m) => m.data.type === 'permission_request')!.data;
      expect(request).toMatchObject({
        interactionId, toolName: 'ExitPlanMode', planContent: '# PLAN BODY',
      });
      expect(interactionStore.get(interactionId)?.planContent).toBe('# PLAN BODY');

      (rig.channel as any).handleRespond(wsClient(rig.ws, USER), {
        action: 'respond', interactionId, allow: true,
      });
      await chatPromise;
      expect(resolved).toEqual({ allow: true });
      await vi.waitFor(() => {
        expect(rig.ws.sent.some((m) => m.data.type === 'respond_ok')).toBe(true);
      }, { timeout: 5_000 });
      // 注：respond 的 interaction_resolved 跨连接广播依赖 activeStreams 中仍存在同
      // sessionId 的活跃流；本用例 run 在 respond 后立即结束（finally 已清流），
      // 广播分支由上方「正常 resolve」用例（手工挂 activeStreams）单独覆盖。
    });
  });
  // ════════════════════════════════════════════════════════════════════
  // 5. publishRuntimeOutboundEvent
  // ════════════════════════════════════════════════════════════════════

  describe('持久化交互恢复', () => {
    function resumeRig(runStore: MemoryRunStore, tmp: string, enqueued: UpsertRunInput[]): Rig {
      return makeRig({
        agentCwd: tmp,
        runtimeEventStoreFor: (tp) => new FileEventStore(getRuntimeEventLogPath(tp), TENANT),
        enqueueRuntime: {
          scheduler: {
            enqueue: async (input: UpsertRunInput) => runStore.upsertPending(input),
            activateCreatedRun: async (runId: string, claim: Record<string, unknown>, metadataPatch: Record<string, unknown>) => {
              const activated = await runStore.activatePersistedInteractionResume(runId, claim, metadataPatch);
              if (activated) enqueued.push(await runStore.get(runId) as UpsertRunInput);
              return activated;
            },
          } as any,
          runStore,
          sessionCatalog: new FileSessionCatalog({ agentCwd: tmp }),
          enabled: true,
        },
      });
    }

    it('ask_user 恢复：落 interaction_resolved + run 置 pending 携带 resumeInteraction + 重新入队 + respond_ok/queued 广播', async () => {
      const tmp = await makeTmp('cov-askresume-');
      const { sessionId, eventStore } = await seedRuntimeSession(USER, {
        model: 'm-ask', executionTarget: 'server-local', workspaceId: 'ws-ask',
      });
      await eventStore.append({
        type: 'interaction_requested', sessionId, runId: 'run-ask-1', toolCallId: 'call-ask-1',
        interactionId: 'ask-int-1', interactionType: 'ask_user', userId: USER.sub,
        questions: [{ question: '选哪个颜色?', header: '颜色', options: [{ label: '红', description: '' }], multiSelect: false }],
      }, { tenantId: TENANT });
      const runStore = new MemoryRunStore();
      await runStore.upsertPending({ runId: 'run-ask-1', sessionId, userId: USER.sub, model: 'm-ask', channel: 'web' });
      await runStore.markStatus('run-ask-1', 'waiting_user');
      const enqueued: UpsertRunInput[] = [];
      const rig = resumeRig(runStore, tmp, enqueued);
      (rig.channel as any).handleRespond(wsClient(rig.ws, USER), {
        action: 'respond', interactionId: 'ask-int-1', sessionId, answers: { q1: '红色' },
      });
      await vi.waitFor(() => expect(rig.ws.sent.at(-1)?.data)
        .toEqual({ type: 'respond_ok', interactionId: 'ask-int-1', response: { answers: { q1: '红色' } } }), { timeout: 5_000 });
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]).toMatchObject({
        runId: 'run-ask-1', sessionId, userId: USER.sub, model: 'm-ask', channel: 'web',
        metadata: { resumeInteraction: { interactionId: 'ask-int-1', response: { answers: { q1: '红色' } } } },
      });
      // durable 日志追加 interaction_resolved（归一化应答）
      const events = await eventStore.list(TENANT, sessionId);
      expect(events.at(-1)).toMatchObject({
        type: 'interaction_resolved', interactionId: 'ask-int-1', interactionType: 'ask_user',
        runId: 'run-ask-1', toolCallId: 'call-ask-1', userId: USER.sub,
        response: { answers: { q1: '红色' } },
      });
      expect((await runStore.get('run-ask-1'))?.metadata?.resumeInteraction).toEqual({
        interactionId: 'ask-int-1', response: { answers: { q1: '红色' } },
      });
      expect(rig.userEvents).toContainEqual({ type: 'interaction_resolved', sessionId, interactionId: 'ask-int-1', response: { answers: { q1: '红色' } } });
      expect(rig.userEvents).toContainEqual({ type: 'session_status', sessionId, status: 'queued', runId: 'run-ask-1' });
    });

    it('approval 恢复：resumeApproval 入队；重复 respond 命中 already-accepted 幂等（不二次入队）', async () => {
      const tmp = await makeTmp('cov-apprresume-');
      const { sessionId, eventStore } = await seedRuntimeSession(USER, {
        model: 'm-appr', executionTarget: 'server-local', workspaceId: 'ws-appr',
      });
      await eventStore.append({
        type: 'assistant_tool_calls', sessionId, runId: 'run-appr-1', content: '',
        toolCalls: [{ id: 'call-appr-1', name: 'Shell', arguments: '{"command":"ls"}' }],
      } as any, { tenantId: TENANT });
      await eventStore.append({
        type: 'approval_requested', sessionId, runId: 'run-appr-1', approvalId: 'appr-1',
        toolCallId: 'call-appr-1', toolId: 'Shell', toolName: 'Shell',
        executionTarget: 'server-local', input: { command: 'ls' },
      } as any, { tenantId: TENANT });
      const runStore = new MemoryRunStore();
      await runStore.upsertPending({ runId: 'run-appr-1', sessionId, userId: USER.sub, model: 'm-appr', channel: 'web' });
      await runStore.markStatus('run-appr-1', 'waiting_approval');
      const enqueued: UpsertRunInput[] = [];
      const rig = resumeRig(runStore, tmp, enqueued);
      await (rig.channel as any).resolveInteraction(wsClient(rig.ws, USER), 'appr-1', { allow: true, message: '可以执行' }, sessionId, 'attempt-first');
      expect(rig.ws.sent.at(-1)?.data).toEqual({ type: 'respond_ok', interactionId: 'appr-1', clientAttemptId: 'attempt-first', response: { allow: true, message: '可以执行' } });
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]).toMatchObject({
        runId: 'run-appr-1', sessionId,
        metadata: { resumeApproval: { approvalId: 'appr-1', response: { allow: true, message: '可以执行' } } },
      });
      const events = await eventStore.list(TENANT, sessionId);
      expect(events.at(-1)).toMatchObject({
        type: 'interaction_resolved', interactionId: 'appr-1', interactionType: 'approval',
        response: { allow: true, message: '可以执行' },
      });

      // 首次 ACK 丢失后用户改答重试：ACK fence 回显本次 attempt，但 response 必须仍是首答 canonical。
      rig.ws.sent.length = 0;
      await (rig.channel as any).resolveInteraction(wsClient(rig.ws, USER), 'appr-1', { allow: false, message: '改为拒绝' }, sessionId, 'attempt-retry');
      expect(rig.ws.sent).toHaveLength(1);
      expect(rig.ws.sent[0].data).toEqual({ type: 'respond_ok', interactionId: 'appr-1', clientAttemptId: 'attempt-retry', response: { allow: true, message: '可以执行' } });
      expect(enqueued).toHaveLength(1);
      const durableResolved = (await eventStore.list(TENANT, sessionId)).find((event) => event.type === 'interaction_resolved');
      expect(durableResolved).toMatchObject({ response: { allow: true, message: '可以执行' } });
      expect(JSON.stringify(durableResolved)).not.toContain('attempt-first');
      expect(JSON.stringify(durableResolved)).not.toContain('attempt-retry');
    });

    it('approval 指向终态 run → 拒绝遗留审批并 respond_ok，不恢复旧 run', async () => {
      const tmp = await makeTmp('cov-apprterm-');
      const { sessionId, eventStore } = await seedRuntimeSession(USER, { executionTarget: 'server-local' });
      await eventStore.append({
        type: 'assistant_tool_calls', sessionId, runId: 'run-appr-t', content: '',
        toolCalls: [{ id: 'call-t-1', name: 'Shell', arguments: '{}' }],
      } as any, { tenantId: TENANT });
      await eventStore.append({
        type: 'approval_requested', sessionId, runId: 'run-appr-t', approvalId: 'appr-t-1',
        toolCallId: 'call-t-1', toolId: 'Shell', toolName: 'Shell', input: {},
      } as any, { tenantId: TENANT });
      const runStore = new MemoryRunStore();
      await runStore.upsertPending({ runId: 'run-appr-t', sessionId, userId: USER.sub, model: 'm', channel: 'web' });
      await runStore.markStatus('run-appr-t', 'completed');
      const enqueued: UpsertRunInput[] = [];
      const rig = resumeRig(runStore, tmp, enqueued);
      await (rig.channel as any).resolveInteraction(wsClient(rig.ws, USER), 'appr-t-1', { allow: true }, sessionId);
      expect(rig.ws.sent.at(-1)?.data).toEqual({ type: 'respond_ok', interactionId: 'appr-t-1', response: { allow: false, message: '源 run 不可恢复（completed），拒绝遗留审批' } });
      expect(enqueued).toHaveLength(0);
      const events = await eventStore.list(TENANT, sessionId);
      expect(events.at(-1)).toMatchObject({
        type: 'approval_resolved',
        approvalId: 'appr-t-1',
        decision: 'rejected',
        message: expect.stringContaining('源 run 不可恢复（completed）'),
      });
    });

    it('无 enqueueRuntime 时 fail-closed 拒绝持久审批，不调用 legacy resumeApprovalDispatch', async () => {
      const tmp = await makeTmp('cov-apprlegacy-');
      const { sessionId, eventStore } = await seedRuntimeSession(USER, { model: 'm-legacy' });
      await eventStore.append({
        type: 'assistant_tool_calls', sessionId, runId: 'run-appr-l', content: '',
        toolCalls: [{ id: 'call-l-1', name: 'Shell', arguments: '{}' }],
      } as any, { tenantId: TENANT });
      await eventStore.append({
        type: 'approval_requested', sessionId, runId: 'run-appr-l', approvalId: 'appr-l-1',
        toolCallId: 'call-l-1', toolId: 'Shell', toolName: 'Shell', input: {},
      } as any, { tenantId: TENANT });
      const resumeCalls: any[] = [];
      const rig = makeRig({
        agentCwd: tmp,
        runtimeEventStoreFor: (tp) => new FileEventStore(getRuntimeEventLogPath(tp), TENANT),
        resumeApprovalDispatch: ((request: any) => {
          resumeCalls.push(request);
          return (async function* (): AsyncGenerator<OutboundEvent> { yield { type: 'done' }; })();
        }) as any,
      });

      await (rig.channel as any).resolveInteraction(
        wsClient(rig.ws, USER), 'appr-l-1', { allow: false, message: '不允许' }, sessionId,
      );
      expect(rig.ws.sent.some((m) => m.data.type === 'respond_ok')).toBe(true);
      expect(resumeCalls).toHaveLength(0);
      const events = await eventStore.list(TENANT, sessionId);
      expect(events.at(-1)).toMatchObject({
        type: 'approval_resolved', approvalId: 'appr-l-1',
        decision: 'rejected',
        message: expect.stringContaining('未恢复旧 Run'),
      });
      expect(rig.userEvents).toContainEqual({ type: 'interaction_resolved', sessionId, interactionId: 'appr-l-1', response: { allow: false, message: '持久审批恢复需要 Runtime Scheduler；已安全拒绝，未恢复旧 Run' } });
      expect(rig.userEvents).not.toContainEqual(expect.objectContaining({ type: 'session_status', status: 'busy' }));
      expect((rig.channel as any).findActiveStreamIdBySession(sessionId)).toBeUndefined();
    });
  });
});

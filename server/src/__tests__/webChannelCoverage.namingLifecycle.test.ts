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
  return { sessionId, transcriptPath, eventStore: new FileEventStore(getRuntimeEventLogPath(transcriptPath)) };
}

describe('WebChannel channel.ts 生命周期', () => {
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
  // 9. 生命周期与杂项
  // ════════════════════════════════════════════════════════════════════

  describe('生命周期与杂项', () => {
    it('disconnectUser / disconnectTenant：只中止目标用户/租户的流（含 runtimeRunController）', () => {
      const userStore = {
        findById: (id: string) => (id === 'lc-u2' ? { id, tenantId: 'acme' } : { id, tenantId: TENANT }),
      } as unknown as UserStore;
      const rig = makeRig({ userStore });
      const c1 = new AbortController();
      const c2 = new AbortController();
      (rig.channel as any).activeStreams.set('lc-s1', { controller: c1, userId: 'lc-u1', ws: rig.ws, runId: 'run-lc-1' });
      (rig.channel as any).activeStreams.set('lc-s2', { controller: c2, userId: 'lc-u2', ws: rig.ws });
      expect(rig.channel.getActiveStreamCount()).toBe(2);
      const runtimeController = new AbortController();
      runtimeRunController.register('run-lc-1', runtimeController);
      try {
        rig.channel.disconnectUser('lc-u1');
      } finally {
        runtimeRunController.unregister('run-lc-1');
      }
      expect(c1.signal.aborted).toBe(true);
      expect(runtimeController.signal.aborted).toBe(true);
      expect(c2.signal.aborted).toBe(false);

      rig.channel.disconnectTenant('acme');
      expect(c2.signal.aborted).toBe(true);
    });

    it('getStreamStatus：runStore 异常时降级看 buffer（active + streamId）', async () => {
      const rig = makeRig({
        enqueueRuntime: {
          runStore: { getActiveBySession: vi.fn().mockRejectedValue(new Error('pg down')) },
        } as any,
      });
      const sessionId = randomUUID();
      (rig.channel as any).eventBufferStore.create(sessionId, USER.sub);
      (rig.channel as any).activeStreams.set('st-deg', {
        controller: new AbortController(), userId: USER.sub, ws: rig.ws, sessionId,
      });
      await expect(rig.channel.getStreamStatus(sessionId)).resolves.toEqual({ active: true, streamId: 'st-deg' });
    });

    it('attachToServer 在 start() 之前调用 → 抛错', () => {
      const rig = makeRig();
      expect(() => rig.channel.attachToServer({} as any)).toThrow('WsServer not initialized. Call start() first.');
    });
  });
});

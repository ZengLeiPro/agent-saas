/**
 * WebChannel 专职 Agent 门禁接线测试（2026-07 唯恩批次）
 *
 * 覆盖（计划测试 8-12）：
 *   - off_topic → 不 enqueue、WS 完整合成气泡序列、transcript 两行、
 *     guardrail_events 收 off_topic、幂等 done
 *   - uncertain → 正常 enqueue 且 metadata.guardrail='pass_flagged'、落库
 *   - /compact 与纯附件消息跳过门禁模型调用
 *   - config.guardrail 缺省（getter 缺省/空链）→ 门禁旁路，行为与改造前一致
 *   - personalAgentEnabled=false 普通用户被拒；admin 与 org agent 会话不受影响
 *   - orgAgentId 无效 → org_agent_unavailable
 */

import { EventEmitter } from 'node:events';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WebChannel, type WebChannelConfig } from '../channels/web/channel.js';
import { interactionStore } from '../channels/web/interactionStore.js';
import { findTranscriptOrMetaPathBySessionId } from '../data/transcripts/index.js';
import { readSessionMeta } from '../data/transcripts/meta.js';
import { OrgAgentStore } from '../data/orgAgents/store.js';
import type { GuardrailEventInsert, GuardrailEventStore } from '../data/guardrail/pgGuardrailEventStore.js';
import type { TenantStore } from '../data/tenants/store.js';
import type { TenantSettings } from '../data/tenants/types.js';
import { createExecutionConfig } from '../runtime/executionConfig.js';
import { FileSessionCatalog } from '../runtime/sessionCatalog.js';
import { FileEventStore, getRuntimeEventLogPath } from '../runtime/fileEventStore.js';
import type { RunRecord, RunStatus, RunStore, UpsertRunInput } from '../runtime/runStore.js';

// ── openai mock：门禁 service 真实跑，只拦上游 HTTP ─────────────────────
type QueueEntry = { content: string | null } | Error;
vi.mock('openai', () => {
  const responseQueue: Map<string, QueueEntry[]> = (globalThis as any).__webGuardrailQueue ??= new Map();
  const createCalls: string[] = (globalThis as any).__webGuardrailCalls ??= [];
  class MockOpenAI {
    constructor(_opts: { apiKey: string }) {}
    chat = {
      completions: {
        create: async (req: { model: string }) => {
          createCalls.push(req.model);
          const queue = responseQueue.get(req.model) ?? [];
          const next = queue.shift();
          if (next instanceof Error) throw next;
          return {
            id: 'mock-' + req.model,
            choices: [{ message: { content: next?.content ?? '' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          };
        },
      },
    };
  }
  return { default: MockOpenAI };
});

function queueVerdict(verdict: string) {
  const queue: Map<string, QueueEntry[]> = (globalThis as any).__webGuardrailQueue;
  if (!queue.has('guard-main')) queue.set('guard-main', []);
  queue.get('guard-main')!.push({ content: `{"verdict":"${verdict}"}` });
}

function modelCalls(): string[] {
  return (globalThis as any).__webGuardrailCalls;
}

// ── 测试基建（照 webChannelExecutionTarget.test.ts 模式）────────────────
class FakeWebSocket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  sent: Array<{ data: any }> = [];
  send(raw: string): void {
    this.sent.push(JSON.parse(raw));
  }
}

class MemoryRunStore implements RunStore {
  records = new Map<string, RunRecord>();
  async upsertPending(input: UpsertRunInput): Promise<RunRecord> {
    const now = new Date().toISOString();
    const record: RunRecord = {
      runId: input.runId, sessionId: input.sessionId, userId: input.userId, tenantId: input.tenantId,
      status: 'pending', model: input.model, channel: input.channel, requestedAt: now, updatedAt: now,
      idempotencyKey: input.idempotencyKey, executionTarget: input.executionTarget,
      workspaceId: input.workspaceId, metadata: input.metadata ?? {},
    };
    this.records.set(input.runId, record);
    return record;
  }
  async markStatus(runId: string, status: RunStatus): Promise<RunRecord | null> {
    const record = this.records.get(runId);
    if (!record) return null;
    const updated = { ...record, status, updatedAt: new Date().toISOString() };
    this.records.set(runId, updated);
    return updated;
  }
  async get(runId: string): Promise<RunRecord | null> { return this.records.get(runId) ?? null; }
  async findByIdempotencyKey(userId: string | undefined, key: string): Promise<RunRecord | null> {
    return [...this.records.values()].find((r) => r.idempotencyKey === key && r.userId === userId) ?? null;
  }
  async listRecoverable(): Promise<RunRecord[]> { return []; }
  async getActiveBySession(): Promise<RunRecord | null> { return null; }
}

function fakeTenantStore(featureOverrides: Partial<TenantSettings['features']> = {}): TenantStore {
  return {
    findById: (id: string) => ({ id, name: id, disabled: false }),
    getSettings: () => ({ features: featureOverrides }),
  } as unknown as TenantStore;
}

function fakeGuardrailEventStore(): { store: GuardrailEventStore; events: GuardrailEventInsert[] } {
  const events: GuardrailEventInsert[] = [];
  return {
    events,
    store: {
      insert: async (event) => { events.push(event); },
      list: async () => ({ events: [], total: 0 }),
    },
  };
}

interface TestUser { sub: string; username: string; role: 'user' | 'admin'; tenantId: string }
const WAIN_USER: TestUser = { sub: 'u-wu', username: 'wain_user', role: 'user', tenantId: 'wain' };
const WAIN_ADMIN: TestUser = { sub: 'u-wa', username: 'wain_admin', role: 'admin', tenantId: 'wain' };

function chatMessage(overrides: Record<string, unknown>) {
  return {
    action: 'chat' as const,
    client_msg_id: `msg-${Math.random().toString(16).slice(2)}`,
    message: 'hi',
    ...overrides,
  } as any;
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

interface Rig {
  channel: WebChannel;
  ws: FakeWebSocket;
  userEvents: any[];
  enqueued: UpsertRunInput[];
  sessionCatalog: FileSessionCatalog;
  guardrailEvents: GuardrailEventInsert[];
  orgAgentStore: OrgAgentStore;
  send(user: TestUser, overrides: Record<string, unknown>): Promise<void>;
}

describe('WebChannel 专职 Agent 门禁', () => {
  const channels: WebChannel[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    for (const channel of channels) await channel.stop();
    channels.length = 0;
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
    dirs.length = 0;
    ((globalThis as any).__webGuardrailQueue as Map<string, QueueEntry[]>)?.clear();
    modelCalls().length = 0;
  });

  async function makeRig(extra: Partial<WebChannelConfig> = {}): Promise<Rig> {
    const tmp = await mkdtemp(join(tmpdir(), 'web-guardrail-'));
    dirs.push(tmp);
    const runStore = new MemoryRunStore();
    const enqueued: UpsertRunInput[] = [];
    const sessionCatalog = new FileSessionCatalog({ agentCwd: tmp });
    const { store: guardrailEventStore, events: guardrailEvents } = fakeGuardrailEventStore();
    const orgAgentStore = new OrgAgentStore(join(tmp, 'org-agents.json'));
    const dispatch = async function* () { yield { type: 'done' as const }; };
    const channel = new WebChannel({
      agentCwd: tmp,
      executionConfig: createExecutionConfig(),
      runtimeEventStoreFor: (transcriptPath) => new FileEventStore(getRuntimeEventLogPath(transcriptPath)),
      orgAgentStore,
      guardrailEventStore,
      getGuardrailModelConfigs: () => [{ model: 'guard-main', connection: { apiKey: 'test-key' } }],
      tenantStore: fakeTenantStore(),
      enqueueRuntime: {
        scheduler: {
          enqueue: async (input: UpsertRunInput) => {
            enqueued.push(input);
            return runStore.upsertPending(input);
          },
        } as any,
        runStore,
        sessionCatalog,
        enabled: true,
      },
      ...extra,
    }, dispatch as any);
    channels.push(channel);
    const ws = new FakeWebSocket();
    const userEvents: any[] = [];
    (channel as any).eventBus = {
      emitReply: (target: any, data: any) => { target?.send?.(JSON.stringify({ data })); },
      emitSession: (_ctx: any, data: any) => { ws.send(JSON.stringify({ data })); },
      emitUser: (_userId: string, data: any) => { userEvents.push(data); },
      emitDual: (_userId: string, _sessionId: string, data: any) => { userEvents.push(data); },
      emit: () => {},
      subscribe: () => () => {},
      register: () => {},
    };
    return {
      channel, ws, userEvents, enqueued, sessionCatalog, guardrailEvents, orgAgentStore,
      send: async (user, overrides) => {
        const client = { ws: ws as any, user, alive: true, lastActivityAt: Date.now() };
        await (channel as any).processChatMessage(client, chatMessage(overrides));
        await flushMicrotasks();
      },
    };
  }

  async function seedOrgAgent(rig: Rig, overrides: Record<string, unknown> = {}) {
    return rig.orgAgentStore.create({
      tenantId: 'wain',
      name: '产品选型助手',
      instructions: '只回答唯恩选型问题',
      allowedSkills: ['wain-kb'],
      audience: { exposure: 'all', usernames: [] },
      guardrail: {
        enabled: true,
        scopeDescription: '唯恩重载连接器选型',
        rejectionMessage: '这个问题超出了我的职责范围，请咨询选型相关问题。',
        strictness: 'strict',
      },
      enabled: true,
      ...overrides,
    } as any, 'wain_admin');
  }

  it('off_topic → 不 enqueue、合成气泡完整序列、transcript 两行、落库、幂等 done', async () => {
    const rig = await makeRig();
    const agent = await seedOrgAgent(rig);
    queueVerdict('off_topic');

    const clientMsgId = 'msg-off-topic-1';
    await rig.send(WAIN_USER, { message: '帮我写一首诗', orgAgentId: agent.id, client_msg_id: clientMsgId });

    // 不启动 run
    expect(rig.enqueued).toHaveLength(0);
    // WS 合成气泡序列：stream_id → session → block_start → text(预设话术) → block_end → done
    const types = rig.ws.sent.map((m) => m.data?.type);
    const seq = ['stream_id', 'session', 'block_start', 'text', 'block_end', 'done'];
    const indexes = seq.map((t) => types.indexOf(t));
    expect(indexes.every((i) => i >= 0)).toBe(true);
    expect([...indexes].sort((a, b) => a - b)).toEqual(indexes);
    const textEvent = rig.ws.sent.find((m) => m.data?.type === 'text');
    expect(textEvent?.data?.content).toBe('这个问题超出了我的职责范围，请咨询选型相关问题。');
    // 会话完成态广播（前端 loading 结束 + 列表刷新）
    expect(rig.userEvents.find((e) => e.type === 'session_status')?.status).toBe('completed');
    expect(rig.userEvents.some((e) => e.type === 'session_updated')).toBe(true);

    // transcript 两行（刷新后气泡仍在）
    const sessionId = rig.ws.sent.find((m) => m.data?.type === 'session')?.data?.sessionId;
    expect(sessionId).toBeTruthy();
    expect(rig.ws.sent.find((m) => m.data?.type === 'session')?.data?.client_msg_id).toBe(clientMsgId);
    const record = await rig.sessionCatalog.get(sessionId);
    expect(record?.orgAgentId).toBe(agent.id);
    const lines = (await readFile(record!.transcriptPath, 'utf-8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ type: 'user', message: { content: '帮我写一首诗' } });
    expect(JSON.parse(lines[1])).toMatchObject({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '这个问题超出了我的职责范围，请咨询选型相关问题。' }] },
    });

    // guardrail_events 落库
    expect(rig.guardrailEvents).toHaveLength(1);
    expect(rig.guardrailEvents[0]).toMatchObject({
      tenantId: 'wain', orgAgentId: agent.id, verdict: 'off_topic',
      messageText: '帮我写一首诗', username: 'wain_user', sessionId,
    });

    // 幂等：同 client_msg_id 重发 → 拒绝重复提交，不再触发模型/落库
    const callsBefore = modelCalls().length;
    await rig.send(WAIN_USER, { message: '帮我写一首诗', orgAgentId: agent.id, client_msg_id: clientMsgId });
    expect(rig.ws.sent.find((m) => m.data?.type === 'chat_rejected')?.data?.reason_code).toBe('duplicate_inflight');
    expect(modelCalls().length).toBe(callsBefore);
    expect(rig.guardrailEvents).toHaveLength(1);
    expect(rig.enqueued).toHaveLength(0);
  });

  it('uncertain → 正常 enqueue、metadata.guardrail=pass_flagged、落库', async () => {
    const rig = await makeRig();
    const agent = await seedOrgAgent(rig);
    queueVerdict('uncertain');

    await rig.send(WAIN_USER, { message: '这个能用在船上吗', orgAgentId: agent.id });

    expect(rig.enqueued).toHaveLength(1);
    expect(rig.enqueued[0].metadata?.guardrail).toBe('pass_flagged');
    const session = await rig.sessionCatalog.get(rig.enqueued[0].sessionId);
    expect(session?.orgAgentId).toBe(agent.id);
    expect(rig.guardrailEvents).toHaveLength(1);
    expect(rig.guardrailEvents[0]).toMatchObject({
      verdict: 'pass_flagged',
      orgAgentId: agent.id,
      sessionId: rig.enqueued[0].sessionId,
      messageText: '这个能用在船上吗',
    });
  });

  it('/compact 与纯附件消息跳过门禁模型调用', async () => {
    const rig = await makeRig();
    const agent = await seedOrgAgent(rig);

    // /compact：直通，不调模型、不落库
    await rig.send(WAIN_USER, { message: '/compact', orgAgentId: agent.id });
    expect(modelCalls()).toHaveLength(0);
    expect(rig.enqueued).toHaveLength(1);
    expect(rig.enqueued[0].metadata?.guardrail).toBeUndefined();
    expect(rig.guardrailEvents).toHaveLength(0);

    // 纯附件占位消息：不调模型，按 uncertain 放行 + 打标（message_text 记附件名清单）
    await rig.send(WAIN_USER, {
      message: 'Please check the attachments I uploaded',
      orgAgentId: agent.id,
      attachments: [{
        originalName: '选型表.pdf', savedPath: '/tmp/x.pdf', relativePath: 'x.pdf',
        size: 100, mimeType: 'application/pdf', isImage: false,
      }],
    });
    expect(modelCalls()).toHaveLength(0);
    expect(rig.enqueued).toHaveLength(2);
    expect(rig.enqueued[1].metadata?.guardrail).toBe('pass_flagged');
    expect(rig.guardrailEvents).toHaveLength(1);
    expect(rig.guardrailEvents[0].messageText).toBe('[附件] 选型表.pdf');
  });

  it('/compact 只跳过话题分类，取消指派后的旧专家会话仍必须拒绝', async () => {
    const rig = await makeRig();
    const agent = await seedOrgAgent(rig, {
      guardrail: { enabled: false, scopeDescription: '', rejectionMessage: '超纲。', strictness: 'strict' },
    });
    await rig.send(WAIN_USER, { message: '选型问题', orgAgentId: agent.id });
    const sessionId = rig.enqueued[0].sessionId;
    await rig.orgAgentStore.update(agent.id, {
      audience: { exposure: 'allow_users', usernames: ['someone_else'] },
    }, 'wain_admin');

    rig.ws.sent.length = 0;
    await rig.send(WAIN_USER, { message: '/compact', sessionId });
    expect(rig.ws.sent.find((m) => m.data?.type === 'chat_rejected')?.data?.reason_code).toBe('org_agent_unavailable');
    expect(rig.enqueued).toHaveLength(1);
    expect(modelCalls()).toHaveLength(0);
  });

  it('off_topic 新会话的专家绑定写入失败时 fail-closed，不发送 session 或合成回复', async () => {
    const rig = await makeRig();
    const agent = await seedOrgAgent(rig);
    queueVerdict('off_topic');
    vi.spyOn(rig.sessionCatalog, 'upsert').mockRejectedValueOnce(new Error('disk failed'));

    await rig.send(WAIN_USER, { message: '帮我写一首诗', orgAgentId: agent.id, client_msg_id: 'msg-persist-fail' });

    expect(rig.ws.sent.some((m) => m.data?.type === 'session')).toBe(false);
    expect(rig.ws.sent.some((m) => m.data?.type === 'text')).toBe(false);
    expect(rig.ws.sent.find((m) => m.data?.type === 'chat_rejected')?.data).toMatchObject({
      client_msg_id: 'msg-persist-fail',
      reason_code: 'org_agent_unavailable',
    });
    expect(rig.guardrailEvents).toHaveLength(0);
    expect(rig.enqueued).toHaveLength(0);
  });

  it('首条消息调度失败时返回已绑定会话并标记 error，不留下 running 幽灵会话', async () => {
    const rig = await makeRig();
    const agent = await seedOrgAgent(rig, {
      guardrail: { enabled: false, scopeDescription: '', rejectionMessage: '超纲。', strictness: 'strict' },
    });
    const scheduler = (rig.channel as any).config.enqueueRuntime.scheduler;
    vi.spyOn(scheduler, 'enqueue').mockRejectedValueOnce(new Error('scheduler unavailable'));

    await rig.send(WAIN_USER, {
      message: '帮我选型',
      orgAgentId: agent.id,
      client_msg_id: 'msg-scheduler-failed',
    });

    const sessionEvent = rig.ws.sent.find((item) => item.data?.type === 'session')?.data;
    const doneEvent = rig.ws.sent.find((item) => item.data?.type === 'done')?.data;
    expect(sessionEvent).toMatchObject({ client_msg_id: 'msg-scheduler-failed' });
    expect(doneEvent).toMatchObject({ client_msg_id: 'msg-scheduler-failed', error: 'scheduler unavailable' });
    expect(rig.ws.sent.findIndex((item) => item.data?.type === 'session'))
      .toBeLessThan(rig.ws.sent.findIndex((item) => item.data?.type === 'done'));
    await expect(rig.sessionCatalog.get(sessionEvent.sessionId)).resolves.toMatchObject({
      status: 'error',
      orgAgentId: agent.id,
    });
  });

  it('企业专家停用或取消指派后，不消费内存中的悬挂交互', async () => {
    const rig = await makeRig();
    const agent = await seedOrgAgent(rig, {
      guardrail: { enabled: false, scopeDescription: '', rejectionMessage: '超纲。', strictness: 'strict' },
    });
    const client = { ws: rig.ws as any, user: WAIN_USER, alive: true, lastActivityAt: Date.now() };

    for (const [interactionId, patch] of [
      ['interaction-unassigned', { audience: { exposure: 'allow_users', usernames: ['someone_else'] } }],
      ['interaction-disabled', { audience: { exposure: 'all', usernames: [] }, enabled: false }],
    ] as const) {
      await rig.orgAgentStore.update(agent.id, patch as any, 'wain_admin');
      const pending = interactionStore.create(interactionId, 'ask_user', {
        sessionId: 'session-pending',
        userId: WAIN_USER.sub,
        orgAgentId: agent.id,
      });
      rig.ws.sent.length = 0;
      (rig.channel as any).handleRespond(client, { action: 'respond', interactionId, answers: {} });
      await flushMicrotasks();
      expect(rig.ws.sent.find((m) => m.data?.type === 'respond_error')?.data?.error).toContain('企业专家当前不可用');
      expect(interactionStore.get(interactionId)).toBeTruthy();
      interactionStore.resolve(interactionId, { answers: {} });
      await pending;
    }
  });

  it('门禁配置链缺省 → 门禁旁路，org 会话行为与改造前一致（兼容红线）', async () => {
    const rig = await makeRig({ getGuardrailModelConfigs: undefined });
    const agent = await seedOrgAgent(rig); // guardrail.enabled=true 但服务端无配置链

    await rig.send(WAIN_USER, { message: '帮我写一首诗', orgAgentId: agent.id });

    expect(modelCalls()).toHaveLength(0);
    expect(rig.enqueued).toHaveLength(1);
    expect(rig.enqueued[0].metadata?.guardrail).toBeUndefined();
    expect(rig.guardrailEvents).toHaveLength(0);
    // 会话仍正常绑定 org agent
    const session = await rig.sessionCatalog.get(rig.enqueued[0].sessionId);
    expect(session?.orgAgentId).toBe(agent.id);
  });

  it('personalAgentEnabled=false：普通用户个人会话被拒；admin 与 org agent 会话不受影响', async () => {
    const rig = await makeRig({
      tenantStore: fakeTenantStore({ personalAgentEnabled: false }),
    });
    const agent = await seedOrgAgent(rig, {
      guardrail: { enabled: false, scopeDescription: '', rejectionMessage: '超纲。', strictness: 'strict' },
    });

    // 普通用户无 orgAgentId → personal_agent_disabled
    await rig.send(WAIN_USER, { message: 'hi' });
    expect(rig.ws.sent.find((m) => m.data?.type === 'chat_rejected')?.data?.reason_code).toBe('personal_agent_disabled');
    expect(rig.enqueued).toHaveLength(0);

    // admin 个人会话不受影响
    rig.ws.sent.length = 0;
    await rig.send(WAIN_ADMIN, { message: 'hi' });
    expect(rig.ws.sent.find((m) => m.data?.type === 'chat_rejected')).toBeUndefined();
    expect(rig.enqueued).toHaveLength(1);

    // 普通用户 org agent 会话不受影响
    rig.ws.sent.length = 0;
    await rig.send(WAIN_USER, { message: 'hi', orgAgentId: agent.id });
    expect(rig.ws.sent.find((m) => m.data?.type === 'chat_rejected')).toBeUndefined();
    expect(rig.enqueued).toHaveLength(2);
  });

  it('跨租户组织 admin 续聊他租户 org 会话 → access_denied（F1b resume 收口）', async () => {
    const rig = await makeRig();
    const agent = await seedOrgAgent(rig, {
      guardrail: { enabled: false, scopeDescription: '', rejectionMessage: '超纲。', strictness: 'strict' },
    });
    // 成员先建立 org 会话（enqueue 路径写 session meta：tenantId=wain + orgAgentId）
    await rig.send(WAIN_USER, { message: '选型问题', orgAgentId: agent.id });
    expect(rig.enqueued).toHaveLength(1);
    const sessionId = rig.enqueued[0].sessionId;

    // 断言 access_denied：admin 全局 resume 分支解析 meta 后即被 F1b 收口拒绝，
    // 早于 org gate（org gate 的同码拒绝为 org_agent_unavailable）——以实际先触发的为准
    const OTHER_ADMIN: TestUser = { sub: 'u-oa', username: 'other_admin', role: 'admin', tenantId: 'other' };
    rig.ws.sent.length = 0;
    await rig.send(OTHER_ADMIN, { message: '继续', sessionId });
    expect(rig.ws.sent.find((m) => m.data?.type === 'chat_rejected')?.data?.reason_code).toBe('access_denied');
    expect(rig.enqueued).toHaveLength(1);
  });

  it('同租户 admin 续聊本租户成员 org 会话仍可（F1a admin 豁免 audience 生效）', async () => {
    const rig = await makeRig();
    const agent = await seedOrgAgent(rig, {
      // admin 不在指派名单：resume 与新会话都要靠同租户 admin 豁免通过 org gate
      audience: { exposure: 'allow_users', usernames: ['wain_user'] },
      guardrail: { enabled: false, scopeDescription: '', rejectionMessage: '超纲。', strictness: 'strict' },
    });
    await rig.send(WAIN_USER, { message: '选型问题', orgAgentId: agent.id });
    expect(rig.enqueued).toHaveLength(1);
    const sessionId = rig.enqueued[0].sessionId;

    // 续聊成员会话：F1b 放行（同租户）+ org gate 放行
    rig.ws.sent.length = 0;
    await rig.send(WAIN_ADMIN, { message: '继续', sessionId });
    expect(rig.ws.sent.find((m) => m.data?.type === 'chat_rejected')).toBeUndefined();
    expect(rig.enqueued).toHaveLength(2);
    expect(rig.enqueued[1].sessionId).toBe(sessionId);

    // 新会话直连该 org agent：admin 不在 audience，仅靠 F1a 同租户豁免通过
    rig.ws.sent.length = 0;
    await rig.send(WAIN_ADMIN, { message: '新会话', orgAgentId: agent.id });
    expect(rig.ws.sent.find((m) => m.data?.type === 'chat_rejected')).toBeUndefined();
    expect(rig.enqueued).toHaveLength(3);
  });

  it('file backend（enqueueRuntime 缺省）off_topic 拒绝后 session meta 写入 orgAgentId（F2）', async () => {
    const rig = await makeRig({ enqueueRuntime: undefined });
    const agent = await seedOrgAgent(rig);
    queueVerdict('off_topic');

    await rig.send(WAIN_USER, { message: '帮我写一首诗', orgAgentId: agent.id });

    const sessionId = rig.ws.sent.find((m) => m.data?.type === 'session')?.data?.sessionId;
    expect(sessionId).toBeTruthy();
    // 无 enqueue（file backend）也要有 meta：orgAgentId 绑定事实源，第二条消息 resume 门禁依赖它
    const transcriptPath = await findTranscriptOrMetaPathBySessionId(sessionId);
    expect(transcriptPath).toBeTruthy();
    const meta = await readSessionMeta(transcriptPath!);
    expect(meta?.orgAgentId).toBe(agent.id);
    expect(meta?.tenantId).toBe('wain');
  });

  it('orgAgentId 无效（缺失/停用/未指派）→ org_agent_unavailable，不 enqueue', async () => {
    const rig = await makeRig();
    const disabled = await seedOrgAgent(rig, { enabled: false });
    const notAssigned = await seedOrgAgent(rig, {
      audience: { exposure: 'allow_users', usernames: ['someone_else'] },
    });

    for (const orgAgentId of ['oa-not-exist', disabled.id, notAssigned.id]) {
      rig.ws.sent.length = 0;
      await rig.send(WAIN_USER, { message: 'hi', orgAgentId });
      expect(rig.ws.sent.find((m) => m.data?.type === 'chat_rejected')?.data?.reason_code).toBe('org_agent_unavailable');
    }
    expect(rig.enqueued).toHaveLength(0);
    expect(modelCalls()).toHaveLength(0);
  });

  // ── 蓝图 v2 § 4.3.1 三档 mode 行为差异（2026-07-18 加）──
  //   mode='off'     → 不跑门禁模型、直通主 Agent、不落库
  //   mode='shadow'  → 跑门禁 + 落库审计（打 [shadow] 前缀）、**不拦截**主 Agent（新专家观察期）
  //   mode='enforce' → 跑门禁 + 落库 + off_topic 拦截主 Agent（现有行为）
  // 兼容旧数据：`enabled: true` 视为 mode='enforce'（seedOrgAgent 缺省即此路径，
  // 上面 off_topic/uncertain 用例已完整覆盖 enforce 分支）。

  it('mode="off"（含旧 enabled=false 兼容）→ 完全跳过门禁模型 + 直通主 Agent + 不落库', async () => {
    const rig = await makeRig();
    // 用旧 API 形态：enabled=false（不显式传 mode）→ normalize 后应等价 mode='off'
    const agent = await seedOrgAgent(rig, {
      guardrail: {
        enabled: false,
        scopeDescription: '唯恩重载连接器选型',
        rejectionMessage: '超范围。',
        strictness: 'strict',
      },
    });
    queueVerdict('off_topic'); // 排队进去也不会被消费——因为 mode=off 门禁根本不跑

    await rig.send(WAIN_USER, { message: '帮我写一首诗', orgAgentId: agent.id });

    // 门禁模型未被调用（决策 0 短路）
    expect(modelCalls()).toHaveLength(0);
    // 主 Agent 正常 enqueue、metadata 无 guardrail 标记
    expect(rig.enqueued).toHaveLength(1);
    expect(rig.enqueued[0].metadata?.guardrail).toBeUndefined();
    // 无审计事件（"off_topic 拒答 = 需求雷达"数据不能被误污染）
    expect(rig.guardrailEvents).toHaveLength(0);
    // 会话仍绑定 org agent
    const session = await rig.sessionCatalog.get(rig.enqueued[0].sessionId);
    expect(session?.orgAgentId).toBe(agent.id);
  });

  it('mode="shadow" + off_topic → 落库 [shadow] 前缀 + **不拦截**主 Agent（观察期语义）', async () => {
    const rig = await makeRig();
    // 显式设 mode='shadow'（前端 UI 支持后的新形态）
    const agent = await seedOrgAgent(rig, {
      guardrail: {
        mode: 'shadow',
        enabled: true, // 归一化前后 store 都能读；channel 权威依赖 mode
        scopeDescription: '唯恩重载连接器选型',
        rejectionMessage: '这个问题超出了我的职责范围（enforce 才会显示这句）。',
        strictness: 'strict',
      },
    });
    queueVerdict('off_topic');

    await rig.send(WAIN_USER, {
      message: '帮我写一首诗', // 明显超范围
      orgAgentId: agent.id,
    });

    // 门禁被调用（观察期照跑）
    expect(modelCalls()).toEqual(['guard-main']);

    // 关键：**主 Agent 仍启动**，不合成拒答气泡（shadow 语义）
    expect(rig.enqueued).toHaveLength(1);
    // metadata 打 shadow_off_topic 标记，供 run 侧关联/告警面板过滤
    expect(rig.enqueued[0].metadata?.guardrail).toBe('shadow_off_topic');
    // 未下发合成气泡（enforce 才会发 block_start/text/block_end）
    const types = rig.ws.sent.map((m) => m.data?.type);
    expect(types).not.toContain('block_start');
    expect(types).not.toContain('block_end');

    // 落库审计事件：verdict=off_topic + [shadow] 前缀便于看板过滤
    expect(rig.guardrailEvents).toHaveLength(1);
    expect(rig.guardrailEvents[0]).toMatchObject({
      tenantId: 'wain',
      orgAgentId: agent.id,
      verdict: 'off_topic',
      username: 'wain_user',
      sessionId: rig.enqueued[0].sessionId,
    });
    // 前缀 [shadow] 让 GuardrailEventsView "仅看 shadow / enforce" 三档过滤器能区分
    expect(rig.guardrailEvents[0].messageText.startsWith('[shadow] ')).toBe(true);
    expect(rig.guardrailEvents[0].messageText).toContain('帮我写一首诗');
  });

  it('mode="enforce" + off_topic → 现有行为不变：合成气泡拦截 + 落库无 [shadow] 前缀', async () => {
    const rig = await makeRig();
    // 显式设 mode='enforce'（等价于旧 enabled=true 归一化后的行为）
    const agent = await seedOrgAgent(rig, {
      guardrail: {
        mode: 'enforce',
        enabled: true,
        scopeDescription: '唯恩重载连接器选型',
        rejectionMessage: '这个问题超出了我的职责范围，请咨询选型相关问题。',
        strictness: 'strict',
      },
    });
    queueVerdict('off_topic');

    await rig.send(WAIN_USER, { message: '帮我写一首诗', orgAgentId: agent.id });

    // 关键：**不 enqueue 主 Agent**（enforce 拦截）
    expect(rig.enqueued).toHaveLength(0);
    // 合成气泡序列到位
    const textEvent = rig.ws.sent.find((m) => m.data?.type === 'text');
    expect(textEvent?.data?.content).toBe('这个问题超出了我的职责范围，请咨询选型相关问题。');
    // 落库审计：verdict=off_topic，**无** [shadow] 前缀（enforce 分支不加前缀）
    expect(rig.guardrailEvents).toHaveLength(1);
    expect(rig.guardrailEvents[0]).toMatchObject({
      tenantId: 'wain',
      orgAgentId: agent.id,
      verdict: 'off_topic',
      messageText: '帮我写一首诗',
    });
    expect(rig.guardrailEvents[0].messageText.startsWith('[shadow]')).toBe(false);
  });
});

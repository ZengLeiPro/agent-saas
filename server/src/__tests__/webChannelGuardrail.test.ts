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
});

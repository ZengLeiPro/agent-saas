import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildTenantRemoteHandWireEnv,
  createApprovalStoreForSession,
  createEventStoreForSession,
  createModelAdapterForProtocol,
  resolveSessionCatalog,
  resolveTenantRemoteHandsSource,
  resolveWakePrompt,
  visibleWorkspaceCwd,
  type RawRuntimeRunDispatchConfig,
  type TenantRemoteHandDispatchConfig,
} from '../runtime/rawRuntimeRunDispatch.js';
import { ChatCompletionsModelAdapter } from '../runtime/chatCompletionsAdapter.js';
import { ResponsesApiAdapter } from '../runtime/responsesApiAdapter.js';
import { EventBackedApprovalStore } from '../runtime/approvalStore.js';
import { FileEventStore } from '../runtime/fileEventStore.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import type { WorkspaceRef } from '../agent/toolRuntime.js';
import type { RuntimeSessionRecord } from '../runtime/sessionCatalog.js';
import type { ApprovalStore, EventStore, PlatformEvent, PlatformEventInput } from '../runtime/types.js';
import type { RunRecord } from '../runtime/runStore.js';

// 最小可用 config（只放本组 helper 真消费的字段）
function makeConfig(overrides: Partial<RawRuntimeRunDispatchConfig> = {}): RawRuntimeRunDispatchConfig {
  return {
    agentCwd: '/tmp/agent',
    sharedDir: '/tmp/shared',
    ...overrides,
  } as RawRuntimeRunDispatchConfig;
}

function makeSession(overrides: Partial<RuntimeSessionRecord> = {}): RuntimeSessionRecord {
  return {
    sessionId: 'session-x',
    userId: 'user-x',
    username: 'alice',
    channel: 'web',
    cwd: '/tmp/alice',
    transcriptPath: '/tmp/alice/session.jsonl',
    modelRef: 'gpt-5.4-mini',
    executionTarget: 'server-local',
    workspaceId: 'workspace-x',
    status: 'running',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('visibleWorkspaceCwd', () => {
  it('把 server-remote / server-container 的宿主 cwd 折叠成容器内固定 /workspace', () => {
    // 远端 / 容器执行时模型看到的路径必须是容器视角，而不是宿主真实路径。
    expect(visibleWorkspaceCwd('/host/real/path', 'server-remote')).toBe('/workspace');
    expect(visibleWorkspaceCwd('/host/real/path', 'server-container')).toBe('/workspace');
  });

  it('server-local 直接透传宿主 cwd（本地执行时路径即真实路径）', () => {
    expect(visibleWorkspaceCwd('/host/real/path', 'server-local')).toBe('/host/real/path');
  });
});

describe('resolveTenantRemoteHandsSource', () => {
  const hand: TenantRemoteHandDispatchConfig = { id: 'hand-1', baseUrl: 'https://hand.example' };

  it('数组来源原样返回', () => {
    expect(resolveTenantRemoteHandsSource([hand])).toEqual([hand]);
  });

  it('函数来源被求值一次并返回其结果', () => {
    let calls = 0;
    const source = () => {
      calls += 1;
      return [hand];
    };
    expect(resolveTenantRemoteHandsSource(source)).toEqual([hand]);
    expect(calls).toBe(1);
  });

  it('undefined 来源返回 undefined；返回 undefined 的函数同样透传 undefined', () => {
    expect(resolveTenantRemoteHandsSource(undefined)).toBeUndefined();
    expect(resolveTenantRemoteHandsSource(() => undefined)).toBeUndefined();
  });
});

describe('createModelAdapterForProtocol', () => {
  const connection = { apiKey: 'sk-test', baseUrl: 'https://api.example/v1' };

  it('protocol=responses 时路由 ResponsesApiAdapter', () => {
    const adapter = createModelAdapterForProtocol(connection, { protocol: 'responses' });
    expect(adapter).toBeInstanceOf(ResponsesApiAdapter);
  });

  it('protocol 缺省 / 非 responses 时回退 ChatCompletionsModelAdapter', () => {
    expect(createModelAdapterForProtocol(connection, undefined)).toBeInstanceOf(ChatCompletionsModelAdapter);
    expect(createModelAdapterForProtocol(connection, { protocol: 'chat_completions' }))
      .toBeInstanceOf(ChatCompletionsModelAdapter);
  });
});

describe('resolveSessionCatalog / createEventStoreForSession / createApprovalStoreForSession', () => {
  const session = makeSession();

  it('resolveSessionCatalog 优先返回注入的 sessionCatalog，缺省时用 FileSessionCatalog', () => {
    const injected = { marker: 'injected' } as unknown as RawRuntimeRunDispatchConfig['sessionCatalog'];
    expect(resolveSessionCatalog(makeConfig({ sessionCatalog: injected }))).toBe(injected);

    const fallback = resolveSessionCatalog(makeConfig());
    // 缺省实现应带 SessionCatalog 接口方法（不硬编码具体类，只验接口契约）
    expect(typeof fallback.get).toBe('function');
    expect(typeof fallback.findTranscriptPath).toBe('function');
  });

  it('createEventStoreForSession 优先用 eventStoreFactory，缺省时构造 FileEventStore', () => {
    const custom = { append: async () => undefined, list: async () => [] } as unknown as EventStore;
    const factoryCalls: RuntimeSessionRecord[] = [];
    const withFactory = createEventStoreForSession(
      makeConfig({ eventStoreFactory: (s) => { factoryCalls.push(s); return custom; } }),
      session,
    );
    expect(withFactory).toBe(custom);
    expect(factoryCalls).toEqual([session]);

    const fallback = createEventStoreForSession(makeConfig(), session);
    expect(fallback).toBeInstanceOf(FileEventStore);
  });

  it('createApprovalStoreForSession 优先用 approvalStoreFactory（可见 eventStore 入参），缺省时构造 EventBackedApprovalStore', () => {
    const eventStore = new FileEventStore(session.transcriptPath);
    const custom = { get: async () => null } as unknown as ApprovalStore;
    const seenEventStores: EventStore[] = [];
    const withFactory = createApprovalStoreForSession(
      makeConfig({ approvalStoreFactory: (_s, es) => { seenEventStores.push(es); return custom; } }),
      session,
      eventStore,
    );
    expect(withFactory).toBe(custom);
    expect(seenEventStores).toEqual([eventStore]);

    const fallback = createApprovalStoreForSession(makeConfig(), session, eventStore);
    expect(fallback).toBeInstanceOf(EventBackedApprovalStore);
  });
});

describe('buildTenantRemoteHandWireEnv', () => {
  // 用真实 tokens.json（经 AZEROTH_TOKENS_FILE 指向临时文件）驱动 resolveAzerothInjection，
  // 不 mock 被测函数本身，只把外部配置文件当作可注入边界。
  const dirs = new Set<string>();
  let originalEnv: string | undefined;

  afterEach(async () => {
    if (originalEnv === undefined) delete process.env.AZEROTH_TOKENS_FILE;
    else process.env.AZEROTH_TOKENS_FILE = originalEnv;
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
    dirs.clear();
  });

  async function writeTokensConfig(content: unknown): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'azeroth-tokens-'));
    dirs.add(dir);
    const path = join(dir, 'azeroth-tokens.json');
    await writeFile(path, JSON.stringify(content), 'utf-8');
    originalEnv = process.env.AZEROTH_TOKENS_FILE;
    process.env.AZEROTH_TOKENS_FILE = path;
  }

  function workspace(overrides: Partial<WorkspaceRef> = {}): WorkspaceRef {
    return {
      root: '/tmp/ws',
      executionTarget: 'server-remote',
      username: 'huangyiping',
      tenantId: 'kaiyan',
      ...overrides,
    };
  }

  it('workspace 无 username 时短路返回空 env（不触碰 tokens 配置）', () => {
    expect(buildTenantRemoteHandWireEnv(workspace({ username: undefined }))).toEqual({});
  });

  it('命中 (tenantId, username) 时注入 AZEROTH_TOKEN + AZEROTH_API_URL', async () => {
    await writeTokensConfig({
      azerothApiUrl: 'http://azeroth-internal:3000',
      tenants: { kaiyan: { tokens: { huangyiping: 'pat_kaiyan_hyp' } } },
    });
    expect(buildTenantRemoteHandWireEnv(workspace())).toEqual({
      AZEROTH_TOKEN: 'pat_kaiyan_hyp',
      AZEROTH_API_URL: 'http://azeroth-internal:3000',
    });
  });

  it('未配置 apiUrl 时只注入 token，不带 AZEROTH_API_URL', async () => {
    await writeTokensConfig({ tenants: { kaiyan: { tokens: { huangyiping: 'pat_only' } } } });
    expect(buildTenantRemoteHandWireEnv(workspace())).toEqual({ AZEROTH_TOKEN: 'pat_only' });
  });

  it('workspace 缺 tenantId 时回退到 DEFAULT_TENANT_ID 查表', async () => {
    // 缺 tenantId → buildTenantRemoteHandWireEnv 兜底为 DEFAULT_TENANT_ID('pantheon')，
    // v2 二级表命中该组织下的 username。
    await writeTokensConfig({ tenants: { [DEFAULT_TENANT_ID]: { tokens: { huangyiping: 'pat_default' } } } });
    expect(buildTenantRemoteHandWireEnv(workspace({ tenantId: undefined }))).toEqual({ AZEROTH_TOKEN: 'pat_default' });
  });

  it('(tenantId, username) 未命中 PAT 时返回空 env（语义等价"未授权"）', async () => {
    await writeTokensConfig({ tenants: { wain: { tokens: { li: 'pat_wain_li' } } } });
    // kaiyan/huangyiping 在配置里不存在，且非 legacy 组织不回退 v1 → 空。
    expect(buildTenantRemoteHandWireEnv(workspace())).toEqual({});
  });
});

// ── resolveWakePrompt：metadata.wakeMessage 优先级分支（runtimeWake.test.ts 覆盖了
//    "无 wakeMessage 回退 submitted/priorUserMessage" 与 hidden-continue，本组补
//    "有 metadata.wakeMessage 时优先透传其 chatId/senderName/attachments/metadata" 分支）──
describe('resolveWakePrompt（metadata.wakeMessage 优先分支）', () => {
  class MemoryEventStore implements EventStore {
    events: PlatformEvent[] = [];
    async append(event: PlatformEventInput): Promise<PlatformEvent> {
      const full = { ...event, id: `e${this.events.length + 1}`, timestamp: new Date().toISOString() } as PlatformEvent;
      this.events.push(full);
      return full;
    }
    async list(sessionId: string): Promise<PlatformEvent[]> {
      return this.events.filter((event) => !('sessionId' in event) || event.sessionId === sessionId);
    }
  }

  it('run user_message 尚未落库时，优先用 metadata.wakeMessage 的 chatId/senderName/metadata 复原原始消息', async () => {
    const session = makeSession({ sessionId: 'session-wake', userId: 'user-1', username: 'alice' });
    const store = new MemoryEventStore();
    // 只放一条 user_message_submitted（不同 runId），确保走 restore 分支而非 hidden-continue
    await store.append({
      type: 'user_message_submitted',
      sessionId: 'session-wake',
      runId: 'run-other',
      content: 'stale submitted content',
    });
    const run: RunRecord = {
      runId: 'run-wake',
      sessionId: 'session-wake',
      userId: 'user-1',
      status: 'pending',
      model: 'gpt-5.4-mini',
      channel: 'web',
      requestedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      executionTarget: 'server-local',
      workspaceId: 'workspace-x',
      metadata: {
        wakeMessage: {
          chatId: 'chat-override',
          content: '原始诉求：清理磁盘',
          senderId: 'sender-override',
          senderName: '发起人-override',
          metadata: { source: 'dingtalk' },
        },
      },
    };

    const decision = resolveWakePrompt(run, await store.list('session-wake'), session);

    expect(decision.recordUserMessage).toBe(true);
    // metadata.wakeMessage 优先于事件里的 submitted content
    expect(decision.message.content).toBe('原始诉求：清理磁盘');
    expect(decision.message.chatId).toBe('chat-override');
    expect(decision.message.senderId).toBe('sender-override');
    expect(decision.message.senderName).toBe('发起人-override');
    expect(decision.message.metadata).toMatchObject({
      source: 'dingtalk',
      schedulerWake: true,
      originalRunId: 'run-wake',
    });
  });
});

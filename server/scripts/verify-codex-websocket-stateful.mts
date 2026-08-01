import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import {
  type AuthorizedToolCall,
  type ToolCallContext,
  type ToolDescriptor,
  type ToolResult,
  type ToolRuntime,
} from '../src/agent/toolRuntime.js';
import { InMemorySecretVault } from '../src/security/secretVault.js';
import { EventBackedApprovalStore } from '../src/runtime/approvalStore.js';
import {
  EgressDispatcherRegistry,
  createEgressFetch,
  createEgressWebSocketConnector,
} from '../src/runtime/egressDispatcher.js';
import { DEFAULT_EGRESS_CONFIG, type EgressConfig } from '../src/runtime/egressPolicy.js';
import { LegacyTranscriptProjection } from '../src/runtime/legacyTranscriptProjection.js';
import { RawAgentLoop } from '../src/runtime/rawAgentLoop.js';
import { ResponsesApiAdapter } from '../src/runtime/responsesApiAdapter.js';
import { CodexCredentialManager } from '../src/runtime/responses/codexCredentialManager.js';
import { CodexResponsesWebSocketPool } from '../src/runtime/responses/codexResponsesWebSocketPool.js';
import { CodexSubscriptionResponsesTransport } from '../src/runtime/responses/codexSubscriptionResponsesTransport.js';
import type {
  ModelEvent,
  ModelProviderContinuation,
  ModelRequestDiagnostic,
  EventStore,
  EventListOptions,
  PlatformEvent,
  PlatformEventInput,
} from '../src/runtime/types.js';
import type { OutboundEvent } from '../src/types/index.js';

interface CodexAuthFile {
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    account_id?: string;
  };
}

type Completed = Extract<ModelEvent, { type: 'completed' }>;

const model = process.env.CODEX_PROBE_MODEL?.trim() || 'gpt-5.4';
const reasoningEffort = process.env.CODEX_PROBE_REASONING_EFFORT?.trim() || 'high';
const authPath = process.env.CODEX_AUTH_PATH?.trim() || join(homedir(), '.codex', 'auth.json');
const auth = JSON.parse(await readFile(authPath, 'utf8')) as CodexAuthFile;
const accessToken = required(auth.tokens?.access_token, 'Codex auth access_token');
const accountId = required(auth.tokens?.account_id, 'Codex auth account_id');
const expiresAt = jwtExpiresAt(accessToken);
if (Date.parse(expiresAt) <= Date.now() + 10 * 60_000) {
  throw new Error('Codex access token 剩余有效期不足 10 分钟；请先用官方 Codex CLI 刷新登录后再运行验收');
}

const { config: egressConfig, credential: proxyCredential } = localProbeEgressConfig();
const registry = new EgressDispatcherRegistry({
  getConfig: () => egressConfig,
  getConfigVersion: () => 1,
  getProxyCredential: () => proxyCredential,
});
const egressFetch = createEgressFetch(registry);
const pool = new CodexResponsesWebSocketPool(createEgressWebSocketConnector(registry), {
  logger: { warn: (message) => console.warn(message) },
});
const runtimeConfig: {
  enabled: boolean;
  websocketEnabled: boolean;
  credentialRef?: string;
} = { enabled: true, websocketEnabled: true };
const manager = new CodexCredentialManager({
  vault: new InMemorySecretVault(),
  getConfig: () => runtimeConfig,
  fetchImpl: egressFetch,
});
const persisted = await manager.persistLogin({
  accessToken,
  // 真实验收禁止消费官方 CLI 的 refresh token，避免 token rotation 破坏现有登录。
  // access token 一旦异常，探针应明确失败，不在后台偷偷刷新。
  refreshToken: 'codex-websocket-probe-refresh-disabled',
  ...(auth.tokens?.id_token ? { idToken: auth.tokens.id_token } : {}),
  expiresAt,
});
runtimeConfig.credentialRef = persisted.credentialRef;

const adapter = new ResponsesApiAdapter(
  { apiKey: '', baseUrl: 'https://chatgpt.com/backend-api/codex' },
  { protocol: 'responses', responsesTransport: 'codex_subscription', reasoningEffort },
  new CodexSubscriptionResponsesTransport(manager, egressFetch, pool),
);
const diagnostics: ModelRequestDiagnostic[] = [];
const context = {
  runId: `codex-ws-probe-${Date.now()}`,
  sessionId: `codex-ws-probe-${Date.now()}-${accountId.slice(-6)}`,
  tenantId: 'kaiyan-probe',
  model,
  cwd: '/tmp',
  channelContext: { channel: 'cron' as const },
  recordModelRequestDiagnostic: async (event: ModelRequestDiagnostic) => {
    diagnostics.push(event);
  },
};
const system = '你是协议验收 Agent。用户要求回显时调用 Echo；拿到工具结果后只回复结果中的 text。';
const tools = [{
  id: 'Echo',
  name: 'Echo',
  description: '原样回显输入文本。',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
}];

try {
  const firstMessages = [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: '请调用 Echo 回显 ALPHA。' },
  ];
  const first = await run(firstMessages, tools);
  if (first.wireMode !== 'websocket_full') {
    throw new Error(`首轮未使用 WebSocket 全量锚定：${JSON.stringify({
      wireMode: first.wireMode,
      wireFallbackReason: first.wireFallbackReason,
    })}`);
  }
  const call = first.toolCalls.find((item) => item.name === 'Echo');
  if (!call) throw new Error('首轮未产生 Echo 工具调用');

  const firstAssistant = assistantMessage(first);
  const toolOutput = JSON.stringify({ text: 'ALPHA' });
  const secondMessages = [
    ...firstMessages,
    firstAssistant,
    { role: 'tool' as const, tool_call_id: call.id, content: toolOutput },
  ];
  const second = await run(secondMessages, tools);
  if (second.wireMode !== 'websocket_relay') {
    throw new Error(`工具结果轮未命中 WebSocket relay：${JSON.stringify({
      wireMode: second.wireMode,
      wireFallbackReason: second.wireFallbackReason,
    })}`);
  }
  if (!second.content.includes('ALPHA')) {
    throw new Error(`工具结果轮内容不含 ALPHA：${second.content.slice(0, 120)}`);
  }

  const thirdMessages = [
    ...secondMessages,
    assistantMessage(second),
    { role: 'user' as const, content: '现在不要调用工具，只回复 BETA。' },
  ];
  const third = await run(thirdMessages, tools);
  if (third.wireMode !== 'websocket_relay') {
    throw new Error(`跨用户轮未命中 WebSocket relay：${JSON.stringify({
      wireMode: third.wireMode,
      wireFallbackReason: third.wireFallbackReason,
    })}`);
  }
  const rawAgentLoop = await runRawAgentLoopProbe();
  const forcedFallback = await runForcedHttpFallbackProbe();

  console.log(JSON.stringify({
    ok: true,
    model,
    reasoningEffort,
    turns: [first, second, third].map((turn) => ({
      wireMode: turn.wireMode,
      logicalBodyBytes: turn.requestBodyBytes,
      wireBodyBytes: turn.wireRequestBodyBytes,
      inputTokens: turn.usage?.inputTokens,
      outputTokens: turn.usage?.outputTokens,
      toolCalls: turn.toolCalls.map((item) => item.name),
    })),
    rawAgentLoop,
    forcedFallback,
    wireWindow: manager.getRuntimeStatus().wireWindow,
  }, null, 2));
} finally {
  pool.close();
  await registry.close();
}

async function runRawAgentLoopProbe(): Promise<{
  wireModes: string[];
  toolResultCount: number;
  finalTexts: string[];
}> {
  const sessionId = `codex-ws-agent-loop-${Date.now()}`;
  const eventStore = createProbeEventStore();
  const loop = new RawAgentLoop({
    modelAdapter: adapter,
    eventStore,
    approvalStore: new EventBackedApprovalStore(eventStore, sessionId),
    transcriptProjection: new LegacyTranscriptProjection('/dev/null'),
    toolRuntime: createEchoToolRuntime(),
  });
  const instructions = [
    '你是多轮 Agent 验收器。',
    '第一轮必须调用 Echo 两次，分别传入 ALPHA 和 OMEGA，再根据两个工具结果给出一句中文结论。',
    '第二轮不得调用工具，要结合上一轮事实回复 BETA。',
  ].join('\n');
  const first = await collectOutbound(loop.run({
    message: { channel: 'cron', chatId: 'codex-probe', content: '执行第一轮复杂工具任务。' },
    prompt: '执行第一轮复杂工具任务。',
    instructions,
    maxTurns: 5,
    connection: { apiKey: '', baseUrl: 'https://chatgpt.com/backend-api/codex' },
  }, {
    runId: `${sessionId}-run-1`,
    sessionId,
    tenantId: 'kaiyan-probe',
    model,
    cwd: '/tmp',
    channelContext: { channel: 'cron' },
  }));
  const second = await collectOutbound(loop.run({
    message: { channel: 'cron', chatId: 'codex-probe', content: '第二轮：结合上一轮事实，只回复 BETA。' },
    prompt: '第二轮：结合上一轮事实，只回复 BETA。',
    instructions,
    maxTurns: 3,
    connection: { apiKey: '', baseUrl: 'https://chatgpt.com/backend-api/codex' },
  }, {
    runId: `${sessionId}-run-2`,
    sessionId,
    tenantId: 'kaiyan-probe',
    model,
    cwd: '/tmp',
    channelContext: { channel: 'cron' },
  }));
  const persisted = await eventStore.list(sessionId);
  const wireModes = persisted.flatMap((event) => (
    (event.type === 'assistant_message' || event.type === 'assistant_tool_calls') && event.wireMode
      ? [event.wireMode]
      : []
  ));
  if (
    wireModes.length < 3
    || wireModes[0] !== 'websocket_full'
    || wireModes.slice(1).some((mode) => mode !== 'websocket_relay')
  ) {
    throw new Error(`RawAgentLoop wire 接力序列异常：${JSON.stringify(wireModes)}`);
  }
  const toolResultCount = persisted.filter((event) => event.type === 'tool_result').length;
  if (toolResultCount < 2) throw new Error(`RawAgentLoop 预期至少 2 个工具结果，实际 ${toolResultCount}`);
  const finalTexts = [first, second].map((events) => events
    .filter((event): event is Extract<OutboundEvent, { type: 'text_delta' }> => event.type === 'text_delta')
    .map((event) => event.content)
    .join(''));
  if (!finalTexts[1]?.includes('BETA')) {
    throw new Error(`RawAgentLoop 跨 run 回答未包含 BETA：${finalTexts[1]?.slice(0, 120)}`);
  }
  return { wireModes, toolResultCount, finalTexts };
}

async function runForcedHttpFallbackProbe(): Promise<{
  wireMode: string;
  wireFallbackReason?: string;
  content: string;
}> {
  const unavailablePool = new CodexResponsesWebSocketPool(async () => {
    throw new Error('probe_forced_connect_failure');
  });
  const fallbackAdapter = new ResponsesApiAdapter(
    { apiKey: '', baseUrl: 'https://chatgpt.com/backend-api/codex' },
    { protocol: 'responses', responsesTransport: 'codex_subscription', reasoningEffort },
    new CodexSubscriptionResponsesTransport(manager, egressFetch, unavailablePool),
  );
  try {
    let completed: Completed | undefined;
    for await (const event of fallbackAdapter.stream({
      model,
      messages: [
        { role: 'system', content: '你是回退链路验收器，只回复 FALLBACK_OK。' },
        { role: 'user', content: '执行回退验收。' },
      ],
      tools: [],
      toolChoice: 'auto',
    }, {
      ...context,
      runId: `codex-ws-fallback-${Date.now()}`,
      sessionId: `codex-ws-fallback-${Date.now()}`,
    })) {
      if (event.type === 'completed') completed = event;
    }
    if (!completed || completed.terminalStatus !== 'completed') {
      throw new Error(`强制回退未获得 completed：${JSON.stringify(completed)}`);
    }
    if (completed.wireMode !== 'http_sse_full' || completed.wireFallbackReason !== 'connect_failed') {
      throw new Error(`强制回退 wire 结果异常：${JSON.stringify({
        wireMode: completed.wireMode,
        wireFallbackReason: completed.wireFallbackReason,
      })}`);
    }
    if (!completed.content.includes('FALLBACK_OK')) {
      throw new Error(`强制回退回答异常：${completed.content.slice(0, 120)}`);
    }
    return {
      wireMode: completed.wireMode,
      wireFallbackReason: completed.wireFallbackReason,
      content: completed.content,
    };
  } finally {
    unavailablePool.close();
  }
}

async function collectOutbound(stream: AsyncIterable<OutboundEvent>): Promise<OutboundEvent[]> {
  const events: OutboundEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function createEchoToolRuntime(): ToolRuntime {
  const descriptor: ToolDescriptor = {
    id: 'Echo',
    name: 'Echo',
    displayName: '回显',
    description: '原样回显输入文本。',
    schema: z.object({ text: z.string() }),
    parametersJsonSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
    risk: 'safe',
    approvalMode: 'never',
    auditCategory: 'probe',
  };
  return {
    list: () => [descriptor],
    async invoke<TInput>(call: AuthorizedToolCall<TInput>, _context: ToolCallContext): Promise<ToolResult> {
      const parsed = descriptor.schema.parse(call.input) as { text: string };
      return { content: JSON.stringify({ text: parsed.text, source: 'Echo' }) };
    },
  };
}

function createProbeEventStore(): EventStore {
  const events: PlatformEvent[] = [];
  return {
    async append(event: PlatformEventInput): Promise<PlatformEvent> {
      const stored = {
        ...event,
        id: `probe-${events.length + 1}`,
        timestamp: new Date().toISOString(),
      } as PlatformEvent;
      events.push(stored);
      return stored;
    },
    async list(sessionId: string, options?: EventListOptions): Promise<PlatformEvent[]> {
      const excluded = new Set(options?.excludeTypes ?? []);
      return events.filter((event) => (
        'sessionId' in event && event.sessionId === sessionId && !excluded.has(event.type)
      ));
    },
  };
}

async function run(
  messages: Parameters<ResponsesApiAdapter['stream']>[0]['messages'],
  requestTools: Parameters<ResponsesApiAdapter['stream']>[0]['tools'],
): Promise<Completed> {
  let completed: Completed | undefined;
  const diagnosticStart = diagnostics.length;
  for await (const event of adapter.stream({
    model,
    messages,
    tools: requestTools,
    toolChoice: 'auto',
  }, context)) {
    if (event.type === 'completed') completed = event;
  }
  if (!completed || completed.terminalStatus !== 'completed') {
    throw new Error(`Codex probe 未获得 completed 终态：${JSON.stringify(completed
      ? {
          terminalStatus: completed.terminalStatus,
          errorCode: completed.errorCode,
          incompleteReason: completed.incompleteReason,
          finishReason: completed.finishReason,
          wireMode: completed.wireMode,
          wireFallbackReason: completed.wireFallbackReason,
          diagnostics: diagnostics.slice(diagnosticStart).filter((event) => event.type === 'finished'),
        }
      : { event: 'missing' })}`);
  }
  return completed;
}

function assistantMessage(completed: Completed) {
  return {
    role: 'assistant' as const,
    content: completed.content,
    ...(completed.toolCalls.length > 0
      ? {
        tool_calls: completed.toolCalls.map((call) => ({
          id: call.id,
          type: 'function' as const,
          function: { name: call.name, arguments: call.arguments },
          ...(call.namespace ? { namespace: call.namespace } : {}),
        })),
      }
      : {}),
    ...(completed.providerContinuation
      ? { provider_continuation: completed.providerContinuation as ModelProviderContinuation }
      : {}),
  };
}

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} 缺失`);
  return value;
}

function jwtExpiresAt(token: string): string {
  const payload = token.split('.')[1];
  if (!payload) throw new Error('Codex access token 不是可解析的 JWT，已停止验收以避免意外刷新');
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: number };
    if (typeof decoded.exp === 'number') return new Date(decoded.exp * 1_000).toISOString();
  } catch (error) {
    throw new Error(`Codex access token JWT 解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
  throw new Error('Codex access token JWT 缺少 exp，已停止验收以避免意外刷新');
}

function localProbeEgressConfig(): { config: EgressConfig; credential?: string } {
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy || '';
  if (!raw) return { config: DEFAULT_EGRESS_CONFIG };
  const url = new URL(raw);
  const credential = url.username || url.password
    ? `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`
    : undefined;
  url.username = '';
  url.password = '';
  return {
    config: {
      ...DEFAULT_EGRESS_CONFIG,
      server: {
        enabled: true,
        proxyUrl: url.toString(),
        matchDomains: ['chatgpt.com', 'auth.openai.com'],
        bypassDomains: [],
        timeoutMs: 20_000,
        failOpen: true,
      },
    },
    ...(credential ? { credential } : {}),
  };
}

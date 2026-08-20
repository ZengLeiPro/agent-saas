import { afterEach, describe, expect, it, vi } from 'vitest';

import { InMemorySecretVault } from '../security/secretVault.js';
import { ResponsesApiAdapter } from '../runtime/responsesApiAdapter.js';
import {
  CodexCredentialManager,
  hashAccountBinding,
  type CodexSubscriptionRuntimeConfig,
} from '../runtime/responses/codexCredentialManager.js';
import { CodexDeviceAuthService } from '../runtime/responses/codexOAuth.js';
import { CodexSubscriptionResponsesTransport } from '../runtime/responses/codexSubscriptionResponsesTransport.js';
import {
  CodexResponsesWebSocketPool,
  CodexWebSocketUnavailableError,
} from '../runtime/responses/codexResponsesWebSocketPool.js';
import type { ModelEvent, ModelProviderContinuation } from '../runtime/types.js';

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.signature`;
}

function accessToken(accountId: string, email = 'admin@example.com'): string {
  return jwt({
    email,
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  });
}

function sse(eventName: string, payload: unknown): string {
  return `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function responseStream(chunks: string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), init);
}

function terminalStream(id = 'resp-codex'): Response {
  return responseStream([
    sse('response.done', {
      type: 'response.done',
      response: {
        id,
        model: 'gpt-5.4',
        status: 'completed',
        output: [],
        usage: {
          input_tokens: 1_500,
          output_tokens: 12,
          input_tokens_details: { cached_tokens: 1_200 },
          output_tokens_details: { reasoning_tokens: 5 },
        },
      },
    }),
    'data: [DONE]\n\n',
  ]);
}

async function collect(stream: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function createCredentialFixture(options: {
  accountId?: string;
  expiresAt?: string;
  fetchImpl?: typeof fetch;
} = {}) {
  const accountId = options.accountId ?? 'acct-primary';
  const vault = new InMemorySecretVault();
  const config: CodexSubscriptionRuntimeConfig = { enabled: true };
  const manager = new CodexCredentialManager({
    vault,
    getConfig: () => config,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  const persisted = await manager.persistLogin({
    accessToken: accessToken(accountId),
    refreshToken: 'refresh-old',
    idToken: accessToken(accountId),
    expiresAt: options.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  config.credentialRef = persisted.credentialRef;
  return { accountId, config, manager, vault };
}

const context = {
  runId: 'run-codex-1',
  sessionId: 'session-codex-1234',
  tenantId: 'kaiyan',
  model: 'gpt-5.4',
  cwd: '/tmp/codex-workspace',
  channelContext: { channel: 'web' as const },
};

describe('Codex subscription Responses transport', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('使用 OAuth 私有 endpoint、store=false、稳定内容缓存域，并接受 response.done 缺少 canonical output', async () => {
    const { accountId, manager } = await createCredentialFixture();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(responseStream([
      sse('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'reasoning',
          encrypted_content: 'opaque-reasoning-1',
          summary: [{ type: 'summary_text', text: '需要读取文件' }],
        },
      }),
      sse('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: 1,
        item: {
          type: 'function_call',
          call_id: 'call-shell-1',
          name: 'Shell',
          arguments: '{"command":"pwd"}',
        },
      }),
      sse('response.done', {
        type: 'response.done',
        response: {
          id: 'resp-codex-1',
          model: 'gpt-5.4',
          status: 'completed',
          output: null,
          usage: {
            input_tokens: 2_048,
            output_tokens: 20,
            input_tokens_details: { cached_tokens: 1_700 },
            output_tokens_details: { reasoning_tokens: 8 },
          },
        },
      }),
    ]));
    const adapter = new ResponsesApiAdapter(
      { apiKey: '', baseUrl: 'https://chatgpt.com/backend-api/codex' },
      { protocol: 'responses', responsesTransport: 'codex_subscription' },
      new CodexSubscriptionResponsesTransport(manager),
    );

    const events = await collect(adapter.stream({
      model: 'gpt-5.4',
      previousResponseId: 'must-not-be-used',
      messages: [
        { role: 'system', content: '你是原始 Agent harness。' },
        { role: 'user', content: '检查工作区' },
      ],
      tools: [{
        id: 'Shell',
        name: 'Shell',
        description: 'Run a shell command',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      }],
    }, context));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://chatgpt.com/backend-api/codex/responses');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.prompt_cache_key).toMatch(/^[a-f0-9]{32}$/);
    expect(body.prompt_cache_key).not.toBe(context.sessionId);
    expect(init.headers).toMatchObject({
      authorization: expect.stringMatching(/^Bearer /),
      'chatgpt-account-id': accountId,
      originator: 'codex-tui',
      'openai-beta': 'responses=experimental',
      'session-id': body.prompt_cache_key,
      'x-client-request-id': expect.any(String),
    });
    expect(body).toMatchObject({
      model: 'gpt-5.4',
      store: false,
      stream: true,
      include: ['reasoning.encrypted_content'],
      parallel_tool_calls: true,
      tool_choice: 'auto',
      text: { verbosity: 'low' },
    });
    expect(body.previous_response_id).toBeUndefined();
    expect(body.max_output_tokens).toBeUndefined();

    const completed = events.find((event) => event.type === 'completed');
    expect(completed).toMatchObject({
      type: 'completed',
      finishReason: 'tool_calls',
      responseChained: false,
      responseMode: 'full',
      cacheEligible: true,
      usage: {
        inputTokens: 2_048,
        outputTokens: 20,
        cacheReadInputTokens: 1_700,
        reasoningTokens: 8,
      },
      toolCalls: [{
        id: 'call-shell-1',
        name: 'Shell',
        arguments: '{"command":"pwd"}',
      }],
      providerContinuation: {
        provider: 'openai_codex_subscription',
        issuer: 'https://chatgpt.com/backend-api/codex/responses',
        accountBindingHash: hashAccountBinding(accountId),
        items: [{
          type: 'reasoning',
          encrypted_content: 'opaque-reasoning-1',
        }],
      },
    });
    expect(manager.getRuntimeStatus()).toMatchObject({
      requestWindow: {
        sampleCount: 1,
        eligibleRequestCount: 1,
        cacheHitRequestCount: 1,
        eligibleInputTokens: 2_048,
        cachedInputTokens: 1_700,
      },
      lastModel: 'gpt-5.4',
      lastSuccessAt: expect.any(String),
    });
  });

  it('跨 session 复用相同内容指纹，模型、system 或工具签名变化时切换缓存域', async () => {
    const { manager } = await createCredentialFixture();
    const transport = new CodexSubscriptionResponsesTransport(manager);
    const tools = [
      { id: 'Shell', name: 'Shell', description: 'shell', parameters: {} },
      { id: 'Read', name: 'Read', description: 'read', parameters: {} },
    ];
    const base = {
      model: 'gpt-5.4',
      messages: [
        { role: 'system' as const, content: 'stable system' },
        { role: 'user' as const, content: 'first session message' },
      ],
      tools,
      context,
    };

    const first = transport.computePromptCacheKey(base);
    const otherSession = transport.computePromptCacheKey({
      ...base,
      messages: [
        { role: 'system' as const, content: 'stable system' },
        { role: 'user' as const, content: 'different user message' },
      ],
      tools: [...tools].reverse(),
      context: { ...context, sessionId: 'another-session' },
    });

    expect(first).toMatch(/^[a-f0-9]{32}$/);
    expect(otherSession).toBe(first);
    const secondSystemKey = transport.computePromptCacheKey({
      ...base,
      messages: [
        { role: 'system' as const, content: 'stable system' },
        { role: 'system' as const, content: 'second system' },
        { role: 'user' as const, content: 'first session message' },
      ],
    });
    expect(transport.computePromptCacheKey({
      ...base,
      messages: [
        { role: 'system' as const, content: 'stable system' },
        { role: 'system' as const, content: 'changed second system' },
        { role: 'user' as const, content: 'first session message' },
      ],
    })).not.toBe(secondSystemKey);
    expect(transport.computePromptCacheKey({ ...base, model: 'gpt-5.5' })).not.toBe(first);
    expect(transport.computePromptCacheKey({
      ...base,
      messages: [{ role: 'system', content: 'changed system' }],
    })).not.toBe(first);
    expect(transport.computePromptCacheKey({
      ...base,
      tools: [{ ...tools[0]!, deferLoading: true }, tools[1]!],
    })).not.toBe(first);

    const skillTool = {
      id: 'Skill',
      name: 'Skill',
      description: '调用技能\n\n## 当前用户可用技能清单\n\n（当前会话未启用任何技能。）',
      parameters: { type: 'object', properties: { skill: { type: 'string' } } },
    };
    const noSkillKey = transport.computePromptCacheKey({ ...base, tools: [skillTool] });
    const enabledSkillKey = transport.computePromptCacheKey({
      ...base,
      tools: [{
        ...skillTool,
        description: '调用技能\n\n## 当前用户可用技能清单\n\n- `beitong-kitchen-bath-demo`: 北通厨卫演示技能',
      }],
    });
    expect(enabledSkillKey).not.toBe(noSkillKey);
    expect(transport.computePromptCacheKey({
      ...base,
      tools: [{ ...skillTool, parameters: { ...skillTool.parameters, required: ['skill'] } }],
    })).not.toBe(noSkillKey);
  });

  it('HTTP/SSE 在不同平台 session 下发送相同的内容缓存域', async () => {
    const { manager } = await createCredentialFixture();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => terminalStream());
    const adapter = new ResponsesApiAdapter(
      { apiKey: '', baseUrl: 'https://chatgpt.com/backend-api/codex' },
      { protocol: 'responses', responsesTransport: 'codex_subscription' },
      new CodexSubscriptionResponsesTransport(manager),
    );
    const request = {
      model: 'gpt-5.4',
      messages: [
        { role: 'system' as const, content: 'shared system' },
        { role: 'user' as const, content: 'hello' },
      ],
      tools: [],
    };

    await collect(adapter.stream(request, context));
    await collect(adapter.stream({
      ...request,
      messages: [
        { role: 'system' as const, content: 'shared system' },
        { role: 'user' as const, content: 'different conversation' },
      ],
    }, { ...context, sessionId: 'another-platform-session', runId: 'another-run' }));

    const firstInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const secondInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const firstBody = JSON.parse(String(firstInit.body));
    const secondBody = JSON.parse(String(secondInit.body));
    expect(secondBody.prompt_cache_key).toBe(firstBody.prompt_cache_key);
    expect((firstInit.headers as Record<string, string>)['session-id']).toBe(firstBody.prompt_cache_key);
    expect((secondInit.headers as Record<string, string>)['session-id']).toBe(firstBody.prompt_cache_key);
  });

  it('只回放同 endpoint、同账号绑定的 encrypted reasoning，账号切换后自动丢弃', async () => {
    const { accountId, manager } = await createCredentialFixture();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => terminalStream());
    const adapter = new ResponsesApiAdapter(
      { apiKey: '', baseUrl: 'https://chatgpt.com/backend-api/codex' },
      { protocol: 'responses' },
      new CodexSubscriptionResponsesTransport(manager),
    );
    const matching: ModelProviderContinuation = {
      provider: 'openai_codex_subscription',
      issuer: 'https://chatgpt.com/backend-api/codex/responses',
      accountBindingHash: hashAccountBinding(accountId),
      items: [{ type: 'reasoning', encrypted_content: 'matching-opaque' }],
    };
    const mismatched: ModelProviderContinuation = {
      ...matching,
      accountBindingHash: hashAccountBinding('acct-other'),
      items: [{ type: 'reasoning', encrypted_content: 'must-not-leak' }],
    };

    for (const continuation of [matching, mismatched]) {
      await collect(adapter.stream({
        model: 'gpt-5.4',
        messages: [
          { role: 'system', content: 'system' },
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'done', provider_continuation: continuation },
          { role: 'user', content: 'continue' },
        ],
        tools: [],
      }, context));
    }

    const firstBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    const secondBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
    expect(firstBody.input).toContainEqual({
      type: 'reasoning',
      encrypted_content: 'matching-opaque',
    });
    expect(JSON.stringify(secondBody.input)).not.toContain('must-not-leak');
    expect(secondBody.tools).toBeUndefined();
    expect(secondBody.tool_choice).toBe('auto');
    expect(secondBody.parallel_tool_calls).toBe(true);
    expect(secondBody.prompt_cache_key).toBe(firstBody.prompt_cache_key);
  });

  it('授权账号在组装请求与发送之间切换时，transport 再校验并阻止跨账号 opaque replay', async () => {
    let credentialReads = 0;
    const fakeManager = {
      getConfiguration: () => ({
        enabled: true,
        endpoint: 'https://chatgpt.com/backend-api/codex/responses',
        originator: 'kaiyan-agent',
        credentialRef: 'ref',
      }),
      getCredentials: async () => {
        credentialReads += 1;
        const accountId = credentialReads === 1 ? 'acct-old' : 'acct-new';
        return {
          accessToken: accessToken(accountId),
          refreshToken: 'refresh',
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          accountId,
          generation: credentialReads,
        };
      },
      recordModelResult: () => undefined,
      recordModelFailure: () => undefined,
    } as unknown as CodexCredentialManager;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => terminalStream());
    const transport = new CodexSubscriptionResponsesTransport(
      fakeManager,
      fetchMock as unknown as typeof fetch,
    );
    const adapter = new ResponsesApiAdapter(
      { apiKey: '', baseUrl: 'https://chatgpt.com/backend-api/codex' },
      { protocol: 'responses' },
      transport,
    );

    const events = await collect(adapter.stream({
      model: 'gpt-5.4',
      messages: [
        { role: 'system', content: 'system' },
        {
          role: 'assistant',
          content: 'old account response',
          provider_continuation: {
            provider: 'openai_codex_subscription',
            issuer: 'https://chatgpt.com/backend-api/codex/responses',
            accountBindingHash: hashAccountBinding('acct-old'),
            items: [{ type: 'reasoning', encrypted_content: 'old-account-opaque' }],
          },
        },
        { role: 'user', content: 'continue' },
      ],
      tools: [],
    }, context));

    const sentBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(JSON.stringify(sentBody.input)).not.toContain('old-account-opaque');
    expect(events.find((event) => event.type === 'completed')).toMatchObject({
      providerContinuationReset: true,
    });
  });

  it('上游拒绝失效 encrypted_content 时仅剥离 opaque item 重试一次并输出 reset 证据', async () => {
    const { accountId, manager } = await createCredentialFixture();
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          code: 'invalid_encrypted_content',
          message: 'invalid encrypted content',
        },
      }), { status: 400, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(terminalStream('resp-reset'));
    const adapter = new ResponsesApiAdapter(
      { apiKey: '', baseUrl: 'https://chatgpt.com/backend-api/codex' },
      { protocol: 'responses' },
      new CodexSubscriptionResponsesTransport(manager),
    );

    const events = await collect(adapter.stream({
      model: 'gpt-5.4',
      messages: [
        { role: 'system', content: 'system' },
        {
          role: 'assistant',
          content: 'previous',
          provider_continuation: {
            provider: 'openai_codex_subscription',
            issuer: 'https://chatgpt.com/backend-api/codex/responses',
            accountBindingHash: hashAccountBinding(accountId),
            items: [{ type: 'reasoning', encrypted_content: 'expired-opaque' }],
          },
        },
        { role: 'user', content: 'continue' },
      ],
      tools: [],
    }, context));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    const secondBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
    expect(JSON.stringify(firstBody.input)).toContain('expired-opaque');
    expect(JSON.stringify(secondBody.input)).not.toContain('expired-opaque');
    expect(events.find((event) => event.type === 'completed')).toMatchObject({
      providerContinuationReset: true,
      modelRequestAttemptCount: 2,
    });
  });

  it('WebSocket wire 接力不改变 logical responseMode 和上下文核算语义', async () => {
    const { config, manager } = await createCredentialFixture();
    config.websocketEnabled = true;
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const websocketPool = {
      execute: vi.fn(async () => ({
        response: terminalStream('resp-ws'),
        wireMode: 'websocket_relay' as const,
        wireRequestBodyBytes: 128,
      })),
    } as unknown as CodexResponsesWebSocketPool;
    const adapter = new ResponsesApiAdapter(
      { apiKey: '', baseUrl: 'https://chatgpt.com/backend-api/codex' },
      { protocol: 'responses', responsesTransport: 'codex_subscription' },
      new CodexSubscriptionResponsesTransport(manager, fetch, websocketPool),
    );

    const events = await collect(adapter.stream({
      model: 'gpt-5.4',
      previousResponseId: 'logical-response-id-must-remain-unused',
      messages: [{ role: 'user', content: '继续执行' }],
      tools: [],
    }, context));

    expect(fetchMock).not.toHaveBeenCalled();
    const completed = events.find((event) => event.type === 'completed');
    expect(completed).toMatchObject({
      responseChained: false,
      responseMode: 'full',
      wireMode: 'websocket_relay',
      wireRequestBodyBytes: 128,
    });
    const websocketInput = vi.mocked(websocketPool.execute).mock.calls[0]?.[0];
    const websocketBody = JSON.parse(websocketInput?.serializedBody ?? '{}');
    expect(websocketInput).toEqual(expect.objectContaining({
      serializedBody: expect.not.stringContaining('previous_response_id'),
      tenantId: 'kaiyan',
      sessionId: context.sessionId,
      cacheAffinityId: websocketBody.prompt_cache_key,
    }));
    expect(websocketInput?.cacheAffinityId).toMatch(/^[a-f0-9]{32}$/);
    expect(websocketInput?.cacheAffinityId).not.toBe(context.sessionId);
    expect(manager.getRuntimeStatus().wireWindow).toMatchObject({
      sampleCount: 1,
      websocketRequestCount: 1,
      relayRequestCount: 1,
      httpFallbackRequestCount: 0,
    });
  });

  it('WebSocket 建连不可用时无损回退现有 HTTP/SSE 全量请求并留下原因', async () => {
    const { config, manager } = await createCredentialFixture();
    config.websocketEnabled = true;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(terminalStream('resp-sse-fallback'));
    const websocketPool = {
      execute: vi.fn(async () => {
        throw new CodexWebSocketUnavailableError('proxy unavailable', 'connect_failed');
      }),
    } as unknown as CodexResponsesWebSocketPool;
    const adapter = new ResponsesApiAdapter(
      { apiKey: '', baseUrl: 'https://chatgpt.com/backend-api/codex' },
      { protocol: 'responses', responsesTransport: 'codex_subscription' },
      new CodexSubscriptionResponsesTransport(manager, fetch, websocketPool),
    );

    const events = await collect(adapter.stream({
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: '继续执行' }],
      tools: [],
    }, context));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sentBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(sentBody.input).toHaveLength(1);
    expect(sentBody.previous_response_id).toBeUndefined();
    expect(events.find((event) => event.type === 'completed')).toMatchObject({
      responseMode: 'full',
      wireMode: 'http_sse_full',
      wireFallbackReason: 'connect_failed',
    });
    expect(manager.getRuntimeStatus().wireWindow).toMatchObject({
      sampleCount: 1,
      websocketRequestCount: 0,
      httpFallbackRequestCount: 1,
      lastFallbackReason: 'connect_failed',
    });
  });

  it('401 时刷新一次 OAuth token，并用新 token 原地重放同一请求', async () => {
    const { manager } = await createCredentialFixture();
    const newAccessToken = jwt({
      email: 'admin@example.com',
      token_generation: 2,
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct-primary' },
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/oauth/token')) {
        return new Response(JSON.stringify({
          access_token: newAccessToken,
          refresh_token: 'refresh-new',
          expires_in: 3600,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
      if (auth !== `Bearer ${newAccessToken}`) return new Response('', { status: 401 });
      return new Response('', { status: 200 });
    });
    const transport = new CodexSubscriptionResponsesTransport(manager);

    const result = await transport.execute({
      serializedBody: '{"model":"gpt-5.4"}',
      context,
      clientRequestId: 'request-1',
    });

    expect(result.response.status).toBe(200);
    expect(result.authRetryCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((await manager.getStatus()).generation).toBe(2);
    expect(manager.getRuntimeStatus().oauth).toMatchObject({
      lastRefreshAt: expect.any(String),
      lastRefreshGeneration: 2,
    });
  });

  it('最终请求异常只记录脱敏错误，不把 bearer token 暴露给管理状态', async () => {
    const { manager } = await createCredentialFixture();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('network failed Authorization: Bearer secret-token-value'),
    );
    const adapter = new ResponsesApiAdapter(
      { apiKey: '', baseUrl: 'https://chatgpt.com/backend-api/codex' },
      { protocol: 'responses' },
      new CodexSubscriptionResponsesTransport(manager),
    );

    await expect(collect(adapter.stream({
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
    }, context))).rejects.toThrow('network failed');

    const runtime = manager.getRuntimeStatus();
    expect(runtime).toMatchObject({
      requestWindow: { sampleCount: 1 },
      lastErrorAt: expect.any(String),
      lastError: expect.stringContaining('Bearer [REDACTED]'),
    });
    expect(runtime.lastError).not.toContain('secret-token-value');
  });

  it('运行健康窗口最多保留 50 次，并只用 cache eligible 请求计算命中率', async () => {
    const { manager } = await createCredentialFixture();
    for (let index = 0; index < 55; index += 1) {
      manager.recordModelResult({
        model: 'gpt-5.4',
        terminalStatus: 'completed',
        usage: {
          inputTokens: index === 0 ? 500 : 2_000,
          cacheReadInputTokens: index % 2 === 0 ? 1_000 : 0,
        },
        cacheEligible: index > 0,
      });
    }

    const runtime = manager.getRuntimeStatus();
    expect(runtime.requestWindow).toMatchObject({
      limit: 50,
      sampleCount: 50,
      eligibleRequestCount: 50,
      cacheHitRequestCount: 25,
      eligibleInputTokens: 100_000,
      cachedInputTokens: 25_000,
      cacheHitRequestRate: 0.5,
      cachedInputTokenRate: 0.25,
    });
  });

  it('OAuth 刷新失败状态脱敏，后续刷新成功会清除旧错误', async () => {
    const refreshFetch = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ error: 'refresh_token refresh-secret rejected' }),
        { status: 401 },
      ))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: accessToken('acct-primary'),
        refresh_token: 'refresh-new',
        expires_in: 3600,
      }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const { manager } = await createCredentialFixture({
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      fetchImpl: refreshFetch,
    });

    await expect(manager.getCredentials()).rejects.toThrow(/OAuth refresh/);
    expect(manager.getRuntimeStatus().oauth).toMatchObject({
      lastRefreshErrorAt: expect.any(String),
      lastRefreshError: expect.not.stringContaining('refresh-secret'),
    });

    const refreshed = await manager.getCredentials();
    expect(refreshed.generation).toBe(2);
    expect(manager.getRuntimeStatus().oauth).toMatchObject({
      lastRefreshAt: expect.any(String),
      lastRefreshGeneration: 2,
    });
    expect(manager.getRuntimeStatus().oauth.lastRefreshError).toBeUndefined();
  });

  it('并发过期检查共享同一个 refresh singleflight', async () => {
    let releaseRefresh: (() => void) | undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const refreshFetch = vi.fn(async () => {
      await refreshGate;
      return new Response(JSON.stringify({
        access_token: accessToken('acct-primary'),
        refresh_token: 'refresh-new',
        expires_in: 3600,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const { manager } = await createCredentialFixture({
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      fetchImpl: refreshFetch,
    });

    const first = manager.getCredentials();
    const second = manager.getCredentials();
    await Promise.resolve();
    releaseRefresh?.();
    const [a, b] = await Promise.all([first, second]);

    expect(a.generation).toBe(2);
    expect(b.generation).toBe(2);
    expect(refreshFetch).toHaveBeenCalledTimes(1);
  });

  it('401 使用的旧 generation 已被另一实例刷新时直接复用新 token，不重复消费 refresh token', async () => {
    const refreshFetch = vi.fn(async () => new Response(JSON.stringify({
      access_token: accessToken('acct-primary'),
      refresh_token: 'refresh-new',
      expires_in: 3600,
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const { manager } = await createCredentialFixture({
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      fetchImpl: refreshFetch,
    });

    const refreshedByOtherRequest = await manager.getCredentials();
    const recoveredAfterOld401 = await manager.getCredentials(true, 1);

    expect(refreshedByOtherRequest.generation).toBe(2);
    expect(recoveredAfterOld401.generation).toBe(2);
    expect(refreshFetch).toHaveBeenCalledTimes(1);
  });

  it('device flow 只向管理调用方返回 user code，并用 authorization code 换 token', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        device_auth_id: 'private-device-id',
        user_code: 'ABCD-EFGH',
        interval: 0,
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        authorization_code: 'authorization-code',
        code_verifier: 'verifier',
        code_challenge: 'challenge',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: accessToken('acct-device'),
        refresh_token: 'refresh-device',
        id_token: accessToken('acct-device'),
        expires_in: 3600,
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const service = new CodexDeviceAuthService(fetchMock as unknown as typeof fetch);

    const started = await service.start();
    expect(started).toMatchObject({
      sessionId: expect.any(String),
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://auth.openai.com/codex/device',
    });
    expect(started).not.toHaveProperty('deviceAuthId');

    const completed = await service.poll(started.sessionId);
    expect(completed.status).toBe('completed');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const pollBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(pollBody).toEqual({
      device_auth_id: 'private-device-id',
      user_code: 'ABCD-EFGH',
    });
  });
});

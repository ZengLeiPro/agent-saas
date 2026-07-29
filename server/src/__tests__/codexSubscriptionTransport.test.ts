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

  it('使用 OAuth 私有 endpoint、store=false、稳定 session cache key，并接受 response.done 缺少 canonical output', async () => {
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
    expect(init.headers).toMatchObject({
      authorization: expect.stringMatching(/^Bearer /),
      'chatgpt-account-id': accountId,
      originator: 'codex-tui',
      'openai-beta': 'responses=experimental',
      'session-id': context.sessionId,
      'x-client-request-id': expect.any(String),
    });
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      model: 'gpt-5.4',
      store: false,
      stream: true,
      include: ['reasoning.encrypted_content'],
      parallel_tool_calls: true,
      prompt_cache_key: context.sessionId,
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

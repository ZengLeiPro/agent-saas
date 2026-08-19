import { createHash } from 'node:crypto';

import type {
  ModelChatMessage,
  ModelToolDefinition,
  RunContext,
} from '../types.js';
import {
  CodexCredentialManager,
  hashAccountBinding,
} from './codexCredentialManager.js';
import {
  CodexResponsesWebSocketPool,
  CodexWebSocketUnavailableError,
} from './codexResponsesWebSocketPool.js';
import type {
  ResponsesTransport,
  ResponsesTransportExecuteInput,
  ResponsesTransportExecuteResult,
} from './responsesTransport.js';

export class CodexSubscriptionResponsesTransport implements ResponsesTransport {
  readonly id = 'codex_subscription' as const;
  readonly capabilities = {
    responseState: 'stateless',
    terminalOutput: 'stream_authoritative_when_missing',
    usageLookup: false,
    responseDelete: false,
    encryptedReasoning: true,
    omitToolConfigurationWhenEmpty: true,
    parallelToolCalls: true,
    maxOutputTokens: false,
  } as const;

  constructor(
    private readonly credentials: CodexCredentialManager,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly websocketPool?: CodexResponsesWebSocketPool,
  ) {}

  computePromptCacheKey(input: {
    model: string;
    messages: ModelChatMessage[];
    tools: ModelToolDefinition[];
    context: RunContext;
  }): string {
    const systemContent = input.messages.find((message) => message.role === 'system')?.content ?? '';
    const toolSignature = input.tools
      .map((tool) => `${tool.mcpServer?.namespace ?? '-'}:${tool.name}:${tool.deferLoading === true ? 'deferred' : 'eager'}`)
      .sort()
      .join(',');
    return createHash('sha256')
      .update(`${input.model}\n${systemContent}\n${toolSignature}`)
      .digest('hex')
      .slice(0, 32);
  }

  async getContinuationBinding() {
    const token = await this.credentials.getCredentials(false);
    const config = this.credentials.getConfiguration();
    return {
      provider: 'openai_codex_subscription' as const,
      issuer: config.endpoint,
      accountBindingHash: hashAccountBinding(token.accountId),
    };
  }

  async execute(input: ResponsesTransportExecuteInput): Promise<ResponsesTransportExecuteResult> {
    const first = await this.credentials.getCredentials(false);
    const firstPrepared = prepareRequestForBinding(input, this.bindingFor(first.accountId));
    const firstResult = await this.executeWithToken(firstPrepared.input, first.accessToken, first.accountId);
    if (firstResult.response.status !== 401) {
      return {
        ...firstResult,
        ...(firstPrepared.reset ? { continuationReplayReset: true } : {}),
      };
    }

    await firstResult.response.body?.cancel().catch(() => undefined);
    const refreshed = await this.credentials.getCredentials(true, first.generation);
    const retryPrepared = prepareRequestForBinding(input, this.bindingFor(refreshed.accountId));
    const retried = await this.executeWithToken(
      retryPrepared.input,
      refreshed.accessToken,
      refreshed.accountId,
    );
    return {
      ...retried,
      authRetryCount: 1,
      ...(firstPrepared.reset || retryPrepared.reset ? { continuationReplayReset: true } : {}),
    };
  }

  observeResult(input: Parameters<CodexCredentialManager['recordModelResult']>[0]): void {
    this.credentials.recordModelResult(input);
  }

  observeFailure(input: { model: string; error: unknown }): void {
    this.credentials.recordModelFailure(input.model, input.error);
  }

  private async executeWithToken(
    input: ResponsesTransportExecuteInput,
    accessToken: string,
    accountId: string,
  ): Promise<ResponsesTransportExecuteResult> {
    const config = this.credentials.getConfiguration();
    if (config.websocketEnabled && this.websocketPool) {
      try {
        const binding = this.bindingFor(accountId);
        const result = await this.websocketPool.execute({
          endpoint: config.endpoint,
          accessToken,
          accountId,
          accountBindingHash: binding.accountBindingHash,
          originator: config.originator,
          serializedBody: input.serializedBody,
          tenantId: input.context.tenantId ?? '__default__',
          sessionId: input.context.sessionId,
          cacheAffinityId: input.promptCacheKey ?? input.context.sessionId,
          clientRequestId: input.clientRequestId,
          signal: input.signal,
        });
        this.credentials.recordWireRequest({
          mode: result.wireMode,
          logicalRequestBodyBytes: Buffer.byteLength(input.serializedBody, 'utf8'),
          wireRequestBodyBytes: result.wireRequestBodyBytes,
        });
        return {
          response: result.response,
          continuationBinding: binding,
          wireMode: result.wireMode,
          wireRequestBodyBytes: result.wireRequestBodyBytes,
        };
      } catch (error) {
        if (!(error instanceof CodexWebSocketUnavailableError)) throw error;
        this.credentials.recordWireRequest({
          mode: 'http_sse_full',
          logicalRequestBodyBytes: Buffer.byteLength(input.serializedBody, 'utf8'),
          wireRequestBodyBytes: Buffer.byteLength(input.serializedBody, 'utf8'),
          fallbackReason: error.reason,
        });
        return this.executeHttpWithToken(input, accessToken, accountId, error.reason);
      }
    }
    return this.executeHttpWithToken(
      input,
      accessToken,
      accountId,
      config.websocketEnabled ? 'pool_unavailable' : undefined,
    );
  }

  private async executeHttpWithToken(
    input: ResponsesTransportExecuteInput,
    accessToken: string,
    accountId: string,
    fallbackReason?: string,
  ): Promise<ResponsesTransportExecuteResult> {
    const config = this.credentials.getConfiguration();
    const response = await this.fetchImpl(config.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'chatgpt-account-id': accountId,
        originator: config.originator,
        'user-agent': `${config.originator}/0.0.0 (${process.platform}; ${process.arch}) kaiyan-agent`,
        'openai-beta': 'responses=experimental',
        accept: 'text/event-stream',
        'content-type': 'application/json',
        'session-id': input.promptCacheKey ?? input.context.sessionId,
        'x-client-request-id': input.clientRequestId,
      },
      body: input.serializedBody,
      signal: input.signal,
    });
    return {
      response,
      continuationBinding: this.bindingFor(accountId),
      wireMode: 'http_sse_full',
      wireRequestBodyBytes: Buffer.byteLength(input.serializedBody, 'utf8'),
      ...(fallbackReason ? { wireFallbackReason: fallbackReason } : {}),
    };
  }

  private bindingFor(accountId: string) {
    const config = this.credentials.getConfiguration();
    return {
      provider: 'openai_codex_subscription' as const,
      issuer: config.endpoint,
      accountBindingHash: hashAccountBinding(accountId),
    };
  }
}

function prepareRequestForBinding(
  input: ResponsesTransportExecuteInput,
  actualBinding: NonNullable<ResponsesTransportExecuteResult['continuationBinding']>,
): { input: ResponsesTransportExecuteInput; reset: boolean } {
  const expected = input.expectedContinuationBinding;
  if (
    !expected
    || (
      expected.provider === actualBinding.provider
      && expected.issuer === actualBinding.issuer
      && expected.accountBindingHash === actualBinding.accountBindingHash
    )
  ) {
    return { input, reset: false };
  }

  const body = JSON.parse(input.serializedBody) as Record<string, unknown>;
  if (!Array.isArray(body.input)) return { input, reset: false };
  const filtered = body.input.filter((item) => !(
    item
    && typeof item === 'object'
    && (item as Record<string, unknown>).type === 'reasoning'
  ));
  if (filtered.length === body.input.length) return { input, reset: false };
  return {
    input: {
      ...input,
      serializedBody: JSON.stringify({ ...body, input: filtered }),
    },
    reset: true,
  };
}

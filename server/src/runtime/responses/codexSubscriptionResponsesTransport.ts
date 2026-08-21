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
  CodexWebSocketQuotaExhaustedError,
  CodexWebSocketUnavailableError,
} from './codexResponsesWebSocketPool.js';
import { isCodexQuotaError, quotaErrorCode } from './codexQuota.js';
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
    const systemContent = input.messages
      .filter(
        (message): message is Extract<ModelChatMessage, { role: 'system' }> => message.role === 'system',
      )
      .map((message) => message.content)
      .join('\n\n');
    // Skill 工具描述包含按用户计算的可用技能清单；缓存指纹必须覆盖完整工具定义，
    // 否则“无 Skill”与“已启用 Skill”的新会话会共享过期的清单。
    const toolSignature = input.tools
      .map((tool) => JSON.stringify({
        id: tool.id,
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        deferLoading: tool.deferLoading === true,
        mcpServer: tool.mcpServer ?? null,
      }))
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
    const orderedRefs = this.orderedCredentialRefs();
    const first = await this.credentials.getCredentials(false);
    const candidateRefs = Array.from(new Set([
      ...(first.credentialRef ? [first.credentialRef] : []),
      ...orderedRefs,
    ]));
    if (candidateRefs.length === 0) {
      throw new Error('Codex subscription 尚未完成账号授权');
    }

    let token = first;
    for (let index = 0; index < candidateRefs.length; index += 1) {
      const credentialRef = candidateRefs[index];
      if (index > 0) token = await this.getCredentialsForCredential(credentialRef);
      try {
        const result = await this.executeWithAuthRecovery(input, token);
        if (!(await isCodexQuotaResponse(result.response))) {
          return result;
        }
        if (index === candidateRefs.length - 1) return result;
        await result.response.body?.cancel().catch(() => undefined);
      } catch (error) {
        if (!isCodexQuotaTransportError(error)) throw error;
        if (index === candidateRefs.length - 1) {
          return quotaErrorResult(input, token.accountId, error);
        }
      }
    }

    throw new Error('Codex subscription 未能选择可用授权账号');
  }

  private async executeWithAuthRecovery(
    input: ResponsesTransportExecuteInput,
    token: Awaited<ReturnType<CodexCredentialManager['getCredentials']>>,
  ): Promise<ResponsesTransportExecuteResult> {
    const firstPrepared = prepareRequestForBinding(input, this.bindingFor(token.accountId));
    const firstResult = await this.executeWithToken(firstPrepared.input, token.accessToken, token.accountId);
    if (firstResult.response.status !== 401) {
      return {
        ...firstResult,
        ...(firstPrepared.reset ? { continuationReplayReset: true } : {}),
      };
    }

    await firstResult.response.body?.cancel().catch(() => undefined);
    const refreshed = await this.credentials.getCredentials(true, token.generation, token.credentialRef);
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

  private orderedCredentialRefs(): string[] {
    const manager = this.credentials as CodexCredentialManager & {
      getCredentialRefs?: () => string[];
    };
    const refs = typeof manager.getCredentialRefs === 'function'
      ? manager.getCredentialRefs()
      : [this.credentials.getConfiguration().credentialRef].filter((ref): ref is string => !!ref);
    return Array.from(new Set(refs.filter((ref): ref is string => typeof ref === 'string' && ref.length > 0)));
  }

  private async getCredentialsForCredential(
    credentialRef: string,
  ): Promise<Awaited<ReturnType<CodexCredentialManager['getCredentials']>>> {
    const manager = this.credentials as CodexCredentialManager & {
      getCredentialsForCredential?: CodexCredentialManager['getCredentialsForCredential'];
    };
    if (typeof manager.getCredentialsForCredential === 'function') {
      return manager.getCredentialsForCredential(credentialRef);
    }
    return this.credentials.getCredentials(false, undefined, credentialRef);
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
        if (error instanceof CodexWebSocketQuotaExhaustedError) throw error;
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

async function isCodexQuotaResponse(response: Response): Promise<boolean> {
  if (response.ok) return false;
  const text = await response.clone().text().catch(() => '');
  let code: string | undefined;
  let message: string | undefined;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const error = parsed.error && typeof parsed.error === 'object' && !Array.isArray(parsed.error)
      ? parsed.error as Record<string, unknown>
      : parsed;
    code = typeof error.code === 'string' ? error.code : undefined;
    message = typeof error.message === 'string' ? error.message : undefined;
  } catch {
    // 非 JSON body 仍交给统一文本判定。
  }
  return isCodexQuotaError({ status: response.status, code, message, rawText: text });
}

function isCodexQuotaTransportError(error: unknown): error is CodexWebSocketQuotaExhaustedError {
  return error instanceof CodexWebSocketQuotaExhaustedError
    || (error instanceof CodexWebSocketUnavailableError && error.reason === 'quota_exhausted');
}

function quotaErrorResult(
  input: ResponsesTransportExecuteInput,
  accountId: string,
  error: CodexWebSocketQuotaExhaustedError,
): ResponsesTransportExecuteResult {
  const body = JSON.stringify({
    error: {
      code: error.code || quotaErrorCode({ message: error.message }),
      message: error.message,
    },
  });
  return {
    response: new Response(body, {
      status: error.status,
      headers: { 'content-type': 'application/json' },
    }),
    continuationBinding: {
      provider: 'openai_codex_subscription',
      issuer: 'https://chatgpt.com/backend-api/codex/responses',
      accountBindingHash: hashAccountBinding(accountId),
    },
    wireMode: 'http_sse_full',
    wireRequestBodyBytes: Buffer.byteLength(input.serializedBody, 'utf8'),
  };
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

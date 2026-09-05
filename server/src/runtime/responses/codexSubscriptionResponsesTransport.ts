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
  CodexWebSocketAccountUnavailableError,
  CodexWebSocketQuotaExhaustedError,
  CodexWebSocketUnavailableError,
} from './codexResponsesWebSocketPool.js';
import {
  CodexAccountAuthUnavailableError,
  credentialFailureCode,
  executeCodexCredentialFailover,
  isCodexAccountUnavailableResponse,
  isPermanentCredentialError,
  resolveCredentialFailureGeneration,
} from './codexCredentialFailover.js';
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
    const config = this.credentials.getConfiguration();
    for (const credentialRef of this.orderedCredentialRefs()) {
      const runtimeState = await this.getRuntimeState(credentialRef);
      if (runtimeState) continue;
      try {
        const token = await this.getCredentialsForCredential(credentialRef);
        return {
          provider: 'openai_codex_subscription' as const,
          issuer: config.endpoint,
          accountBindingHash: hashAccountBinding(token.accountId),
        };
      } catch (error) {
        if (!isPermanentCredentialError(error)) throw error;
        await this.markAuthUnavailable(
          credentialRef,
          credentialFailureCode(error),
          await resolveCredentialFailureGeneration(this.credentials, credentialRef, error),
        );
      }
    }
    return {
      provider: 'openai_codex_subscription' as const,
      issuer: config.endpoint,
      accountBindingHash: hashAccountBinding('__no_available_codex_account__'),
    };
  }

  async execute(input: ResponsesTransportExecuteInput): Promise<ResponsesTransportExecuteResult> {
    const credentialRefs = this.orderedCredentialRefs();
    if (credentialRefs.length === 0) throw new Error('Codex subscription 尚未完成账号授权');
    return executeCodexCredentialFailover({
      request: input,
      credentials: this.credentials,
      credentialRefs,
      executeWithCredential: (token) => this.executeWithAuthRecovery(input, token),
    });
  }

  private async executeWithAuthRecovery(
    input: ResponsesTransportExecuteInput,
    token: Awaited<ReturnType<CodexCredentialManager['getCredentials']>>,
  ): Promise<ResponsesTransportExecuteResult> {
    const firstPrepared = prepareRequestForBinding(input, this.bindingFor(token.accountId));
    const firstResult = await this.executeWithToken(
      firstPrepared.input, token.accessToken, token.accountId,
      token.credentialRef ?? `account:${hashAccountBinding(token.accountId)}`, token.generation,
    );
    if (input.recoveryAttempt) return firstResult;
    if (firstResult.response.status !== 401) {
      if (await isCodexAccountUnavailableResponse(firstResult.response)) {
        await firstResult.response.body?.cancel().catch(() => undefined);
        throw new CodexAccountAuthUnavailableError(
          'account_unavailable', 'Codex 授权账号不可用', token.generation,
        );
      }
      return {
        ...firstResult,
        ...(firstPrepared.reset ? { continuationReplayReset: true } : {}),
      };
    }

    await firstResult.response.body?.cancel().catch(() => undefined);
    let refreshed: Awaited<ReturnType<CodexCredentialManager['getCredentials']>>;
    try {
      refreshed = await this.credentials.getCredentials(true, token.generation, token.credentialRef);
    } catch (error) {
      if (isPermanentCredentialError(error)) {
        const credentialRef = token.credentialRef
          ?? `account:${hashAccountBinding(token.accountId)}`;
        throw new CodexAccountAuthUnavailableError(
          credentialFailureCode(error),
          String(error),
          await resolveCredentialFailureGeneration(this.credentials, credentialRef, error),
        );
      }
      throw error;
    }
    const retryPrepared = prepareRequestForBinding(input, this.bindingFor(refreshed.accountId));
    const retried = await this.executeWithToken(
      retryPrepared.input,
      refreshed.accessToken,
      refreshed.accountId,
      refreshed.credentialRef ?? `account:${hashAccountBinding(refreshed.accountId)}`,
      refreshed.generation,
    );
    if (retried.response.status === 401 || (await isCodexAccountUnavailableResponse(retried.response))) {
      await retried.response.body?.cancel().catch(() => undefined);
      throw new CodexAccountAuthUnavailableError(
        retried.response.status === 401 ? 'authentication_failed_after_refresh' : 'account_unavailable',
        'Codex 授权账号刷新后仍不可用',
        refreshed.generation,
      );
    }
    return {
      ...retried,
      authRetryCount: 1,
      ...(firstPrepared.reset || retryPrepared.reset ? { continuationReplayReset: true } : {}),
    };
  }

  private async getRuntimeState(credentialRef: string) {
    return (this.credentials as CodexCredentialManager & {
      getRuntimeState?: CodexCredentialManager['getRuntimeState'];
    }).getRuntimeState?.(credentialRef);
  }

  private async markAuthUnavailable(
    credentialRef: string, code: string, credentialGeneration: number,
  ): Promise<void> {
    await (this.credentials as CodexCredentialManager & {
      markAuthUnavailable?: CodexCredentialManager['markAuthUnavailable'];
    }).markAuthUnavailable?.(credentialRef, code, credentialGeneration);
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
    credentialRef: string,
    credentialGeneration: number,
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
          credentialRef,
          credentialGeneration,
          originator: config.originator,
          serializedBody: input.serializedBody,
          tenantId: input.context.tenantId ?? '__default__',
          sessionId: input.context.sessionId,
          cacheAffinityId: input.promptCacheKey ?? input.context.sessionId,
          clientRequestId: input.clientRequestId,
          signal: input.signal,
          recoveryAttempt: input.recoveryAttempt,
        });
        this.credentials.recordWireRequest({
          mode: result.wireMode,
          logicalRequestBodyBytes: Buffer.byteLength(input.serializedBody, 'utf8'),
          wireRequestBodyBytes: result.wireRequestBodyBytes,
        });
        return {
          response: result.response,
          invalidate: result.invalidate,
          continuationBinding: binding,
          wireMode: result.wireMode,
          wireRequestBodyBytes: result.wireRequestBodyBytes,
        };
      } catch (error) {
        if (error instanceof CodexWebSocketQuotaExhaustedError) throw error;
        if (error instanceof CodexWebSocketAccountUnavailableError) {
          throw new CodexAccountAuthUnavailableError(
            error.code, error.message, credentialGeneration,
          );
        }
        if (!(error instanceof CodexWebSocketUnavailableError)) throw error;
        if (input.recoveryAttempt || input.signal?.aborted) throw error;
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

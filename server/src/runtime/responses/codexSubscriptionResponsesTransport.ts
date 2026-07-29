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
  ) {}

  computePromptCacheKey(input: {
    model: string;
    messages: ModelChatMessage[];
    tools: ModelToolDefinition[];
    context: RunContext;
  }): string {
    const sessionId = input.context.sessionId.trim();
    if (sessionId.length <= 64) return sessionId;
    return createHash('sha256').update(sessionId).digest('hex');
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

  private async executeWithToken(
    input: ResponsesTransportExecuteInput,
    accessToken: string,
    accountId: string,
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
        'session-id': input.context.sessionId,
        'x-client-request-id': input.clientRequestId,
      },
      body: input.serializedBody,
      signal: input.signal,
    });
    return {
      response,
      continuationBinding: this.bindingFor(accountId),
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

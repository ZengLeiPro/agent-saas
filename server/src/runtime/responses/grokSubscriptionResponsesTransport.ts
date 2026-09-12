import type { ModelChatMessage, ModelToolDefinition, RunContext } from '../types.js';
import { proxyRequiredSingleAttemptEgressFetch } from '../egressRequestPolicy.js';
import { hashAccountBinding } from './subscriptionAccountBinding.js';
import { executeOrderedSubscriptionFailover } from './orderedSubscriptionFailover.js';
import {
  GrokCredentialError,
  type GrokCredentialManager,
  type GrokTokenBundle,
} from './grokCredentialManager.js';
import { GrokProtocolError, isRecord, subscriptionHeaders } from './grokProtocol.js';
import {
  classifyGrokResponse,
  grokErrorResponse,
  type GrokRejectedResponse,
} from './grokErrorPolicy.js';
import { normalizeGrokRequest } from './grokRequestNormalization.js';
import type { GrokModelCatalogService } from './grokModelCatalog.js';
import type {
  ProviderContinuationBinding,
  ResponsesTransport,
  ResponsesTransportCapabilities,
  ResponsesTransportExecuteInput,
  ResponsesTransportExecuteResult,
} from './responsesTransport.js';
interface QuotaAttempt {
  result: ResponsesTransportExecuteResult;
  failure: GrokRejectedResponse;
}
export class GrokSubscriptionResponsesTransport implements ResponsesTransport {
  readonly id = 'grok_subscription' as const;
  readonly capabilities: ResponsesTransportCapabilities = {
    responseState: 'stateless',
    terminalOutput: 'canonical',
    usageLookup: false,
    responseDelete: false,
    encryptedReasoning: true,
    omitToolConfigurationWhenEmpty: true,
    parallelToolCalls: true,
    maxOutputTokens: true,
  };
  private readonly fetchImpl: typeof fetch;
  constructor(
    private readonly credentials: GrokCredentialManager,
    fetchImpl: typeof fetch = fetch,
    private readonly catalog?: GrokModelCatalogService,
  ) {
    this.fetchImpl = proxyRequiredSingleAttemptEgressFetch(fetchImpl);
  }
  computePromptCacheKey(_input: {
    model: string;
    messages: ModelChatMessage[];
    tools: ModelToolDefinition[];
    context: RunContext;
  }): undefined {
    return undefined;
  }
  async getContinuationBindingForRequest(input: {
    context: RunContext;
    model: string;
  }): Promise<ProviderContinuationBinding | undefined> {
    for (const ref of this.credentials.getCredentialRefs()) {
      if (!this.credentials.isConfigured(ref) || (await this.credentials.getRuntimeState(ref)))
        continue;
      try {
        return this.binding(await this.credentials.getCredentialsForCredential(ref), input.context);
      } catch (error) {
        if (!(error instanceof GrokCredentialError)) throw error;
        await this.credentials.markAuthUnavailable(ref, error.code, error.credentialGeneration);
      }
    }
    return undefined;
  }
  async execute(input: ResponsesTransportExecuteInput): Promise<ResponsesTransportExecuteResult> {
    let raw: unknown;
    try {
      raw = JSON.parse(input.serializedBody);
    } catch {
      throw new GrokProtocolError('invalid_request_json');
    }
    if (!isRecord(raw) || typeof raw.model !== 'string')
      throw new GrokProtocolError('invalid_request_body');
    const body = raw;
    const model = raw.model;
    let authRetryCount = 0;
    const signal = input.signal ?? input.context.signal;
    return executeOrderedSubscriptionFailover<
      GrokTokenBundle,
      ResponsesTransportExecuteResult,
      QuotaAttempt
    >({
      credentialRefs: this.credentials.getCredentialRefs(),
      signal,
      isConfigured: (ref) => this.credentials.isConfigured(ref),
      getRuntimeState: (ref) => this.credentials.getRuntimeState(ref),
      getCredentials: (ref) => this.credentials.getCredentialsForCredential(ref),
      handleCredentialError: async (ref, error) => {
        if (input.recoveryAttempt || !(error instanceof GrokCredentialError)) return false;
        await this.credentials.markAuthUnavailable(ref, error.code, error.credentialGeneration);
        return true;
      },
      attempt: async (ref, initialToken) => {
        const catalog = await this.catalog?.forAccount(ref, false, signal);
        const knownModel =
          catalog?.status === 'fresh'
            ? catalog.models.find((entry) => entry.id === model)
            : undefined;
        if (catalog?.status === 'fresh' && !knownModel) return { kind: 'ineligible' };
        let token = initialToken;
        const send = async (): Promise<ResponsesTransportExecuteResult> => {
          signal?.throwIfAborted();
          if (!this.credentials.isConfigured(ref))
            throw new GrokProtocolError('subscription_disabled_or_removed', 503);
          const binding = this.binding(token, input.context);
          const reset = !sameBinding(input.expectedContinuationBinding, binding);
          const serializedBody = JSON.stringify(normalizeGrokRequest(body, reset, knownModel));
          const response = await this.fetchImpl(this.credentials.getConfiguration().endpoint, {
            method: 'POST',
            redirect: 'error',
            headers: {
              ...subscriptionHeaders(token.accessToken, model),
              'content-type': 'application/json',
              Accept: 'text/event-stream',
              'x-client-request-id': input.clientRequestId,
            },
            body: serializedBody,
            signal,
          });
          this.credentials.recordWireRequest({
            mode: 'http_sse_full',
            logicalRequestBodyBytes: Buffer.byteLength(input.serializedBody),
            wireRequestBodyBytes: Buffer.byteLength(serializedBody),
          });
          return {
            response,
            continuationBinding: binding,
            continuationReplayReset: reset,
            wireMode: 'http_sse_full',
            wireRequestBodyBytes: Buffer.byteLength(serializedBody),
            authRetryCount,
          };
        };
        let result = await send();
        if (result.response.status === 401 && !input.recoveryAttempt) {
          await result.response.body?.cancel().catch(() => undefined);
          signal?.throwIfAborted();
          try {
            token = await this.credentials.getCredentialsForCredential(ref, true, token.generation);
          } catch (error) {
            if (!(error instanceof GrokCredentialError)) throw error;
            await this.credentials.markAuthUnavailable(ref, error.code, error.credentialGeneration);
            return { kind: 'auth_unavailable' };
          }
          authRetryCount += 1;
          result = await send();
        }
        if (result.response.ok) return { kind: 'result', result };
        const failure = await classifyGrokResponse(result.response);
        result = { ...result, response: grokErrorResponse(failure), authRetryCount };
        if (input.recoveryAttempt) return { kind: 'result', result };
        if (failure.kind === 'quota') {
          const cooldownUntil = await this.credentials.markQuotaCooldown(
            ref,
            failure.code,
            token.generation,
          );
          return { kind: 'quota', quota: { result, failure }, cooldownUntil };
        }
        if (failure.kind === 'auth') {
          await result.response.body?.cancel().catch(() => undefined);
          await this.credentials.markAuthUnavailable(ref, failure.code, token.generation);
          return { kind: 'auth_unavailable' };
        }
        return { kind: 'result', result };
      },
      disposeQuota: async (quota) => {
        await quota?.result.response.body?.cancel().catch(() => undefined);
      },
      finishQuota: async (quota, retryAt) => {
        await quota.result.response.body?.cancel().catch(() => undefined);
        return {
          ...quota.result,
          response: grokErrorResponse(quota.failure, retryAt),
          authRetryCount,
        };
      },
      finishUnavailable: (state) => {
        const disabled = !this.credentials.getConfiguration().enabled;
        const code = disabled
          ? 'grok_subscription_disabled'
          : state.earliestCooldownUntil
            ? 'grok_accounts_cooling_down'
            : state.authUnavailableCount
              ? 'grok_accounts_auth_unavailable'
              : 'grok_model_unavailable';
        const status = disabled
          ? 503
          : state.earliestCooldownUntil
            ? 429
            : state.authUnavailableCount
              ? 401
              : 403;
        return {
          response: grokErrorResponse(
            {
              kind: 'other',
              code,
              status,
              message: '没有可用的 Grok 订阅账号；请检查订阅启停、账号授权、模型资格和冷却状态。',
            },
            state.earliestCooldownUntil,
          ),
          wireMode: 'http_sse_full',
          authRetryCount,
        };
      },
    });
  }
  observeResult(input: Parameters<NonNullable<ResponsesTransport['observeResult']>>[0]): void {
    this.credentials.recordModelResult(input);
  }
  observeFailure(input: { model: string; error: unknown }): void {
    this.credentials.recordModelFailure(input.model, input.error);
  }
  private binding(token: GrokTokenBundle, context: RunContext): ProviderContinuationBinding {
    return {
      provider: 'xai_grok_subscription',
      issuer: this.credentials.getConfiguration().endpoint,
      accountBindingHash: hashAccountBinding(
        JSON.stringify([
          token.accountId,
          token.clientId,
          token.credentialRef,
          context.tenantId ?? '',
          context.sessionId,
        ]),
      ),
    };
  }
}
function sameBinding(
  left: ProviderContinuationBinding | undefined,
  right: ProviderContinuationBinding,
): boolean {
  return (
    left?.provider === right.provider &&
    left.issuer === right.issuer &&
    left.accountBindingHash === right.accountBindingHash
  );
}

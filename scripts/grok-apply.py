from pathlib import Path
import re
root = Path('server/src')
def put(path, text):
    p=root/path; p.parent.mkdir(parents=True,exist_ok=True); p.write_text(text.lstrip('\n'))
def change(path, before, after):
    p=root/path; s=p.read_text(); assert before in s,(path,before); p.write_text(s.replace(before,after,1))
put('runtime/responses/grokModelCatalog.ts', '''import { singleAttemptEgressFetch } from '../egressRequestPolicy.js';
import { GrokCredentialError, type GrokCredentialManager } from './grokCredentialManager.js';
import { GROK_MODELS_ENDPOINT, GrokProtocolError, isRecord, readGrokJson, subscriptionHeaders } from './grokProtocol.js';
export interface GrokCatalogModel {
  id: string; name?: string; contextWindow?: number; maxOutputTokens?: number;
  supportsReasoningEffort?: boolean; inputModalities?: Array<'text' | 'image'>;
  source: 'subscription_catalog';
}
export interface GrokAccountCatalog {
  credentialRef: string; status: 'fresh' | 'stale' | 'unknown'; collectedAt?: string;
  models: GrokCatalogModel[]; error?: string;
}
interface CachedCatalog { value: GrokAccountCatalog; expiresAt: number; generation?: number }
export class GrokModelCatalogService {
  private readonly cache = new Map<string, CachedCatalog>();
  private readonly inFlight = new Map<string, Promise<GrokAccountCatalog>>();
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly credentials: GrokCredentialManager, fetchImpl: typeof fetch = fetch, private readonly now: () => number = Date.now) {
    this.fetchImpl = singleAttemptEgressFetch(fetchImpl);
  }
  invalidate(): void { this.cache.clear(); }
  async forAccount(ref: string, force = false, signal?: AbortSignal): Promise<GrokAccountCatalog> {
    const cached = this.cache.get(ref); const generation = await this.credentials.getRuntimeGeneration(ref);
    if (!force && cached && cached.expiresAt > this.now() && cached.generation === generation) return cached.value;
    const active = this.inFlight.get(ref); if (active) return active;
    const promise = this.load(ref, cached, signal).finally(() => { if (this.inFlight.get(ref) === promise) this.inFlight.delete(ref); });
    this.inFlight.set(ref, promise); return promise;
  }
  async list(force = false) {
    const refs = this.credentials.getCredentialRefs();
    for (const ref of this.cache.keys()) if (!refs.includes(ref)) this.cache.delete(ref);
    const accounts = await Promise.all(refs.map(async (ref, index) => ({ ...await this.forAccount(ref, force), priority: index + 1 })));
    const union = new Map<string, { id: string; name?: string; eligibleCredentialRefs: string[] }>();
    for (const account of accounts) for (const model of account.models) {
      const entry = union.get(model.id) ?? { id: model.id, name: model.name, eligibleCredentialRefs: [] };
      if (account.status === 'fresh') entry.eligibleCredentialRefs.push(account.credentialRef);
      union.set(model.id, entry);
    }
    return { accounts, models: [...union.values()], source: 'subscription_catalog' as const };
  }
  private async load(ref: string, cached?: CachedCatalog, signal?: AbortSignal): Promise<GrokAccountCatalog> {
    try {
      const token = await this.credentials.getCredentialsForCredential(ref);
      signal?.throwIfAborted();
      if (!this.credentials.isConfigured(ref)) throw new GrokProtocolError('subscription_disabled_or_removed');
      const response = await this.fetchImpl(GROK_MODELS_ENDPOINT, { redirect: 'error', headers: subscriptionHeaders(token.accessToken),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
      if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new GrokProtocolError('catalog_unavailable', response.status); }
      const models = parseGrokCatalog(await readGrokJson(response, 1024 * 1024));
      const value: GrokAccountCatalog = { credentialRef: ref, status: 'fresh', collectedAt: new Date(this.now()).toISOString(), models };
      if (this.credentials.getCredentialRefs().includes(ref)) this.cache.set(ref, { value, generation: token.generation, expiresAt: this.now() + 60_000 });
      return value;
    } catch (error) {
      signal?.throwIfAborted();
      const value: GrokAccountCatalog = { credentialRef: ref, status: cached ? 'stale' : 'unknown', models: cached?.value.models ?? [],
        collectedAt: cached?.value.collectedAt, error: error instanceof GrokProtocolError || error instanceof GrokCredentialError ? error.code : 'catalog_unavailable' };
      if (this.credentials.getCredentialRefs().includes(ref)) this.cache.set(ref, { value, generation: cached?.generation, expiresAt: this.now() + 10_000 });
      return value;
    }
  }
}
/** Missing capabilities remain unknown: the Console/API-key catalog is never substituted. */
export function parseGrokCatalog(raw: unknown): GrokCatalogModel[] {
  const rows = Array.isArray(raw) ? raw : isRecord(raw) ? raw.data ?? raw.models : undefined;
  if (!Array.isArray(rows) || rows.length > 1000) throw new GrokProtocolError('invalid_model_catalog');
  const models = new Map<string, GrokCatalogModel>();
  for (const row of rows) {
    if (!isRecord(row)) throw new GrokProtocolError('invalid_model_catalog');
    const id = row.id ?? row.model;
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(id)) throw new GrokProtocolError('invalid_catalog_model_id');
    const backend = row.api_backend ?? row.apiBackend ?? row.backend;
    if (typeof backend === 'string' && /^(embedding|embeddings|image|video|audio|speech|tts|stt)$/i.test(backend)) continue;
    const contextWindow = positiveLimit(row.context_window ?? row.contextWindow);
    const maxOutputTokens = positiveLimit(row.max_completion_tokens ?? row.maxCompletionTokens ?? row.max_output_tokens);
    const reasoning = row.supports_reasoning_effort ?? row.supportsReasoningEffort;
    const modalities = row.input_modalities ?? row.inputModalities ?? row.input;
    const inputModalities = Array.isArray(modalities) && modalities.every((item) => item === 'text' || item === 'image')
      ? modalities as Array<'text' | 'image'> : undefined;
    models.set(id, { id, source: 'subscription_catalog',
      ...(typeof row.name === 'string' && row.name.length <= 200 && !/[\\r\\n\\u0000]/.test(row.name) ? { name: row.name } : {}),
      ...(contextWindow ? { contextWindow } : {}), ...(maxOutputTokens ? { maxOutputTokens } : {}),
      ...(typeof reasoning === 'boolean' ? { supportsReasoningEffort: reasoning } : {}), ...(inputModalities ? { inputModalities } : {}) });
  }
  return [...models.values()];
}
function positiveLimit(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 50_000_000 ? value : undefined;
}
''')
put('runtime/responses/grokRequestNormalization.ts', '''import { GrokProtocolError, isRecord } from './grokProtocol.js';
import type { GrokCatalogModel } from './grokModelCatalog.js';
/** Full-history replay retains executed function results; only provider-owned anchors are removed. */
export function normalizeGrokRequest(raw: Record<string, unknown>, resetBinding: boolean, model?: GrokCatalogModel): Record<string, unknown> {
  if (typeof raw.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(raw.model)) throw new GrokProtocolError('invalid_model_id');
  if (!Array.isArray(raw.input)) throw new GrokProtocolError('full_history_required');
  const body: Record<string, unknown> = { ...raw, store: false, stream: true };
  for (const key of ['previous_response_id', 'prompt_cache_key', 'originator', 'thinking', 'reasoning_effort']) delete body[key];
  // The common adapter's Codex verbosity preference is not part of the subscription contract.
  if (isRecord(body.text)) { const { verbosity: _verbosity, ...text } = body.text; if (Object.keys(text).length) body.text = text; else delete body.text; }
  if (isRecord(body.reasoning)) {
    if (body.reasoning.effort !== undefined) {
      if (model?.supportsReasoningEffort !== true) throw new GrokProtocolError('reasoning_effort_capability_unverified');
      body.reasoning = { effort: body.reasoning.effort };
    } else delete body.reasoning;
  }
  body.include = ['reasoning.encrypted_content'];
  const tools = flattenFunctions(Array.isArray(raw.tools) ? raw.tools : []);
  if (tools.length) body.tools = tools;
  else { delete body.tools; delete body.tool_choice; delete body.parallel_tool_calls; }
  const imagesAllowed = model?.inputModalities?.includes('image') === true;
  body.input = raw.input.flatMap((item: unknown) => {
    if (!isRecord(item)) throw new GrokProtocolError('invalid_history_item');
    if (item.type === 'additional_tools') return [];
    if (item.type === 'reasoning') return resetBinding ? [] : [item];
    const { namespace: _namespace, ...normalized } = item;
    if (Array.isArray(normalized.content) && normalized.content.some((part) => isRecord(part) && part.type === 'input_image') && !imagesAllowed) throw new GrokProtocolError('image_capability_unverified');
    if (normalized.type === 'function_call_output' && Array.isArray(normalized.output)) {
      if (normalized.output.some((part) => !isRecord(part) || part.type !== 'input_text')) throw new GrokProtocolError('unsupported_tool_result_media');
      normalized.output = normalized.output.map((part) => String((part as Record<string, unknown>).text ?? '')).join('');
    }
    return [normalized];
  });
  return body;
}
function flattenFunctions(tools: unknown[]): Array<Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  const visit = (tool: unknown) => {
    if (!isRecord(tool)) throw new GrokProtocolError('invalid_function_schema');
    if (tool.type === 'tool_search') return;
    if (tool.type === 'namespace' && Array.isArray(tool.tools)) { tool.tools.forEach(visit); return; }
    if (tool.type !== 'function' || typeof tool.name !== 'string') throw new GrokProtocolError('unsupported_server_tool');
    const { defer_loading: _defer, namespace: _namespace, ...flat } = tool;
    const previous = result.get(tool.name);
    if (previous && JSON.stringify(previous) !== JSON.stringify(flat)) throw new GrokProtocolError('ambiguous_function_name');
    result.set(tool.name, flat);
  };
  tools.forEach(visit); return [...result.values()];
}
''')
put('runtime/responses/grokErrorPolicy.ts', '''import { isRecord, readGrokJson } from './grokProtocol.js';
export interface GrokRejectedResponse { kind: 'quota' | 'auth' | 'other'; code: string; message: string; status: number; retryAfter?: string }
/** Provider-specific evidence: OpenClaw xAI billing/rate-limit classifier, not Codex text matching. */
export async function classifyGrokResponse(response: Response): Promise<GrokRejectedResponse> {
  let message = '';
  try {
    const raw = await readGrokJson(response);
    const error = isRecord(raw) && isRecord(raw.error) ? raw.error : raw;
    if (isRecord(error) && typeof error.message === 'string') message = error.message;
  } catch { /* HTML/challenges/malformed responses never become quota or permanent authorization. */ }
  const retryAfter = safeRetryAfter(response.headers.get('retry-after'));
  if (response.status === 401) return { kind: 'auth', code: 'grok_access_token_rejected', message: 'Grok 订阅凭据被拒绝，请重新授权。', status: 401 };
  const ordinaryRateLimit = /\\b(?:rate limit exceeded|too many requests)\\b/i.test(message);
  const exhausted = /\\b(?:used all available credits|run out of credits|monthly spending limit|purchase more credits|raise your spending limit)\\b/i.test(message);
  if ([400, 402, 403, 429].includes(response.status) && exhausted && !ordinaryRateLimit) {
    return { kind: 'quota', code: 'grok_subscription_quota_exhausted', message: 'Grok 订阅额度耗尽，账号已进入额度冷却。', status: 429, retryAfter };
  }
  const code = response.status === 429 ? 'grok_rate_limited' : response.status === 403 ? 'grok_access_forbidden' : response.status >= 500 ? 'grok_upstream_unavailable' : 'grok_request_rejected';
  return { kind: 'other', code, status: response.status, retryAfter,
    message: response.status === 429 ? 'Grok 请求受到上游限流；未将普通限流当作套餐耗尽，也未轮换账号规避限制。' : 'Grok 订阅请求未被接受；请检查模型资格、服务状态或授权链路。' };
}
export function grokErrorResponse(failure: GrokRejectedResponse, retryAt?: string): Response {
  const retryAfter = retryAt ? String(Math.max(0, Math.ceil((Date.parse(retryAt) - Date.now()) / 1000))) : failure.retryAfter;
  return new Response(JSON.stringify({ error: { code: failure.code, message: failure.message, ...(retryAt ? { retryAt } : {}) } }), {
    status: failure.status, headers: { 'content-type': 'application/json', ...(retryAfter ? { 'retry-after': retryAfter } : {}) },
  });
}
function safeRetryAfter(value: string | null): string | undefined {
  if (!value || value.length > 64) return undefined;
  if (/^\\d{1,6}$/.test(value)) return value;
  return /^[A-Za-z]{3}, [\\d A-Za-z:]+ GMT$/.test(value) && Number.isFinite(Date.parse(value)) ? value : undefined;
}
''')
put('runtime/responses/grokSubscriptionResponsesTransport.ts', '''import type { ModelChatMessage, ModelToolDefinition, RunContext } from '../types.js';
import { singleAttemptEgressFetch } from '../egressRequestPolicy.js';
import { hashAccountBinding } from './subscriptionAccountBinding.js';
import { executeOrderedSubscriptionFailover } from './orderedSubscriptionFailover.js';
import { GrokCredentialError, type GrokCredentialManager, type GrokTokenBundle } from './grokCredentialManager.js';
import { GrokProtocolError, isRecord, subscriptionHeaders } from './grokProtocol.js';
import { classifyGrokResponse, grokErrorResponse, type GrokRejectedResponse } from './grokErrorPolicy.js';
import { normalizeGrokRequest } from './grokRequestNormalization.js';
import type { GrokModelCatalogService } from './grokModelCatalog.js';
import type { ProviderContinuationBinding, ResponsesTransport, ResponsesTransportCapabilities, ResponsesTransportExecuteInput, ResponsesTransportExecuteResult } from './responsesTransport.js';
interface QuotaAttempt { result: ResponsesTransportExecuteResult; failure: GrokRejectedResponse }
export class GrokSubscriptionResponsesTransport implements ResponsesTransport {
  readonly id = 'grok_subscription' as const;
  readonly capabilities: ResponsesTransportCapabilities = {
    responseState: 'stateless', terminalOutput: 'canonical', usageLookup: false, responseDelete: false,
    encryptedReasoning: true, omitToolConfigurationWhenEmpty: true, parallelToolCalls: true, maxOutputTokens: true,
  };
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly credentials: GrokCredentialManager, fetchImpl: typeof fetch = fetch, private readonly catalog?: GrokModelCatalogService) {
    this.fetchImpl = singleAttemptEgressFetch(fetchImpl);
  }
  computePromptCacheKey(_input: { model: string; messages: ModelChatMessage[]; tools: ModelToolDefinition[]; context: RunContext }): undefined { return undefined; }
  async getContinuationBindingForRequest(input: { context: RunContext; model: string }): Promise<ProviderContinuationBinding | undefined> {
    for (const ref of this.credentials.getCredentialRefs()) {
      if (!this.credentials.isConfigured(ref) || await this.credentials.getRuntimeState(ref)) continue;
      try { return this.binding(await this.credentials.getCredentialsForCredential(ref), input.context); }
      catch (error) {
        if (!(error instanceof GrokCredentialError)) throw error;
        await this.credentials.markAuthUnavailable(ref, error.code, error.credentialGeneration);
      }
    }
    return undefined;
  }
  async execute(input: ResponsesTransportExecuteInput): Promise<ResponsesTransportExecuteResult> {
    let raw: unknown;
    try { raw = JSON.parse(input.serializedBody); } catch { throw new GrokProtocolError('invalid_request_json'); }
    if (!isRecord(raw) || typeof raw.model !== 'string') throw new GrokProtocolError('invalid_request_body');
    const body = raw; const model = raw.model; let authRetryCount = 0;
    const signal = input.signal ?? input.context.signal;
    return executeOrderedSubscriptionFailover<GrokTokenBundle, ResponsesTransportExecuteResult, QuotaAttempt>({
      credentialRefs: this.credentials.getCredentialRefs(), signal, isConfigured: (ref) => this.credentials.isConfigured(ref),
      getRuntimeState: (ref) => this.credentials.getRuntimeState(ref),
      getCredentials: (ref) => this.credentials.getCredentialsForCredential(ref),
      handleCredentialError: async (ref, error) => {
        if (input.recoveryAttempt || !(error instanceof GrokCredentialError)) return false;
        await this.credentials.markAuthUnavailable(ref, error.code, error.credentialGeneration); return true;
      },
      attempt: async (ref, initialToken) => {
        const catalog = await this.catalog?.forAccount(ref, false, signal);
        const knownModel = catalog?.status === 'fresh' ? catalog.models.find((entry) => entry.id === model) : undefined;
        if (catalog?.status === 'fresh' && !knownModel) return { kind: 'ineligible' };
        let token = initialToken;
        const send = async (): Promise<ResponsesTransportExecuteResult> => {
          signal?.throwIfAborted();
          if (!this.credentials.isConfigured(ref)) throw new GrokProtocolError('subscription_disabled_or_removed', 503);
          const binding = this.binding(token, input.context);
          const reset = !sameBinding(input.expectedContinuationBinding, binding);
          const serializedBody = JSON.stringify(normalizeGrokRequest(body, reset, knownModel));
          const response = await this.fetchImpl(this.credentials.getConfiguration().endpoint, {
            method: 'POST', redirect: 'error', headers: { ...subscriptionHeaders(token.accessToken, model),
              'content-type': 'application/json', Accept: 'text/event-stream', 'x-client-request-id': input.clientRequestId }, body: serializedBody, signal,
          });
          this.credentials.recordWireRequest({ mode: 'http_sse_full', logicalRequestBodyBytes: Buffer.byteLength(input.serializedBody), wireRequestBodyBytes: Buffer.byteLength(serializedBody) });
          return { response, continuationBinding: binding, continuationReplayReset: reset, wireMode: 'http_sse_full',
            wireRequestBodyBytes: Buffer.byteLength(serializedBody), authRetryCount };
        };
        let result = await send();
        if (result.response.status === 401 && !input.recoveryAttempt) {
          await result.response.body?.cancel().catch(() => undefined); signal?.throwIfAborted();
          try { token = await this.credentials.getCredentialsForCredential(ref, true, token.generation); }
          catch (error) {
            if (!(error instanceof GrokCredentialError)) throw error;
            await this.credentials.markAuthUnavailable(ref, error.code, error.credentialGeneration); return { kind: 'auth_unavailable' };
          }
          authRetryCount += 1; result = await send();
        }
        if (result.response.ok) return { kind: 'result', result };
        const failure = await classifyGrokResponse(result.response);
        result = { ...result, response: grokErrorResponse(failure), authRetryCount };
        if (input.recoveryAttempt) return { kind: 'result', result };
        if (failure.kind === 'quota') {
          const cooldownUntil = await this.credentials.markQuotaCooldown(ref, failure.code, token.generation);
          return { kind: 'quota', quota: { result, failure }, cooldownUntil };
        }
        if (failure.kind === 'auth') {
          await result.response.body?.cancel().catch(() => undefined);
          await this.credentials.markAuthUnavailable(ref, failure.code, token.generation); return { kind: 'auth_unavailable' };
        }
        return { kind: 'result', result };
      },
      disposeQuota: async (quota) => { await quota?.result.response.body?.cancel().catch(() => undefined); },
      finishQuota: async (quota, retryAt) => {
        await quota.result.response.body?.cancel().catch(() => undefined);
        return { ...quota.result, response: grokErrorResponse(quota.failure, retryAt), authRetryCount };
      },
      finishUnavailable: (state) => {
        const disabled = !this.credentials.getConfiguration().enabled;
        const code = disabled ? 'grok_subscription_disabled' : state.earliestCooldownUntil ? 'grok_accounts_cooling_down'
          : state.authUnavailableCount ? 'grok_accounts_auth_unavailable' : 'grok_model_unavailable';
        const status = disabled ? 503 : state.earliestCooldownUntil ? 429 : state.authUnavailableCount ? 401 : 403;
        return { response: grokErrorResponse({ kind: 'other', code, status,
          message: '没有可用的 Grok 订阅账号；请检查订阅启停、账号授权、模型资格和冷却状态。' }, state.earliestCooldownUntil), wireMode: 'http_sse_full', authRetryCount };
      },
    });
  }
  observeResult(input: Parameters<NonNullable<ResponsesTransport['observeResult']>>[0]): void { this.credentials.recordModelResult(input); }
  observeFailure(input: { model: string; error: unknown }): void { this.credentials.recordModelFailure(input.model, input.error); }
  private binding(token: GrokTokenBundle, context: RunContext): ProviderContinuationBinding {
    return { provider: 'xai_grok_subscription', issuer: this.credentials.getConfiguration().endpoint,
      accountBindingHash: hashAccountBinding(JSON.stringify([token.accountId, token.clientId, token.credentialRef, context.tenantId ?? '', context.sessionId])) };
  }
}
function sameBinding(left: ProviderContinuationBinding | undefined, right: ProviderContinuationBinding): boolean {
  return left?.provider === right.provider && left.issuer === right.issuer && left.accountBindingHash === right.accountBindingHash;
}
''')
put('runtime/subscriptionModelAuthentication.ts', '''/** Server-resolved model options only; this does not grant model visibility or runtime permissions. */
export function isSubscriptionTransport(transport: unknown): transport is 'codex_subscription' | 'grok_subscription' {
  return transport === 'codex_subscription' || transport === 'grok_subscription';
}
export function modelRequiresApiKey(options: { responsesTransport?: string } | undefined): boolean {
  return !isSubscriptionTransport(options?.responsesTransport);
}
''')
for path in ['runtime/responses/responsesTransport.ts', 'types/index.ts']:
    p=root/path; s=p.read_text(); assert "'openai_compatible' | 'codex_subscription'" in s
    p.write_text(s.replace("'openai_compatible' | 'codex_subscription'", "'openai_compatible' | 'codex_subscription' | 'grok_subscription'"))
for path in ['runtime/responses/responsesTransport.ts','runtime/types.ts']:
    change(path, "provider: 'openai_codex_subscription';", "provider: 'openai_codex_subscription' | 'xai_grok_subscription';")
change('runtime/responses/responsesTransport.ts', '  getContinuationBinding?(): Promise<ProviderContinuationBinding>;', '  getContinuationBinding?(): Promise<ProviderContinuationBinding>;\n  getContinuationBindingForRequest?(input: { context: RunContext; model: string }): Promise<ProviderContinuationBinding | undefined>;')
put('runtime/responses/resolveContinuationBinding.ts', '''import type { RunContext } from '../types.js';
import type { ResponsesTransport } from './responsesTransport.js';
export function resolveContinuationBinding(transport: ResponsesTransport, context: RunContext, model: string) {
  return transport.getContinuationBindingForRequest
    ? transport.getContinuationBindingForRequest({ context, model })
    : transport.getContinuationBinding?.();
}
''')
p=root/'runtime/responsesApiAdapter.ts'; s=p.read_text()
s="import { resolveContinuationBinding } from './responses/resolveContinuationBinding.js';\n"+s
assert 'await this.transport.getContinuationBinding?.()' in s
s=s.replace('await this.transport.getContinuationBinding?.()', 'await resolveContinuationBinding(this.transport, context, request.model)', 1)
# xAI emits the Responses reasoning-text delta spelling as well as summary deltas.
if "case 'response.reasoning_summary_text.delta':" in s: s=s.replace("case 'response.reasoning_summary_text.delta':", "case 'response.reasoning_text.delta':\n        case 'response.reasoning_summary_text.delta':",1)
p.write_text(s)
# Extract the already-public factory; retain the original import/export location as a compatibility facade.
p=root/'runtime/rawRuntimeRunDispatch.ts'; s=p.read_text(); a=s.index('export function createModelAdapterForProtocol('); b=s.index('/**\n * Skills wiring',a)
factory=s[a:b]; factory=factory[:factory.index('function modelRequiresApiKey(')]
needle="  if (modelProviderOptions?.protocol === 'responses') {"; assert needle in factory
factory=factory.replace(needle, needle+'''
    if (modelProviderOptions.responsesTransport === 'grok_subscription') {
      if (!dependencies.grokCredentialManager) throw new Error('Grok subscription transport 缺少 GrokCredentialManager');
      return new ResponsesApiAdapter({ apiKey: '', baseUrl: GROK_SUBSCRIPTION_BASE_URL },
        { ...modelProviderOptions, disableResponseChaining: true, disablePromptCacheKey: true },
        new GrokSubscriptionResponsesTransport(dependencies.grokCredentialManager, dependencies.grokFetch, dependencies.grokModelCatalog));
    }
''',1)
put('runtime/modelAdapterFactory.ts', '''import type { ModelProviderOptions } from '../types/index.js';
import type { ModelAdapter } from './types.js';
import type { ModelAdapterFactoryDependencies } from './rawRuntimeRunDispatchTypes.js';
import { ResponsesApiAdapter } from './responsesApiAdapter.js';
import { ChatCompletionsModelAdapter } from './chatCompletionsAdapter.js';
import { CodexSubscriptionResponsesTransport } from './responses/codexSubscriptionResponsesTransport.js';
import { GrokSubscriptionResponsesTransport } from './responses/grokSubscriptionResponsesTransport.js';
import { GROK_SUBSCRIPTION_BASE_URL } from './responses/grokProtocol.js';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
''' + factory)
s=s[:a]+s[b:]
s="import { createModelAdapterForProtocol } from './modelAdapterFactory.js';\nexport { createModelAdapterForProtocol } from './modelAdapterFactory.js';\nimport { modelRequiresApiKey } from './subscriptionModelAuthentication.js';\n"+s
for name in ['ResponsesApiAdapter','CodexSubscriptionResponsesTransport','ChatCompletionsModelAdapter']:
    if len(re.findall(r'\b'+name+r'\b',s))==1: s=re.sub(r"import \{ "+name+r" \} from '[^']+';\n",'',s)
p.write_text(s)
p=root/'runtime/rawRuntimeRunDispatchTypes.ts'; s=p.read_text(); s="import type { GrokCredentialManager } from './responses/grokCredentialManager.js';\nimport type { GrokModelCatalogService } from './responses/grokModelCatalog.js';\n"+s
s=s.replace('export interface ModelAdapterFactoryDependencies {', 'export interface ModelAdapterFactoryDependencies {\n  grokCredentialManager?: GrokCredentialManager;\n  grokFetch?: typeof fetch;\n  grokModelCatalog?: GrokModelCatalogService;',1);p.write_text(s)
put('app/grokSubscriptionConfigSchema.ts', '''import { z } from 'zod';
import { GROK_RESPONSES_ENDPOINT } from '../runtime/responses/grokProtocol.js';
const credentialRef = z.string().min(1).max(512).regex(/^[^\\s\\u0000-\\u001f\\u007f]+$/);
export const grokSubscriptionConfigSchema = z.object({
  enabled: z.boolean().default(false), quotaCooldownMinutes: z.number().int().min(1).max(10_080).default(60),
  credentialRef: credentialRef.optional(), credentialRefs: z.array(credentialRef).min(1).max(100).optional(),
  endpoint: z.literal(GROK_RESPONSES_ENDPOINT).optional(),
  oauthClientId: z.string().min(1).max(256).regex(/^[A-Za-z0-9._-]+$/).optional(),
}).strict().superRefine((config, ctx) => {
  const refs = config.credentialRefs ?? (config.credentialRef ? [config.credentialRef] : []);
  if (config.enabled && refs.length === 0) ctx.addIssue({ code: 'custom', path: ['enabled'], message: '启用 Grok 订阅前必须登记账号' });
  if (new Set(refs).size !== refs.length) ctx.addIssue({ code: 'custom', path: ['credentialRefs'], message: 'Grok 账号列表不能重复' });
  if (config.credentialRef && config.credentialRefs && config.credentialRef !== config.credentialRefs[0]) ctx.addIssue({ code: 'custom', path: ['credentialRef'], message: 'Grok 首账号别名必须与优先级列表一致' });
});
''')
p=root/'app/config.ts';s=p.read_text();s="import { grokSubscriptionConfigSchema } from './grokSubscriptionConfigSchema.js';\n"+s
assert "z.enum(['openai_compatible', 'codex_subscription'])" in s
s=s.replace("z.enum(['openai_compatible', 'codex_subscription'])", "z.enum(['openai_compatible', 'codex_subscription', 'grok_subscription'])")
s=s.replace('  codexSubscription: codexSubscriptionConfigSchema.optional(),','  codexSubscription: codexSubscriptionConfigSchema.optional(),\n  grokSubscription: grokSubscriptionConfigSchema.optional(),',1)
s=s.replace('export type CodexSubscriptionConfig =', 'export type GrokSubscriptionConfig = z.infer<typeof grokSubscriptionConfigSchema>;\nexport type CodexSubscriptionConfig =',1)
# Same validation algorithm, independent provider configuration roots.
s=s.replace("      if (transport !== 'codex_subscription') continue;", "      if (transport !== 'codex_subscription' && transport !== 'grok_subscription') continue;\n      const subscriptionRoot = transport === 'grok_subscription' ? 'grokSubscription' : 'codexSubscription';",1)
s=s.replace("message: 'codex_subscription 只能用于 protocol=\"responses\"',", "message: `${transport} 只能用于 protocol=\"responses\"`,",1)
s=s.replace('      if (!value.codexSubscription) {','      if (!value[subscriptionRoot]) {',1)
s=s.replace("path: ['codexSubscription'],\n          message: '存在 codex_subscription 模型时必须配置 codexSubscription',", "path: [subscriptionRoot],\n          message: `存在 ${transport} 模型时必须配置 ${subscriptionRoot}`,",1)
p.write_text(s)
# Audit the remaining provider-specific branches for the next integration work package.
for area in ['runtime','app','agent','release','config']:
    for p in (root/area).rglob('*.ts'):
        if '/__tests__/' in str(p) or 'codex' in p.name.lower() or 'grok' in p.name.lower(): continue
        for n,line in enumerate(p.read_text().splitlines(),1):
            if any(term in line for term in ['codex_subscription','codexSubscription','coordinateCredentialRotation','credentialVersionDigest']):
                print(f'AUDIT {p}:{n}: {line.strip()}')
print('Applied native Grok HTTP/SSE transport, authenticated catalog, provider binding and refs-only schema')

import { singleAttemptEgressFetch } from '../egressRequestPolicy.js';
import { GrokCredentialError, type GrokCredentialManager } from './grokCredentialManager.js';
import {
  GROK_MODELS_ENDPOINT,
  GrokProtocolError,
  isRecord,
  readGrokJson,
  subscriptionHeaders,
} from './grokProtocol.js';
export interface GrokCatalogModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsReasoningEffort?: boolean;
  inputModalities?: Array<'text' | 'image'>;
  source: 'subscription_catalog';
}
export interface GrokAccountCatalog {
  credentialRef: string;
  status: 'fresh' | 'stale' | 'unknown';
  collectedAt?: string;
  models: GrokCatalogModel[];
  error?: string;
}
interface CachedCatalog {
  value: GrokAccountCatalog;
  expiresAt: number;
  generation?: number;
}
export class GrokModelCatalogService {
  private readonly cache = new Map<string, CachedCatalog>();
  private readonly inFlight = new Map<string, Promise<GrokAccountCatalog>>();
  private readonly fetchImpl: typeof fetch;
  constructor(
    private readonly credentials: GrokCredentialManager,
    fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    this.fetchImpl = singleAttemptEgressFetch(fetchImpl);
  }
  invalidate(): void {
    this.cache.clear();
  }
  async forAccount(ref: string, force = false, signal?: AbortSignal): Promise<GrokAccountCatalog> {
    const cached = this.cache.get(ref);
    const generation = await this.credentials.getRuntimeGeneration(ref);
    if (!force && cached && cached.expiresAt > this.now() && cached.generation === generation)
      return cached.value;
    const active = this.inFlight.get(ref);
    if (active) return active;
    const promise = this.load(ref, cached, signal).finally(() => {
      if (this.inFlight.get(ref) === promise) this.inFlight.delete(ref);
    });
    this.inFlight.set(ref, promise);
    return promise;
  }
  async list(force = false) {
    const refs = this.credentials.getCredentialRefs();
    for (const ref of this.cache.keys()) if (!refs.includes(ref)) this.cache.delete(ref);
    const accounts = await Promise.all(
      refs.map(async (ref, index) => ({
        ...(await this.forAccount(ref, force)),
        priority: index + 1,
      })),
    );
    const union = new Map<
      string,
      { id: string; name?: string; eligibleCredentialRefs: string[] }
    >();
    for (const account of accounts)
      for (const model of account.models) {
        const entry = union.get(model.id) ?? {
          id: model.id,
          name: model.name,
          eligibleCredentialRefs: [],
        };
        if (account.status === 'fresh') entry.eligibleCredentialRefs.push(account.credentialRef);
        union.set(model.id, entry);
      }
    return { accounts, models: [...union.values()], source: 'subscription_catalog' as const };
  }
  private async load(
    ref: string,
    cached?: CachedCatalog,
    signal?: AbortSignal,
  ): Promise<GrokAccountCatalog> {
    try {
      const token = await this.credentials.getCredentialsForCredential(ref);
      signal?.throwIfAborted();
      if (!this.credentials.isConfigured(ref))
        throw new GrokProtocolError('subscription_disabled_or_removed');
      const response = await this.fetchImpl(GROK_MODELS_ENDPOINT, {
        redirect: 'error',
        headers: subscriptionHeaders(token.accessToken),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
          : AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new GrokProtocolError('catalog_unavailable', response.status);
      }
      const models = parseGrokCatalog(await readGrokJson(response, 1024 * 1024));
      const value: GrokAccountCatalog = {
        credentialRef: ref,
        status: 'fresh',
        collectedAt: new Date(this.now()).toISOString(),
        models,
      };
      if (this.credentials.getCredentialRefs().includes(ref))
        this.cache.set(ref, {
          value,
          generation: token.generation,
          expiresAt: this.now() + 60_000,
        });
      return value;
    } catch (error) {
      signal?.throwIfAborted();
      const value: GrokAccountCatalog = {
        credentialRef: ref,
        status: cached ? 'stale' : 'unknown',
        models: cached?.value.models ?? [],
        collectedAt: cached?.value.collectedAt,
        error:
          error instanceof GrokProtocolError || error instanceof GrokCredentialError
            ? error.code
            : 'catalog_unavailable',
      };
      if (this.credentials.getCredentialRefs().includes(ref))
        this.cache.set(ref, {
          value,
          generation: cached?.generation,
          expiresAt: this.now() + 10_000,
        });
      return value;
    }
  }
}
/** Missing capabilities remain unknown: the Console/API-key catalog is never substituted. */
export function parseGrokCatalog(raw: unknown): GrokCatalogModel[] {
  const rows = Array.isArray(raw) ? raw : isRecord(raw) ? (raw.data ?? raw.models) : undefined;
  if (!Array.isArray(rows) || rows.length > 1000)
    throw new GrokProtocolError('invalid_model_catalog');
  const models = new Map<string, GrokCatalogModel>();
  for (const row of rows) {
    if (!isRecord(row)) throw new GrokProtocolError('invalid_model_catalog');
    const id = row.id ?? row.model;
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(id))
      throw new GrokProtocolError('invalid_catalog_model_id');
    const backend = row.api_backend ?? row.apiBackend ?? row.backend;
    if (
      typeof backend === 'string' &&
      /^(embedding|embeddings|image|video|audio|speech|tts|stt)$/i.test(backend)
    )
      continue;
    const contextWindow = positiveLimit(row.context_window ?? row.contextWindow);
    const maxOutputTokens = positiveLimit(
      row.max_completion_tokens ?? row.maxCompletionTokens ?? row.max_output_tokens,
    );
    const reasoning = row.supports_reasoning_effort ?? row.supportsReasoningEffort;
    const modalities = row.input_modalities ?? row.inputModalities ?? row.input;
    const inputModalities =
      Array.isArray(modalities) && modalities.every((item) => item === 'text' || item === 'image')
        ? (modalities as Array<'text' | 'image'>)
        : undefined;
    models.set(id, {
      id,
      source: 'subscription_catalog',
      ...(typeof row.name === 'string' && row.name.length <= 200 && !/[\r\n\u0000]/.test(row.name)
        ? { name: row.name }
        : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
      ...(typeof reasoning === 'boolean' ? { supportsReasoningEffort: reasoning } : {}),
      ...(inputModalities ? { inputModalities } : {}),
    });
  }
  return [...models.values()];
}
function positiveLimit(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 50_000_000
    ? value
    : undefined;
}

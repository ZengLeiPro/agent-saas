import type { SubscriptionCredentialRotationTransaction } from './subscriptionCredentialRotation.js';
import type { SecretVault } from '../../security/secretVault.js';
import { hashAccountBinding, orderedCredentialRefs } from './subscriptionAccountBinding.js';
import {
  LocalSubscriptionCredentialLock,
  type SubscriptionCredentialLock,
} from './subscriptionCredentialLock.js';
import {
  InMemorySubscriptionCredentialRuntimeStateStore,
  type SubscriptionCredentialRuntimeStateStore,
} from './subscriptionCredentialRuntimeState.js';
import {
  InMemorySubscriptionRefreshJournal,
  type SubscriptionRefreshJournal,
} from './subscriptionRefreshJournal.js';
import {
  SubscriptionTelemetry,
  type SubscriptionWireRequestSample,
} from './subscriptionTelemetry.js';
import { GrokOAuthClient, type GrokOAuthTokens } from './grokOAuthClient.js';
import {
  GROK_OAUTH_CLIENT_ID,
  GROK_RESPONSES_ENDPOINT,
  GrokProtocolError,
  isPermanentGrokGrantRejection,
  isTransientGrokRefreshCode,
  isTransientGrokRefreshError,
  validateGrokEndpoint,
} from './grokProtocol.js';
import { GrokCredentialRepository } from './grokCredentialRepository.js';
import {
  GrokCredentialError,
  type GrokCredentialStatus,
  type GrokSubscriptionRuntimeConfig,
  type GrokTokenBundle,
} from './grokCredentialTypes.js';
export {
  GrokCredentialError,
  type GrokCredentialStatus,
  type GrokSubscriptionRuntimeConfig,
  type GrokTokenBundle,
} from './grokCredentialTypes.js';
/** 提前 10 分钟刷新：即使一次刷新失败，采集器与会话在令牌真正到期前仍有多次重试机会。 */
const REFRESH_LEAD_MS = 600_000;
export class GrokCredentialManager {
  private readonly repository: GrokCredentialRepository;
  private readonly lock: SubscriptionCredentialLock;
  private readonly state: SubscriptionCredentialRuntimeStateStore;
  private readonly journal: SubscriptionRefreshJournal;
  private readonly oauth: GrokOAuthClient;
  private readonly telemetry = new SubscriptionTelemetry();
  private readonly inFlight = new Map<string, Promise<GrokTokenBundle>>();
  private coordinator?: (ref: string) => Promise<void>;
  private rotationTransaction?: SubscriptionCredentialRotationTransaction;
  constructor(
    private readonly options: {
      vault: SecretVault;
      getConfig: () => GrokSubscriptionRuntimeConfig | undefined;
      lock?: SubscriptionCredentialLock;
      runtimeStateStore?: SubscriptionCredentialRuntimeStateStore;
      refreshJournal?: SubscriptionRefreshJournal;
      oauthClient?: GrokOAuthClient;
      fetchImpl?: typeof fetch;
      credentialRotationCoordinator?: (ref: string) => Promise<void>;
      requireRotationCoordinator?: boolean;
      now?: () => number;
      logger?: { warn(message: string): void };
    },
  ) {
    this.repository = new GrokCredentialRepository(options.vault);
    this.lock = options.lock ?? new LocalSubscriptionCredentialLock();
    this.state = options.runtimeStateStore ?? new InMemorySubscriptionCredentialRuntimeStateStore();
    this.journal = options.refreshJournal ?? new InMemorySubscriptionRefreshJournal();
    this.oauth = options.oauthClient ?? new GrokOAuthClient(options.fetchImpl, options.now);
    this.coordinator = options.credentialRotationCoordinator;
  }
  setCredentialRotationCoordinator(
    coordinator: ((ref: string) => Promise<void>) | undefined,
  ): void {
    this.coordinator = coordinator;
  }
  setCredentialRotationTransaction(
    transaction: SubscriptionCredentialRotationTransaction | undefined,
  ): void {
    this.rotationTransaction = transaction;
  }
  async getPendingPublicationRefs(): Promise<string[]> {
    const pending: string[] = [];
    for (const ref of this.getCredentialRefs()) {
      const generation = await this.journal.get(ref);
      if (generation === undefined) continue;
      try {
        if ((await this.repository.read(ref, generation)).generation > generation)
          pending.push(ref);
      } catch (error) {
        if (!(error instanceof GrokCredentialError)) throw error;
      }
    }
    return pending;
  }
  async acknowledgeCredentialRotation(ref: string): Promise<void> {
    await this.lock.runExclusive(this.lockKey(ref), async () => {
      const pending = await this.journal.get(ref);
      if (pending === undefined) return;
      const bundle = await this.repository.read(ref, pending);
      if (bundle.generation <= pending) throw new GrokProtocolError('refresh_outcome_unknown');
      await this.state.clear(ref, bundle.generation);
      await this.journal.clear(ref, pending);
    });
  }
  getCredentialRefs(): string[] {
    return orderedCredentialRefs(this.options.getConfig());
  }
  getConfiguration() {
    const config = this.options.getConfig() ?? {};
    const credentialRefs = this.getCredentialRefs();
    return {
      enabled: config.enabled === true,
      credentialRefs,
      credentialRef: credentialRefs[0],
      endpoint: validateGrokEndpoint(config.endpoint ?? GROK_RESPONSES_ENDPOINT),
      quotaCooldownMinutes: config.quotaCooldownMinutes ?? 60,
      oauthClientId: config.oauthClientId ?? GROK_OAUTH_CLIENT_ID,
    };
  }
  isConfigured(ref: string): boolean {
    return this.getConfiguration().enabled && this.getCredentialRefs().includes(ref);
  }
  async getCredentials(
    force = false,
    staleGeneration?: number,
    ref?: string,
  ): Promise<GrokTokenBundle> {
    return this.getCredentialsForCredential(
      ref ?? this.getCredentialRefs()[0],
      force,
      staleGeneration,
    );
  }
  async getCredentialsForCredential(
    ref: string | undefined,
    force = false,
    staleGeneration?: number,
  ): Promise<GrokTokenBundle> {
    if (!ref) throw new GrokProtocolError('subscription_not_configured', 503);
    this.assertConfigured(ref);
    const observed = await this.readBundle(ref);
    const pending = await this.journal.get(ref);
    const unavailable = await this.state.get(ref);
    if (
      pending === undefined &&
      unavailable?.availability === 'auth_unavailable' &&
      !isTransientGrokRefreshCode(unavailable.lastFailureCode)
    )
      throw new GrokCredentialError(
        unavailable.lastFailureCode ?? 'auth_unavailable',
        observed.generation,
      );
    // 旧版本把刷新瞬态失败记成 auth_unavailable；这类标记只能由一次成功刷新清除，不能直接沿用当前令牌。
    const transientUnavailable =
      unavailable?.availability === 'auth_unavailable' &&
      isTransientGrokRefreshCode(unavailable.lastFailureCode);
    if (
      pending === undefined &&
      !transientUnavailable &&
      !this.expiring(observed) &&
      (!force || (staleGeneration !== undefined && observed.generation > staleGeneration))
    )
      return { ...observed, credentialRef: ref };
    let promise = this.inFlight.get(ref);
    if (!promise) {
      const started = this.refresh(
        ref,
        observed.generation,
        force || transientUnavailable,
        staleGeneration,
      ).finally(() => {
        if (this.inFlight.get(ref) === started) this.inFlight.delete(ref);
      });
      this.inFlight.set(ref, started);
      promise = started;
    }
    try {
      return await promise;
    } catch (error) {
      // 提前刷新失败但当前 access token 仍有效：先继续使用，下一次访问再重试刷新。
      if (
        !force &&
        isTransientGrokRefreshError(error) &&
        Date.parse(observed.expiresAt) > this.now()
      )
        return { ...observed, credentialRef: ref };
      throw error;
    }
  }
  async persistLogin(
    tokens: GrokOAuthTokens,
    existingRef?: string,
    metadata: Record<string, unknown> = {},
  ) {
    if (existingRef) throw new GrokProtocolError('reauthorization_requires_candidate');
    const candidate = await this.repository.create(tokens, metadata);
    try {
      await this.state.clear(candidate.credentialRef, candidate.bundle.generation);
    } catch {
      await this.repository.revoke(candidate.credentialRef).catch(() => undefined);
      throw new GrokProtocolError('candidate_state_failed');
    }
    return candidate;
  }
  async assertUniqueAccount(
    tokens: GrokOAuthTokens,
    refs: readonly string[],
    replaceRef?: string,
  ): Promise<void> {
    for (const ref of refs) {
      let previous: GrokTokenBundle;
      try {
        previous = await this.repository.read(ref);
      } catch (error) {
        if (error instanceof GrokCredentialError) continue;
        throw error;
      }
      if (ref === replaceRef) {
        if (previous.accountId !== tokens.accountId)
          throw new GrokProtocolError('reauthorization_account_mismatch', 409);
      } else if (previous.accountId === tokens.accountId)
        throw new GrokProtocolError('account_already_registered', 409);
    }
  }
  async discardLoginCandidate(ref: string): Promise<void> {
    if (this.getCredentialRefs().includes(ref))
      throw new GrokProtocolError('credential_already_published', 409);
    await this.lock.runExclusive(this.lockKey(ref), async () => {
      if (this.getCredentialRefs().includes(ref))
        throw new GrokProtocolError('credential_already_published', 409);
      await this.repository.revoke(ref);
      await this.state.clear(ref);
      await this.journal.clear(ref);
    });
  }
  async revoke(ref: string, remote = true): Promise<{ remoteWarning?: string }> {
    const bundle = await this.lock.runExclusive(this.lockKey(ref), async () => {
      if (this.getCredentialRefs().includes(ref))
        throw new GrokProtocolError('credential_still_configured', 409);
      let stored: GrokTokenBundle | undefined;
      try {
        stored = await this.repository.read(ref);
      } catch (error) {
        if (!(error instanceof GrokCredentialError)) throw error;
      }
      await this.repository.revoke(ref);
      await this.state.clear(ref);
      await this.journal.clear(ref);
      return stored;
    });
    // Reauthorization/candidate cleanup must not revoke a grant shared by the new credentials.
    if (!remote) return {};
    const confirmed = bundle ? await this.oauth.revoke(bundle).catch(() => false) : false;
    return confirmed ? {} : { remoteWarning: '本地凭据已停用；xAI 远端撤销未确认。' };
  }
  async getRuntimeState(ref: string) {
    const current = await this.state.get(ref);
    if (current) {
      // A Vault write can succeed while its acknowledgement is lost. A later generation may recover
      // the publication fence without resending the already-consumed refresh token.
      try {
        const bundle = await this.repository.read(ref, current.credentialGeneration);
        if (bundle.generation > current.credentialGeneration)
          await this.state.clear(ref, bundle.generation);
      } catch (error) {
        if (!(error instanceof GrokCredentialError)) throw error;
      }
      // 旧版本把刷新瞬态失败写成永久失效；现在视为可恢复：清掉标记，让下一次访问重试刷新而不是要求重授权。
      if (
        current.availability === 'auth_unavailable' &&
        isTransientGrokRefreshCode(current.lastFailureCode)
      )
        await this.state.clear(ref);
    }
    return this.state.get(ref);
  }
  getRuntimeGeneration(ref: string) {
    return this.state.getGeneration(ref);
  }
  async markQuotaCooldown(ref: string, code: string, generation = 0): Promise<string> {
    const until = new Date(
      this.now() + this.getConfiguration().quotaCooldownMinutes * 60_000,
    ).toISOString();
    if (this.getCredentialRefs().includes(ref))
      await this.state.markQuotaCooldown(ref, until, code, generation);
    return until;
  }
  async markAuthUnavailable(ref: string, code: string, generation = 0): Promise<void> {
    if (this.getCredentialRefs().includes(ref))
      await this.state.markAuthUnavailable(ref, code, generation);
  }
  async getStatuses(): Promise<GrokCredentialStatus[]> {
    return Promise.all(
      this.getCredentialRefs().map(async (ref, index) => ({
        ...(await this.getStatus(ref)),
        priority: index + 1,
      })),
    );
  }
  async getStatus(ref = this.getCredentialRefs()[0]): Promise<GrokCredentialStatus> {
    if (!ref) return { configured: false, connected: false };
    try {
      const bundle = await this.readBundle(ref);
      const state = await this.state.get(ref);
      // 刷新瞬态失败不算断开：对外仍报 available，只保留失败码供诊断。
      const transient =
        state?.availability === 'auth_unavailable' &&
        isTransientGrokRefreshCode(state.lastFailureCode);
      const availability = transient ? 'available' : (state?.availability ?? 'available');
      return {
        id: ref,
        configured: true,
        connected: availability !== 'auth_unavailable',
        accountBindingHash: hashAccountBinding(bundle.accountId),
        accountIdHint: bundle.accountId.slice(-6),
        ...(bundle.email ? { email: maskEmail(bundle.email) } : {}),
        expiresAt: bundle.expiresAt,
        accessTokenExpired: Date.parse(bundle.expiresAt) <= this.now(),
        generation: bundle.generation,
        availability,
        cooldownUntil: state?.cooldownUntil,
        lastFailureCode: state?.lastFailureCode,
      };
    } catch (error) {
      return { id: ref, configured: true, connected: false, error: safeError(error) };
    }
  }
  getRuntimeStatus() {
    return this.telemetry.snapshot();
  }
  recordModelResult(input: Parameters<SubscriptionTelemetry['recordResult']>[0]): void {
    this.telemetry.recordResult({
      ...input,
      cacheEligible: false,
      errorCode: input.errorCode ? 'provider_error' : undefined,
    });
  }
  recordModelFailure(model: string, error: unknown): void {
    this.telemetry.recordFailure(model, safeError(error));
  }
  recordWireRequest(input: SubscriptionWireRequestSample): void {
    this.telemetry.recordWireRequest({ ...input, fallbackReason: undefined });
  }
  private async refresh(
    ref: string,
    observedGeneration: number,
    force: boolean,
    staleGeneration?: number,
  ): Promise<GrokTokenBundle> {
    const rotate = () =>
      this.lock.runExclusive(this.lockKey(ref), async () => {
        this.assertConfigured(ref);
        const latest = await this.readBundle(ref);
        const pending = await this.journal.get(ref);
        if (pending !== undefined) {
          if (latest.generation > pending) {
            await this.state.clear(ref, latest.generation);
            return { bundle: latest, pending };
          }
          // 上一次刷新没有留下新 generation：视为未完成，释放 fence 后用当前 refresh token 重试。
          // 若 grant 已在上游被消费，授权服务器会以 invalid_grant 明确拒绝，再进入永久失效。
          await this.journal.clear(ref, pending);
        }
        if (
          !this.expiring(latest) &&
          (!force || latest.generation > (staleGeneration ?? observedGeneration))
        )
          return { bundle: latest };
        const state = await this.state.get(ref);
        if (
          state?.availability === 'auth_unavailable' &&
          !isTransientGrokRefreshCode(state.lastFailureCode)
        )
          throw new GrokCredentialError(
            state.lastFailureCode ?? 'auth_unavailable',
            latest.generation,
          );
        if (this.options.requireRotationCoordinator && !this.rotationTransaction)
          throw new GrokProtocolError('credential_publication_unavailable');
        await this.journal.begin(ref, latest.generation);
        let exchanged = false;
        try {
          const tokens = await this.oauth.refresh(latest);
          exchanged = true;
          this.assertConfigured(ref);
          const next: GrokTokenBundle = { ...tokens, generation: latest.generation + 1 };
          await this.repository.rotate(ref, next);
          await this.state.clear(ref, next.generation);
          this.telemetry.recordRefreshSuccess(next.generation);
          return { bundle: next, pending: latest.generation };
        } catch (error) {
          this.telemetry.recordRefreshFailure(safeError(error));
          if (error instanceof GrokProtocolError && !error.outcomeUnknown) {
            await this.journal.clear(ref, latest.generation);
            if (isPermanentGrokGrantRejection(error.code)) {
              await this.state.markAuthUnavailable(ref, error.code, latest.generation);
              this.warn(ref, latest.generation, `授权被 xAI 拒绝（${error.code}），需要重授权`);
              throw new GrokCredentialError(error.code, latest.generation);
            }
            throw error;
          }
          // 传输失败、上游 5xx/异常响应或本地写入失败：账号并未被拒绝，不标永久失效。
          // 未换出令牌时释放 fence，下次沿用当前 refresh token 重试；已换出则保留 fence 供更高 generation 恢复。
          if (!exchanged) await this.journal.clear(ref, latest.generation);
          this.warn(
            ref,
            latest.generation,
            `刷新未完成（${safeError(error)}${causeDetail(error)}），保留当前凭据，下次访问重试`,
          );
          throw new GrokProtocolError('refresh_transient_failure', 503, true, { cause: error });
        }
      });
    const result = this.rotationTransaction
      ? await this.rotationTransaction(ref, rotate)
      : await rotate();
    // Production holds the publication fence around the credential lock and final receipts.
    // Non-production compatibility callbacks still run after releasing the credential lock.
    if (result.pending !== undefined) {
      try {
        if (!this.rotationTransaction && this.getCredentialRefs().includes(ref))
          await this.coordinator?.(ref);
      } catch {
        throw new GrokProtocolError('credential_publication_pending');
      }
      await this.journal.clear(ref, result.pending);
    }
    this.assertConfigured(ref);
    return { ...result.bundle, credentialRef: ref };
  }
  private async readBundle(ref: string): Promise<GrokTokenBundle> {
    const generation = await this.state.getGeneration(ref);
    const bundle = await this.repository.read(ref, generation);
    if (generation === undefined || bundle.generation > generation)
      await this.state.clear(ref, bundle.generation);
    return bundle;
  }
  private assertConfigured(ref: string): void {
    if (!this.isConfigured(ref))
      throw new GrokProtocolError('subscription_disabled_or_removed', 503);
  }
  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
  private expiring(bundle: GrokTokenBundle): boolean {
    return Date.parse(bundle.expiresAt) <= this.now() + REFRESH_LEAD_MS;
  }
  private warn(ref: string, generation: number, message: string): void {
    this.options.logger?.warn(
      `Grok 订阅凭据 ${ref.slice(0, 8)}… generation ${generation}：${message}`,
    );
  }
  private lockKey(ref: string): string {
    return `agent-saas:grok-oauth:${ref}`;
  }
}
function safeError(error: unknown): string {
  return error instanceof GrokProtocolError || error instanceof GrokCredentialError
    ? error.code
    : 'provider_request_failed';
}
/** 只取脱敏后的底层原因文本用于日志；令牌与凭据字段一律不进入日志。 */
function causeDetail(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  const raw = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
  const text = raw
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/((?:access|refresh|id)[_-]?token|secret|password)\s*[:=]\s*\S+/giu, '$1=[redacted]')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!text) return '';
  return `，原因：${text.length > 120 ? `${text.slice(0, 117)}...` : text}`;
}
function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  return at > 0 ? `${email.slice(0, 1)}***${email.slice(at)}` : '***';
}

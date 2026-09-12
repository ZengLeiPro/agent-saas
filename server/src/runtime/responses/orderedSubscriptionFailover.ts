import type { SubscriptionCredentialRuntimeState } from './subscriptionCredentialRuntimeState.js';
export type SubscriptionAttempt<Result, Quota> =
  | { kind: 'result'; result: Result }
  | { kind: 'quota'; quota: Quota; cooldownUntil: string }
  | { kind: 'auth_unavailable' }
  | { kind: 'ineligible' };
/** Shared priority scheduling. Only provider policy may classify quota/auth failures. */
export async function executeOrderedSubscriptionFailover<Token, Result, Quota>(options: {
  credentialRefs: readonly string[];
  signal?: AbortSignal;
  isConfigured?: (ref: string) => boolean;
  getRuntimeState: (ref: string) => Promise<SubscriptionCredentialRuntimeState | undefined>;
  getCredentials: (ref: string) => Promise<Token>;
  handleCredentialError: (ref: string, error: unknown) => Promise<boolean>;
  attempt: (ref: string, token: Token) => Promise<SubscriptionAttempt<Result, Quota>>;
  disposeQuota: (quota: Quota | undefined) => Promise<void>;
  finishQuota: (quota: Quota, retryAt: string) => Promise<Result>;
  finishUnavailable: (state: {
    earliestCooldownUntil?: string;
    authUnavailableCount: number;
    accountCount: number;
    ineligibleCount: number;
  }) => Result | Promise<Result>;
}): Promise<Result> {
  let lastQuota: Quota | undefined;
  let retainLastQuota = false;
  let earliestCooldownUntil: string | undefined;
  let authUnavailableCount = 0;
  let ineligibleCount = 0;
  const observeCooldown = (until?: string) => {
    if (until && (!earliestCooldownUntil || until < earliestCooldownUntil))
      earliestCooldownUntil = until;
  };
  try {
    for (const ref of options.credentialRefs) {
      options.signal?.throwIfAborted();
      if (options.isConfigured && !options.isConfigured(ref)) {
        ineligibleCount += 1;
        continue;
      }
      const state = await options.getRuntimeState(ref);
      if (state?.availability === 'quota_cooldown') {
        observeCooldown(state.cooldownUntil);
        continue;
      }
      if (state?.availability === 'auth_unavailable') {
        authUnavailableCount += 1;
        continue;
      }
      let token: Token;
      try {
        token = await options.getCredentials(ref);
      } catch (error) {
        options.signal?.throwIfAborted();
        if (!(await options.handleCredentialError(ref, error))) throw error;
        authUnavailableCount += 1;
        continue;
      }
      options.signal?.throwIfAborted();
      if (options.isConfigured && !options.isConfigured(ref)) {
        ineligibleCount += 1;
        continue;
      }
      const outcome = await options.attempt(ref, token);
      if (outcome.kind === 'result') return outcome.result;
      if (outcome.kind === 'auth_unavailable') {
        authUnavailableCount += 1;
        continue;
      }
      if (outcome.kind === 'ineligible') {
        ineligibleCount += 1;
        continue;
      }
      observeCooldown(outcome.cooldownUntil);
      await options.disposeQuota(lastQuota);
      lastQuota = outcome.quota;
    }
    options.signal?.throwIfAborted();
    if (lastQuota !== undefined) {
      const result = await options.finishQuota(
        lastQuota,
        earliestCooldownUntil ?? new Date().toISOString(),
      );
      retainLastQuota = true;
      return result;
    }
    return options.finishUnavailable({
      earliestCooldownUntil,
      authUnavailableCount,
      ineligibleCount,
      accountCount: options.credentialRefs.length,
    });
  } finally {
    if (!retainLastQuota) await options.disposeQuota(lastQuota);
  }
}

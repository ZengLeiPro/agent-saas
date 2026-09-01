import { describe, expect, it } from 'vitest';
import { ReleaseAttestationLog, type ReleaseAttestation } from './releaseAttestation.js';
import { getPromotionEligibility } from './releasePolicy.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const RELEASE_SHA = '1'.repeat(40);
const MIGRATION_PLAN_DIGEST = `sha256:${'b'.repeat(64)}`;
const PRODUCTION_BEFORE_DIGEST = `sha256:${'c'.repeat(64)}`;
const PRODUCTION_TARGET_DIGEST = `sha256:${'d'.repeat(64)}`;
const NOW = new Date('2026-08-25T12:00:00.000Z');
function promotingReason(migrationPhase: 'none' | 'expand') {
  return JSON.stringify({
    releaseId: 'rc-20260825-01',
    releaseSha: RELEASE_SHA,
    manifestDigest: DIGEST,
    migrationPhase,
    migrationPlanDigest: MIGRATION_PLAN_DIGEST,
    productionBeforeDigest: PRODUCTION_BEFORE_DIGEST,
    productionTargetDigest: PRODUCTION_TARGET_DIGEST,
  });
}
function confirmationReason(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    status: 'completed',
    releaseId: 'rc-20260825-01',
    manifestDigest: DIGEST,
    confirmationEvidenceDigest: `sha256:${'e'.repeat(64)}`,
    migrationPlanDigest: MIGRATION_PLAN_DIGEST,
    productionBeforeDigest: PRODUCTION_BEFORE_DIGEST,
    productionTargetDigest: PRODUCTION_TARGET_DIGEST,
    liveObservedAt: NOW.toISOString(),
    apiReadyReleaseId: 'rc-20260825-01',
    apiReadyReleaseSha: RELEASE_SHA,
    confirmedAt: NOW.toISOString(),
    operatorReason: 'confirmed after production readback',
    ...overrides,
  });
}
function log(digest = DIGEST) {
  return new ReleaseAttestationLog('rc-20260825-01', digest, { now: () => NOW });
}
function append(
  entry: ReleaseAttestationLog,
  state: Parameters<ReleaseAttestationLog['append']>[0]['state'],
  operationKey: string = state,
) {
  return entry.append({
    state,
    operationKey,
    actor: 'release-bot',
    manifestDigest: DIGEST,
    ...(state === 'promoting' ? { reason: promotingReason('none') } : {}),
  });
}

describe('ReleaseAttestationLog', () => {
  it('only permits ordered transitions and appends immutable records', () => {
    const entries = log();
    append(entries, 'built');
    append(entries, 'staging_deployed');
    append(entries, 'verified');
    append(entries, 'approved');
    expect(entries.currentState()).toBe('approved');
    expect(entries.list()).toHaveLength(4);
    expect(entries.isPromotable()).toBe(true);
  });

  it('allows a newly reasoned approval only after a proven failure before change', () => {
    const entries = log();
    append(entries, 'built');
    append(entries, 'staging_deployed');
    append(entries, 'verified');
    append(entries, 'approved', 'approval-1');
    append(entries, 'failed_before_change');
    append(entries, 'approved', 'approval-2');
    expect(entries.currentState()).toBe('approved');
    expect(entries.isPromotable()).toBe(true);

    const closedAttempt = log();
    append(closedAttempt, 'built');
    append(closedAttempt, 'staging_deployed');
    append(closedAttempt, 'verified');
    append(closedAttempt, 'approved');
    append(closedAttempt, 'promoting');
    append(closedAttempt, 'failed_before_change');
    append(closedAttempt, 'approved', 'safe-reapproval');
    expect(closedAttempt.currentState()).toBe('approved');

    const neverVerified = log();
    append(neverVerified, 'failed_before_change');
    expect(() => append(neverVerified, 'approved', 'unverified-reapproval')).toThrow(
      /Illegal or late/u,
    );
  });

  it('hydrates immutable legacy promoting history without weakening new writes', () => {
    const historical = log();
    append(historical, 'built');
    append(historical, 'staging_deployed');
    append(historical, 'verified');
    append(historical, 'approved');
    append(historical, 'promoting');
    append(historical, 'completed');
    const legacy = historical
      .list()
      .map((entry) => (entry.state === 'promoting' ? { ...entry, reason: undefined } : entry));
    const hydrated = ReleaseAttestationLog.hydrate('rc-20260825-01', DIGEST, legacy, {
      now: () => NOW,
    });
    expect(hydrated.currentState()).toBe('completed');
    expect(hydrated.list()).toEqual(legacy);

    const malformed = legacy.map((entry) =>
      entry.state === 'promoting' ? { ...entry, reason: '{"migrationPhase":"none"}' } : entry,
    );
    expect(() =>
      ReleaseAttestationLog.hydrate('rc-20260825-01', DIGEST, malformed, { now: () => NOW }),
    ).toThrow(/immutable migration phase and plan/u);

    const legacyPromoting = ReleaseAttestationLog.hydrate(
      'rc-20260825-01',
      DIGEST,
      legacy.slice(0, -1),
      { now: () => NOW },
    );
    expect(() => append(legacyPromoting, 'completed', 'new-completion')).toThrow(
      /Illegal or late/u,
    );

    const strict = log();
    append(strict, 'built');
    append(strict, 'staging_deployed');
    append(strict, 'verified');
    append(strict, 'approved');
    expect(() =>
      strict.append({
        state: 'promoting',
        operationKey: 'unbound-promoting',
        actor: 'release-bot',
        manifestDigest: DIGEST,
      }),
    ).toThrow(/immutable migration phase and plan/u);
  });

  it('requires evidence bound to the promoting plan for expand confirmation', () => {
    const entries = log();
    append(entries, 'built');
    append(entries, 'staging_deployed');
    append(entries, 'verified');
    append(entries, 'approved', 'approval-1');
    const migrationPlanDigest = MIGRATION_PLAN_DIGEST;
    const productionBeforeDigest = PRODUCTION_BEFORE_DIGEST;
    const productionTargetDigest = PRODUCTION_TARGET_DIGEST;
    entries.append({
      state: 'promoting',
      operationKey: 'promoting-1',
      actor: 'release-bot',
      manifestDigest: DIGEST,
      reason: JSON.stringify({
        releaseId: 'rc-20260825-01',
        releaseSha: RELEASE_SHA,
        manifestDigest: DIGEST,
        migrationPhase: 'expand',
        migrationPlanDigest,
        productionBeforeDigest,
        productionTargetDigest,
      }),
    });
    expect(() => append(entries, 'completed', 'generic-completion-from-promoting')).toThrow(
      /Illegal or late/u,
    );
    append(entries, 'awaiting_expand_confirmation');
    expect(() => append(entries, 'completed', 'generic-completion')).toThrow(/Illegal or late/u);
    expect(() =>
      entries.append({
        state: 'completed',
        operationKey: 'expand-confirmation:123:1',
        actor: 'release-bot',
        manifestDigest: DIGEST,
        reason: confirmationReason({
          migrationPlanDigest: `sha256:${'f'.repeat(64)}`,
          operatorReason: 'forged cross-plan confirmation',
        }),
      }),
    ).toThrow(/Illegal or late/u);
    entries.append({
      state: 'completed',
      operationKey: 'expand-confirmation:123:1',
      actor: 'release-bot',
      manifestDigest: DIGEST,
      reason: confirmationReason({
        migrationPlanDigest,
        productionBeforeDigest,
        productionTargetDigest,
      }),
    });
    expect(entries.currentState()).toBe('completed');

    const unsafe = log();
    append(unsafe, 'built');
    append(unsafe, 'staging_deployed');
    append(unsafe, 'verified');
    append(unsafe, 'approved');
    append(unsafe, 'promoting');
    append(unsafe, 'needs_human');
    expect(() => append(unsafe, 'approved', 'generic-recovery')).toThrow(/Illegal or late/u);
  });

  it('rejects stale, incomplete, or cross-release expand confirmation evidence at append time', () => {
    const awaitingLog = () => {
      const entries = log();
      append(entries, 'built');
      append(entries, 'staging_deployed');
      append(entries, 'verified');
      append(entries, 'approved');
      entries.append({
        state: 'promoting',
        operationKey: 'promoting-expand',
        actor: 'release-bot',
        manifestDigest: DIGEST,
        reason: promotingReason('expand'),
      });
      append(entries, 'awaiting_expand_confirmation');
      return entries;
    };
    const appendConfirmation = (entries: ReleaseAttestationLog, reason: string) =>
      entries.append({
        state: 'completed',
        operationKey: 'expand-confirmation:456:1',
        actor: 'release-bot',
        manifestDigest: DIGEST,
        reason,
      });

    const delayed = ReleaseAttestationLog.hydrate('rc-20260825-01', DIGEST, awaitingLog().list(), {
      now: () => new Date('2026-08-25T14:00:00.001Z'),
    });
    expect(() => appendConfirmation(delayed, confirmationReason())).toThrow(/Illegal or late/u);
    expect(() =>
      delayed.append({
        state: 'awaiting_expand_confirmation',
        operationKey: 'expand-reobservation:456:1',
        actor: 'release-bot',
        manifestDigest: DIGEST,
        reason: promotingReason('expand'),
      }),
    ).toThrow(/Illegal or late/u);
    expect(delayed.currentState()).toBe('awaiting_expand_confirmation');

    for (const overrides of [
      { liveObservedAt: undefined },
      { confirmedAt: '2026-08-24T00:00:00.000Z' },
      { apiReadyReleaseId: 'rc-20260825-02' },
      { apiReadyReleaseSha: '2'.repeat(40) },
      { schemaVersion: 2 },
    ]) {
      expect(() => appendConfirmation(awaitingLog(), confirmationReason(overrides))).toThrow(
        /Illegal or late/u,
      );
    }
  });

  it('requires a bound migration phase and lets only none complete directly', () => {
    const missing = log();
    append(missing, 'built');
    append(missing, 'staging_deployed');
    append(missing, 'verified');
    append(missing, 'approved');
    expect(() =>
      missing.append({
        state: 'promoting',
        operationKey: 'promoting-without-context',
        actor: 'release-bot',
        manifestDigest: DIGEST,
      }),
    ).toThrow(/immutable migration phase and plan/u);

    const none = log();
    append(none, 'built');
    append(none, 'staging_deployed');
    append(none, 'verified');
    append(none, 'approved');
    append(none, 'promoting');
    expect(() => append(none, 'awaiting_expand_confirmation')).toThrow(/Illegal or late/u);
    append(none, 'completed', 'none-completed');
    expect(none.currentState()).toBe('completed');
  });

  it('makes an identical operation idempotent but rejects divergent replay and late receipts', () => {
    const entries = log();
    const first = append(entries, 'built', 'build-1');
    expect(append(entries, 'built', 'build-1')).toEqual(first);
    expect(() => append(entries, 'rejected', 'build-1')).toThrow(/already used/);
    expect(() => append(entries, 'approved', 'approval-early')).toThrow(/Illegal or late/);
  });

  it('exposes a frozen attestation snapshot that cannot change the state machine', () => {
    const entries = log();
    const snapshot = entries.list();

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() =>
      (snapshot as ReleaseAttestation[]).push({
        id: 'forged',
        releaseId: 'rc-20260825-01',
        manifestDigest: DIGEST,
        state: 'approved',
        operationKey: 'forged',
        actor: 'attacker',
        recordedAt: NOW.toISOString(),
      }),
    ).toThrow();
    expect(entries.currentState()).toBe('created');
    expect(entries.isPromotable()).toBe(false);
  });

  it('keeps implicit-time retries idempotent across clock ticks', () => {
    let now = new Date('2026-08-25T12:00:00.000Z');
    const entries = new ReleaseAttestationLog('rc-20260825-01', DIGEST, { now: () => now });
    const first = append(entries, 'built', 'build-retry');
    now = new Date('2026-08-25T12:00:00.001Z');

    expect(append(entries, 'built', 'build-retry')).toBe(first);
    expect(() =>
      entries.append({
        state: 'built',
        operationKey: 'build-retry',
        actor: 'release-bot',
        manifestDigest: DIGEST,
        reason: 'different',
      }),
    ).toThrow(/already used/);
  });

  it('rejects mismatched manifest evidence and lets revocation remove promotion eligibility', () => {
    const entries = log();
    expect(() =>
      entries.append({
        state: 'built',
        operationKey: 'build',
        actor: 'release-bot',
        manifestDigest: `sha256:${'b'.repeat(64)}`,
      }),
    ).toThrow(/does not match/);
    append(entries, 'built');
    append(entries, 'staging_deployed');
    append(entries, 'verified');
    append(entries, 'approved');
    append(entries, 'revoked');
    expect(entries.isPromotable()).toBe(false);
  });

  it('rejects expired, future, malformed, and out-of-order receipts; approvals expire too', () => {
    const entries = log();
    expect(() =>
      entries.append({
        state: 'built',
        operationKey: 'old',
        actor: 'release-bot',
        manifestDigest: DIGEST,
        recordedAt: '2026-08-24T11:59:59.999Z',
      }),
    ).toThrow(/expired/);
    expect(() =>
      entries.append({
        state: 'built',
        operationKey: 'future',
        actor: 'release-bot',
        manifestDigest: DIGEST,
        recordedAt: '2026-08-25T12:05:00.001Z',
      }),
    ).toThrow(/future/);
    expect(() =>
      entries.append({
        state: 'built',
        operationKey: 'bad-time',
        actor: 'release-bot',
        manifestDigest: DIGEST,
        recordedAt: '2026-08-25',
      }),
    ).toThrow(/ISO UTC/);
    append(entries, 'built');
    expect(() =>
      entries.append({
        state: 'staging_deployed',
        operationKey: 'out-of-order',
        actor: 'release-bot',
        manifestDigest: DIGEST,
        recordedAt: '2026-08-25T11:59:59.999Z',
      }),
    ).toThrow(/expired|out of order/);
    append(entries, 'staging_deployed');
    append(entries, 'verified');
    append(entries, 'approved');
    expect(entries.isPromotable(new Date('2026-08-26T12:00:00.001Z'))).toBe(false);
  });

  it('fails promotion policy closed for cross-manifest, expired, non-main, or baseline-drifted releases', () => {
    const entries = log();
    append(entries, 'built');
    append(entries, 'staging_deployed');
    append(entries, 'verified');
    append(entries, 'approved');
    const allowed = getPromotionEligibility(
      {
        attestations: entries,
        manifestDigest: DIGEST,
        expectedManifestDigest: DIGEST,
        isMainAncestor: true,
        minimumPromotableShaSatisfied: true,
        productionBaselineMatches: true,
        expiresAt: '2026-08-26T12:00:00.000Z',
      },
      { now: () => NOW },
    );
    expect(allowed.promotable).toBe(true);
    const crossManifest = getPromotionEligibility(
      {
        attestations: entries,
        manifestDigest: `sha256:${'b'.repeat(64)}`,
        expectedManifestDigest: `sha256:${'b'.repeat(64)}`,
        isMainAncestor: true,
        minimumPromotableShaSatisfied: true,
        productionBaselineMatches: true,
        expiresAt: '2026-08-26T12:00:00.000Z',
      },
      { now: () => NOW },
    );
    expect(crossManifest).toMatchObject({
      promotable: false,
      blockingReasons: ['Manifest digest mismatch.'],
    });
    const denied = getPromotionEligibility(
      {
        attestations: entries,
        manifestDigest: DIGEST,
        expectedManifestDigest: DIGEST,
        isMainAncestor: false,
        minimumPromotableShaSatisfied: false,
        productionBaselineMatches: false,
        expiresAt: '2000-01-01T00:00:00.000Z',
      },
      { now: () => NOW },
    );
    expect(denied).toMatchObject({
      promotable: false,
      blockingReasons: expect.arrayContaining([
        'Release SHA is not reachable from main.',
        'Release SHA is below the minimum promotable SHA.',
        'Current production component matrix drifted from the frozen baseline.',
        'Release promotion approval has expired.',
      ]),
    });
  });

  it('evaluates required expiry with an injectable clock', () => {
    const entries = log();
    append(entries, 'built');
    append(entries, 'staging_deployed');
    append(entries, 'verified');
    append(entries, 'approved');
    const input = {
      attestations: entries,
      manifestDigest: DIGEST,
      expectedManifestDigest: DIGEST,
      isMainAncestor: true,
      minimumPromotableShaSatisfied: true,
      productionBaselineMatches: true,
      expiresAt: '2026-08-25T12:00:00.001Z',
    };

    expect(getPromotionEligibility(input, { now: () => NOW }).promotable).toBe(true);
    expect(
      getPromotionEligibility(input, {
        now: () => new Date('2026-08-25T12:00:00.001Z'),
      }),
    ).toMatchObject({
      promotable: false,
      blockingReasons: expect.arrayContaining([expect.stringMatching(/expired/)]),
    });

    const missingExpiry = getPromotionEligibility(
      { ...input, expiresAt: undefined } as unknown as Parameters<
        typeof getPromotionEligibility
      >[0],
      { now: () => NOW },
    );
    expect(missingExpiry).toMatchObject({
      promotable: false,
      blockingReasons: expect.arrayContaining([expect.stringMatching(/expired/)]),
    });
  });

  it.each(['failed_before_change', 'partial_failed', 'rolled_back', 'needs_human'] as const)(
    'records truthful terminal promotion outcome %s without allowing later completion',
    (outcome) => {
      const entries = log();
      append(entries, 'built');
      append(entries, 'staging_deployed');
      append(entries, 'verified');
      append(entries, 'approved');
      append(entries, 'promoting');
      append(entries, outcome);
      expect(entries.currentState()).toBe(outcome);
      expect(() => append(entries, 'completed', `late-complete-${outcome}`)).toThrow(
        /Illegal or late/u,
      );
    },
  );
});

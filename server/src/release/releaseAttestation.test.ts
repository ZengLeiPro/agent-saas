import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Release workflow scripts are intentionally plain ESM.
import { assertPromotionRetryable } from '../../../scripts/release/assert-promotion-retry.mjs';
// @ts-expect-error Release workflow scripts are intentionally plain ESM.
import { reconcilePromotion } from '../../../scripts/release/reconcile-promotion.mjs';
import { ReleaseAttestationLog, type ReleaseAttestation } from './releaseAttestation.js';
import { getPromotionEligibility } from './releasePolicy.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const NOW = new Date('2026-08-25T12:00:00.000Z');
function log(digest = DIGEST) {
  return new ReleaseAttestationLog('rc-20260825-01', digest, { now: () => NOW });
}
function append(
  entry: ReleaseAttestationLog,
  state: Parameters<ReleaseAttestationLog['append']>[0]['state'],
  operationKey: string = state,
) {
  return entry.append({ state, operationKey, actor: 'release-bot', manifestDigest: DIGEST });
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

  it('allows renewed approval after failure before change in pre- or post-mutation history', () => {
    const entries = log();
    append(entries, 'built');
    append(entries, 'staging_deployed');
    append(entries, 'verified');
    append(entries, 'approved', 'approval-1');
    append(entries, 'failed_before_change');
    append(entries, 'approved', 'approval-2');
    expect(entries.currentState()).toBe('approved');
    expect(entries.isPromotable()).toBe(true);

    const postMutation = log();
    append(postMutation, 'built');
    append(postMutation, 'staging_deployed');
    append(postMutation, 'verified');
    append(postMutation, 'approved', 'post-approval-1');
    append(postMutation, 'promoting', 'post-promoting-1');
    append(postMutation, 'failed_before_change', 'post-reconcile-1');
    append(postMutation, 'approved', 'post-approval-2');
    append(postMutation, 'promoting', 'post-promoting-2');
    expect(postMutation.currentState()).toBe('promoting');

    const neverVerified = log();
    append(neverVerified, 'failed_before_change');
    expect(() => append(neverVerified, 'approved', 'unverified-reapproval')).toThrow(
      /Illegal or late/u,
    );
  });

  it('runs reconcile through append and retry assertion into the next reviewed promotion', async () => {
    const fixturePath = new URL(
      '../../../scripts/release/fixtures/promotion-rollback-retry.json',
      import.meta.url,
    );
    const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
    const scenario = fixture.failedBeforeChangeRetry;
    const entries = new ReleaseAttestationLog(scenario.releaseId, DIGEST, { now: () => NOW });
    for (const attestation of scenario.initialAttestations) {
      append(entries, attestation.state, attestation.operationKey);
    }

    const reconciliation = reconcilePromotion({
      releaseId: scenario.releaseId,
      before: fixture.before,
      target: fixture.target,
      observed: fixture.before,
      observationComplete: scenario.reconcile.observationComplete,
      rollbackAttempted: scenario.reconcile.rollbackAttempted,
    });
    expect(reconciliation.outcome).toBe(scenario.reconcile.expectedOutcome);
    entries.append({
      state: reconciliation.outcome,
      operationKey: scenario.reconcile.operationKey,
      actor: scenario.actor,
      manifestDigest: DIGEST,
      reason: JSON.stringify(reconciliation),
    });

    expect(assertPromotionRetryable(entries.list())).toEqual({
      mode: scenario.retry.expectedMode,
      latestState: scenario.reconcile.expectedOutcome,
      verifiedOperationKey: 'verified:failed-before-change',
      promotingOperationKey: 'promoting:failed-before-change:1',
      previousApprovalCount: 1,
    });

    append(entries, 'approved', scenario.retry.approvalOperationKey);
    append(entries, 'promoting', scenario.retry.promotingOperationKey);
    expect(
      entries
        .list()
        .slice(-3)
        .map(({ state, operationKey }) => ({ state, operationKey })),
    ).toEqual([
      {
        state: scenario.reconcile.expectedOutcome,
        operationKey: scenario.reconcile.operationKey,
      },
      { state: 'approved', operationKey: scenario.retry.approvalOperationKey },
      { state: 'promoting', operationKey: scenario.retry.promotingOperationKey },
    ]);
  });

  it('keeps every appendable post-mutation recoverable tail accepted by the retry gate', () => {
    const entries = log();
    for (const [state, operationKey] of [
      ['built', 'closure-built'],
      ['staging_deployed', 'closure-staging'],
      ['verified', 'closure-verified'],
      ['approved', 'closure-approval-1'],
      ['promoting', 'closure-promoting-1'],
    ] as const) {
      append(entries, state, operationKey);
    }

    const appendRecoverable = (
      state: Parameters<ReleaseAttestationLog['append']>[0]['state'],
      operationKey: string,
    ) => {
      append(entries, state, operationKey);
      expect(assertPromotionRetryable(entries.list()).mode).toBe('retry_after_change');
    };

    appendRecoverable('failed_before_change', 'closure-failed-1');
    appendRecoverable('failed_before_change', 'closure-failed-2');
    appendRecoverable('needs_human', 'closure-human-1');
    appendRecoverable('approved', 'closure-approval-2');
    appendRecoverable('needs_human', 'closure-human-before-mutation-2');
    appendRecoverable('approved', 'closure-approval-3');
    append(entries, 'promoting', 'closure-promoting-2');
    append(entries, 'partial_failed', 'closure-partial-2');
    appendRecoverable('rolled_back', 'closure-rollback-2');
    appendRecoverable('approved', 'closure-approval-4');
    appendRecoverable('failed_before_change', 'closure-failed-before-mutation-3');
    appendRecoverable('approved', 'closure-approval-5');
    append(entries, 'promoting', 'closure-promoting-3');
    appendRecoverable('needs_human', 'closure-human-3');
    appendRecoverable('needs_human', 'closure-human-3-repeat');
    appendRecoverable('rolled_back', 'closure-rollback-3');
  });

  it('allows direct human-reviewed recovery after a durable promotion reaches needs_human', () => {
    const entries = log();
    append(entries, 'built');
    append(entries, 'staging_deployed');
    append(entries, 'verified');
    append(entries, 'approved', 'approval-1');
    append(entries, 'promoting', 'promoting-1');
    append(entries, 'needs_human', 'needs-human-1');
    append(entries, 'approved', 'recovery-approval');
    append(entries, 'promoting', 'promoting-2');
    append(entries, 'completed');
    expect(entries.currentState()).toBe('completed');
  });

  it('allows renewed approval after each explicit rolled-back promotion round', () => {
    const entries = log();
    append(entries, 'built');
    append(entries, 'staging_deployed');
    append(entries, 'verified');
    append(entries, 'approved', 'approval-1');
    append(entries, 'promoting', 'promoting-1');
    append(entries, 'rolled_back', 'rollback-1');
    append(entries, 'approved', 'approval-2');
    append(entries, 'promoting', 'promoting-2');
    append(entries, 'partial_failed', 'partial-2');
    append(entries, 'rolled_back', 'rollback-2');
    append(entries, 'approved', 'approval-3');
    append(entries, 'promoting', 'promoting-3');
    append(entries, 'completed');
    expect(entries.currentState()).toBe('completed');
  });

  it('allows authoritative rollback plus renewed approval after partial_failed or needs_human', () => {
    for (const recoverable of ['partial_failed', 'needs_human'] as const) {
      const entries = log();
      append(entries, 'built');
      append(entries, 'staging_deployed');
      append(entries, 'verified');
      append(entries, 'approved', `approval-${recoverable}`);
      append(entries, 'promoting', `promoting-${recoverable}`);
      append(entries, recoverable, `outcome-${recoverable}`);
      append(entries, 'rolled_back', `rollback-${recoverable}`);
      append(entries, 'approved', `recovery-approval-${recoverable}`);
      expect(entries.currentState()).toBe('approved');
    }
  });

  it.each([
    'needs_human',
    'failed_before_change',
    'partial_failed',
    'rejected',
    'superseded',
    'revoked',
  ] as const)('allows only a new approval after rolled_back, rejecting %s', (rejectedState) => {
    const entries = log();
    append(entries, 'built');
    append(entries, 'staging_deployed');
    append(entries, 'verified');
    append(entries, 'approved');
    append(entries, 'promoting');
    append(entries, 'rolled_back');

    expect(() => append(entries, rejectedState, `after-rollback-${rejectedState}`)).toThrow(
      /Illegal or late/u,
    );
    append(entries, 'approved', 'new-reviewed-approval');
    expect(entries.currentState()).toBe('approved');
  });

  it('rejects post-mutation recoverable transitions absent from the retry assertion map', () => {
    for (const [firstOutcome, deadTail] of [
      ['partial_failed', 'needs_human'],
      ['needs_human', 'failed_before_change'],
      ['failed_before_change', 'partial_failed'],
    ] as const) {
      const entries = log();
      append(entries, 'built');
      append(entries, 'staging_deployed');
      append(entries, 'verified');
      append(entries, 'approved');
      append(entries, 'promoting');
      append(entries, firstOutcome);
      expect(() => append(entries, deadTail, `${firstOutcome}-to-${deadTail}`)).toThrow(
        /Illegal or late/u,
      );
    }
  });

  it('rejects rollback without an active unambiguous promoting round', () => {
    for (const illegal of ['rejected', 'superseded'] as const) {
      const entries = log();
      append(entries, 'built');
      append(entries, 'staging_deployed');
      append(entries, 'verified');
      append(entries, 'approved');
      append(entries, 'promoting');
      append(entries, illegal);
      expect(() => append(entries, 'rolled_back', `unsafe-${illegal}`)).toThrow(/Illegal or late/u);
    }

    const noMutation = log();
    append(noMutation, 'built');
    append(noMutation, 'staging_deployed');
    append(noMutation, 'verified');
    append(noMutation, 'approved');
    append(noMutation, 'needs_human');
    expect(() => append(noMutation, 'rolled_back')).toThrow(/Illegal or late/u);

    const noNewMutation = log();
    append(noNewMutation, 'built');
    append(noNewMutation, 'staging_deployed');
    append(noNewMutation, 'verified');
    append(noNewMutation, 'approved', 'approval-1');
    append(noNewMutation, 'promoting');
    append(noNewMutation, 'rolled_back');
    append(noNewMutation, 'approved', 'approval-2');
    append(noNewMutation, 'needs_human');
    expect(() => append(noNewMutation, 'rolled_back', 'rollback-without-new-promoting')).toThrow(
      /Illegal or late/u,
    );
  });

  it('makes an identical operation idempotent but rejects divergent replay and late transitions', () => {
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

  it.each(['failed_before_change', 'partial_failed', 'rolled_back'] as const)(
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

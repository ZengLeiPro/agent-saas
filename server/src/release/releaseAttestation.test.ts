import { describe, expect, it } from 'vitest';
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
});

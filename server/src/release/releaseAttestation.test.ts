import { describe, expect, it } from 'vitest';
import { ReleaseAttestationLog } from './releaseAttestation.js';
import { getPromotionEligibility } from './releasePolicy.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;
function log() { return new ReleaseAttestationLog('rc-20260825-01', DIGEST); }
function append(entry: ReleaseAttestationLog, state: Parameters<ReleaseAttestationLog['append']>[0]['state'], operationKey: string = state) {
  return entry.append({ state, operationKey, actor: 'release-bot', manifestDigest: DIGEST });
}

describe('ReleaseAttestationLog', () => {
  it('only permits ordered transitions and appends immutable records', () => {
    const entries = log();
    append(entries, 'built'); append(entries, 'staging_deployed'); append(entries, 'verified'); append(entries, 'approved');
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

  it('rejects mismatched manifest evidence and lets revocation remove promotion eligibility', () => {
    const entries = log();
    expect(() => entries.append({ state: 'built', operationKey: 'build', actor: 'release-bot', manifestDigest: `sha256:${'b'.repeat(64)}` })).toThrow(/does not match/);
    append(entries, 'built'); append(entries, 'staging_deployed'); append(entries, 'verified'); append(entries, 'approved'); append(entries, 'revoked');
    expect(entries.isPromotable()).toBe(false);
  });

  it('fails promotion policy closed for expired, non-main, or baseline-drifted releases', () => {
    const entries = log();
    append(entries, 'built'); append(entries, 'staging_deployed'); append(entries, 'verified'); append(entries, 'approved');
    const allowed = getPromotionEligibility({ attestations: entries, manifestDigest: DIGEST, expectedManifestDigest: DIGEST, isMainAncestor: true, productionBaselineIsAncestor: true });
    expect(allowed.promotable).toBe(true);
    const denied = getPromotionEligibility({ attestations: entries, manifestDigest: DIGEST, expectedManifestDigest: DIGEST, isMainAncestor: false, productionBaselineIsAncestor: false, expiresAt: '2000-01-01T00:00:00.000Z' });
    expect(denied).toMatchObject({ promotable: false, blockingReasons: expect.arrayContaining(['Release SHA is not reachable from main.', 'Production baseline is not an ancestor of release SHA.', 'Release promotion approval has expired.']) });
  });
});

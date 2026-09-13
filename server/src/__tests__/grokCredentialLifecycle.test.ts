import { afterEach, describe, expect, it, vi } from 'vitest';
import { GrokCredentialManager } from '../runtime/responses/grokCredentialManager.js';
import { GrokProtocolError } from '../runtime/responses/grokProtocol.js';
import { grokFixture, grokTokens } from './grokTestFixtures.js';
afterEach(() => vi.restoreAllMocks());
describe('Grok credential lifecycle (T08, T10-T12, T23, T36)', () => {
  it('coalesces same-process refresh, masks metadata, and never refreshes a status GET', async () => {
    const f = await grokFixture(1);
    const refresh = vi.spyOn(f.oauth, 'refresh').mockImplementation(async (old) => ({
      ...old,
      accessToken: 'fixture-new',
      refreshToken: 'fixture-rotated',
    }));
    await f.manager.getStatuses();
    expect(refresh).not.toHaveBeenCalled();
    const tokens = await Promise.all(
      Array.from({ length: 12 }, () => f.manager.getCredentials(true, 1)),
    );
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(new Set(tokens.map((token) => token.generation))).toEqual(new Set([2]));
    const publicState = JSON.stringify(await f.manager.getStatuses());
    expect(publicState).not.toMatch(/fixture-new|fixture-rotated|fixture-access|fixture-refresh/);
    expect(publicState).toContain('***@example.invalid');
  });
  it('preserves current-generation auth over quota and rejects delayed old-generation failures', async () => {
    const f = await grokFixture(1);
    const ref = f.refs[0];
    await f.manager.markAuthUnavailable(ref, 'invalid_grant', 1);
    await f.manager.markQuotaCooldown(ref, 'quota', 1);
    expect(await f.manager.getRuntimeState(ref)).toMatchObject({
      availability: 'auth_unavailable',
    });
    await f.state.clear(ref, 2);
    await f.manager.markAuthUnavailable(ref, 'late', 1);
    expect(await f.manager.getRuntimeState(ref)).toBeUndefined();
  });
  it('treats a transport failure as retryable: no permanent mark, fence released, same token retried', async () => {
    const f = await grokFixture(1);
    const refresh = vi
      .spyOn(f.oauth, 'refresh')
      .mockRejectedValueOnce(new GrokProtocolError('network_outcome_unknown', undefined, true))
      .mockImplementation(async (old) => ({
        ...old,
        accessToken: 'fixture-new',
        refreshToken: 'fixture-rotated',
      }));
    await expect(f.manager.getCredentials(true, 1)).rejects.toMatchObject({
      code: 'refresh_transient_failure',
      outcomeUnknown: true,
    });
    expect(await f.journal.get(f.refs[0])).toBeUndefined();
    expect(await f.manager.getRuntimeState(f.refs[0])).toBeUndefined();
    expect((await f.manager.getStatus(f.refs[0])).connected).toBe(true);
    const recovered = await f.manager.getCredentials(true, 1);
    expect(recovered.generation).toBe(2);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh.mock.calls[1]![0]!.refreshToken).toBe('fixture-refresh-fixture-0');
  });
  it('marks the account unavailable only when the authorization server rejects the grant', async () => {
    const f = await grokFixture(1);
    const refresh = vi
      .spyOn(f.oauth, 'refresh')
      .mockRejectedValue(new GrokProtocolError('invalid_grant', 400));
    await expect(f.manager.getCredentials(true, 1)).rejects.toThrow('invalid_grant');
    expect(await f.manager.getRuntimeState(f.refs[0])).toMatchObject({
      availability: 'auth_unavailable',
      lastFailureCode: 'invalid_grant',
    });
    await expect(f.manager.getCredentials(true, 1)).rejects.toThrow('invalid_grant');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(await f.journal.get(f.refs[0])).toBeUndefined();
    expect((await f.manager.getStatus(f.refs[0])).connected).toBe(false);
  });
  it('keeps serving a still-valid access token when an early refresh fails transiently', async () => {
    const f = await grokFixture(1);
    const candidate = await f.manager.persistLogin(grokTokens('fixture-soon', 8 * 60_000));
    f.config.credentialRefs = [candidate.credentialRef];
    f.config.credentialRef = candidate.credentialRef;
    const refresh = vi
      .spyOn(f.oauth, 'refresh')
      .mockRejectedValue(new GrokProtocolError('network_outcome_unknown', undefined, true));
    const token = await f.manager.getCredentials();
    expect(token).toMatchObject({ generation: 1, accessToken: 'fixture-access-fixture-soon' });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(await f.manager.getRuntimeState(candidate.credentialRef)).toBeUndefined();
    await expect(f.manager.getCredentials(true, 1)).rejects.toMatchObject({
      code: 'refresh_transient_failure',
    });
  });
  it('recovers a credential that an older release left as refresh_outcome_unknown with a pending fence', async () => {
    const f = await grokFixture(1);
    await f.journal.begin(f.refs[0], 1);
    await f.state.markAuthUnavailable(f.refs[0], 'refresh_outcome_unknown', 1);
    expect(await f.manager.getStatus(f.refs[0])).toMatchObject({
      connected: true,
      availability: 'available',
      lastFailureCode: 'refresh_outcome_unknown',
    });
    const refresh = vi
      .spyOn(f.oauth, 'refresh')
      .mockImplementation(async (old) => ({ ...old, accessToken: 'fixture-recovered' }));
    const token = await f.manager.getCredentials();
    expect(token).toMatchObject({ generation: 2, accessToken: 'fixture-recovered' });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(await f.journal.get(f.refs[0])).toBeUndefined();
    expect(await f.state.get(f.refs[0])).toBeUndefined();
  });
  it('clears a legacy transient auth_unavailable mark when the transport inspects runtime state', async () => {
    const f = await grokFixture(1);
    await f.state.markAuthUnavailable(f.refs[0], 'refresh_outcome_unknown', 1);
    expect(await f.manager.getRuntimeState(f.refs[0])).toBeUndefined();
    expect(await f.state.get(f.refs[0])).toBeUndefined();
    await f.state.markAuthUnavailable(f.refs[0], 'invalid_grant', 1);
    expect(await f.manager.getRuntimeState(f.refs[0])).toMatchObject({
      availability: 'auth_unavailable',
    });
  });
  it('recovers a rotated Vault version after a lost acknowledgement without exchanging the old token again', async () => {
    const f = await grokFixture(1);
    const rotate = f.vault.rotateSecret.bind(f.vault);
    vi.spyOn(f.vault, 'rotateSecret').mockImplementationOnce(async (...args) => {
      await rotate(...args);
      throw new Error('fixture lost acknowledgement');
    });
    const refresh = vi
      .spyOn(f.oauth, 'refresh')
      .mockImplementation(async (old) => ({ ...old, accessToken: 'fixture-rotated-once' }));
    await expect(f.manager.getCredentials(true, 1)).rejects.toThrow('refresh_transient_failure');
    expect(await f.manager.getPendingPublicationRefs()).toEqual([f.refs[0]]);
    const recovered = await f.manager.getCredentials();
    expect(recovered.generation).toBe(2);
    expect(recovered.accessToken).toBe('fixture-rotated-once');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(await f.journal.get(f.refs[0])).toBeUndefined();
  });
  it('cannot resurrect a ref detached while the OAuth exchange was in flight', async () => {
    const f = await grokFixture(1);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(f.oauth, 'refresh').mockImplementation(async (old) => {
      entered();
      await gate;
      return { ...old, accessToken: 'fixture-late' };
    });
    const pending = f.manager.getCredentials(true, 1);
    const rejected = expect(pending).rejects.toThrow('subscription_disabled_or_removed');
    await started;
    f.config.credentialRefs = [];
    delete f.config.credentialRef;
    const revoke = f.manager.revoke(f.refs[0], false);
    release();
    await rejected;
    await revoke;
    expect(f.manager.getCredentialRefs()).toEqual([]);
    await expect(f.manager.getCredentialsForCredential(f.refs[0])).rejects.toThrow(
      'subscription_disabled_or_removed',
    );
  });
  it('rejects duplicate identities and prevents compensation from revoking configured grants', async () => {
    const f = await grokFixture(1);
    const remote = vi.spyOn(f.oauth, 'revoke').mockResolvedValue(true);
    await expect(f.manager.assertUniqueAccount(grokTokens('fixture-0'), f.refs)).rejects.toThrow(
      'account_already_registered',
    );
    await expect(
      f.manager.assertUniqueAccount(grokTokens('wrong-account'), f.refs, f.refs[0]),
    ).rejects.toThrow('reauthorization_account_mismatch');
    await expect(f.manager.discardLoginCandidate(f.refs[0])).rejects.toThrow(
      'credential_already_published',
    );
    const candidate = await f.manager.persistLogin(grokTokens('fixture-0'));
    await f.manager.discardLoginCandidate(candidate.credentialRef);
    expect(remote).not.toHaveBeenCalled();
    expect((await f.manager.getStatus(f.refs[0])).connected).toBe(true);
  });
  it('requires a production publication transaction before consuming a refresh token', async () => {
    const f = await grokFixture(1);
    const refresh = vi.spyOn(f.oauth, 'refresh');
    const manager = new GrokCredentialManager({
      vault: f.vault,
      getConfig: () => f.config,
      oauthClient: f.oauth,
      runtimeStateStore: f.state,
      refreshJournal: f.journal,
      requireRotationCoordinator: true,
    });
    await expect(manager.getCredentials(true, 1)).rejects.toThrow(
      'credential_publication_unavailable',
    );
    expect(refresh).not.toHaveBeenCalled();
    expect(await f.journal.get(f.refs[0])).toBeUndefined();
  });
  it('does not grant broad-scope users access to platform subscription secrets', async () => {
    const f = await grokFixture(1);
    await expect(
      f.vault.getSecret(f.refs[0], {
        actor: 'mcp_proxy',
        userId: 'admin',
        scopes: ['secret:*:read'],
      }),
    ).rejects.toThrow('system-only');
  });
});

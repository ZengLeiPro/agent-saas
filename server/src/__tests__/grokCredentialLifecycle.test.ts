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
  it('does not replay a rotating refresh token after an unknown upstream outcome', async () => {
    const f = await grokFixture(1);
    const refresh = vi
      .spyOn(f.oauth, 'refresh')
      .mockRejectedValue(new GrokProtocolError('network_outcome_unknown', undefined, true));
    await expect(f.manager.getCredentials(true, 1)).rejects.toThrow('refresh_outcome_unknown');
    await expect(f.manager.getCredentials(true, 1)).rejects.toThrow('refresh_outcome_unknown');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(await f.journal.get(f.refs[0])).toBe(1);
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
    await expect(f.manager.getCredentials(true, 1)).rejects.toThrow('refresh_outcome_unknown');
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

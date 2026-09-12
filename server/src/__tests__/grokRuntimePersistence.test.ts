import { describe, expect, it, vi } from 'vitest';
import { parseAppConfig } from '../app/config.js';
import { createModelSubscriptionRuntime } from '../app/modelSubscriptionRuntime.js';
import { InMemorySecretVault } from '../security/secretVault.js';

vi.mock('../release/runtimeIdentity.js', () => ({
  readRuntimeIdentity: () => ({ environment: 'production' }),
}));

describe('Grok production persistence admission', () => {
  it('rejects enabled Grok without a shared pool before contacting any provider', async () => {
    const config = parseAppConfig({
      agent: { cwd: '/tmp/grok-persistence' },
      server: { port: 3200 },
      grokSubscription: { enabled: true, credentialRef: 'fixture-ref' },
    });
    const egressFetch = vi.fn();
    await expect(
      createModelSubscriptionRuntime({
        config,
        secretVault: new InMemorySecretVault(),
        egressFetch,
      }),
    ).rejects.toMatchObject({ code: 'shared_postgres_runtime_required' });
    expect(egressFetch).not.toHaveBeenCalled();
  });

  it('keeps old configurations working but rejects process-local hot enablement', async () => {
    const config = parseAppConfig({
      agent: { cwd: '/tmp/grok-persistence' },
      server: { port: 3200 },
    });
    const egressFetch = vi.fn();
    const runtime = await createModelSubscriptionRuntime({
      config,
      secretVault: new InMemorySecretVault(),
      egressFetch,
    });
    expect(runtime.grokCredentialManager.getConfiguration().enabled).toBe(false);
    expect(runtime.factoryDependencies.grokCredentialManager).toBe(runtime.grokCredentialManager);
    expect(runtime.factoryDependencies.grokFetch).toBe(egressFetch);
    config.grokSubscription = {
      enabled: true,
      credentialRef: 'fixture-ref',
      quotaCooldownMinutes: 60,
    };
    expect(() => runtime.grokCredentialManager.getConfiguration()).toThrow(
      'shared_postgres_runtime_required',
    );
    expect(runtime.codexCredentialManager.getConfiguration().enabled).toBe(false);
    expect(egressFetch).not.toHaveBeenCalled();
  });
});

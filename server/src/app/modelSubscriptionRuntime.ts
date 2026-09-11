import { createGrokCredentialPersistence } from '../runtime/responses/grokCredentialPersistence.js';
import type { AppConfig } from './config.js';
import type { PgEventStore } from '../runtime/pgEventStore.js';
import type { SecretVault } from '../security/secretVault.js';
import { readRuntimeIdentity } from '../release/runtimeIdentity.js';
import {
  CodexCredentialManager,
  PgCodexCredentialLock,
} from '../runtime/responses/codexCredentialManager.js';
import { CodexDeviceAuthService } from '../runtime/responses/codexOAuth.js';
import { createCodexCredentialRuntimeStateStore } from '../runtime/responses/codexCredentialRuntimeState.js';
import { GrokCredentialManager } from '../runtime/responses/grokCredentialManager.js';
import { GrokDeviceAuthService } from '../runtime/responses/grokOAuth.js';
import { GrokOAuthClient } from '../runtime/responses/grokOAuthClient.js';
import { GrokModelCatalogService } from '../runtime/responses/grokModelCatalog.js';
export async function createModelSubscriptionRuntime(options: {
  config: AppConfig;
  secretVault: SecretVault;
  pool?: PgEventStore['pool'];
  egressFetch: typeof fetch;
}) {
  const { config, secretVault, pool, egressFetch } = options;
  const codexCredentialManager = new CodexCredentialManager({
    vault: secretVault,
    getConfig: () => config.codexSubscription,
    ...(pool ? { lock: new PgCodexCredentialLock(pool) } : {}),
    runtimeStateStore: await createCodexCredentialRuntimeStateStore(pool, config.runtimeEventStore),
    fetchImpl: egressFetch,
  });
  const codexDeviceAuthService = new CodexDeviceAuthService(egressFetch);
  const oauthClient = new GrokOAuthClient(egressFetch);
  const grokCredentialManager = new GrokCredentialManager({
    vault: secretVault,
    getConfig: () => config.grokSubscription,
    ...await createGrokCredentialPersistence(pool, config.runtimeEventStore),
    oauthClient,
    requireRotationCoordinator: readRuntimeIdentity().environment === 'production',
  });
  const grokDeviceAuthService = new GrokDeviceAuthService(oauthClient);
  const grokModelCatalog = new GrokModelCatalogService(grokCredentialManager, egressFetch);
  return {
    codexCredentialManager,
    codexDeviceAuthService,
    grokCredentialManager,
    grokDeviceAuthService,
    grokModelCatalog,
    factoryDependencies: {
      codexCredentialManager,
      codexFetch: egressFetch,
      grokCredentialManager,
      grokFetch: egressFetch,
      grokModelCatalog,
    },
  };
}

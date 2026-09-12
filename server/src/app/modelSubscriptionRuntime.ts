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
import { GrokProtocolError } from '../runtime/responses/grokProtocol.js';
export async function createModelSubscriptionRuntime(options: {
  config: AppConfig;
  secretVault: SecretVault;
  pool?: PgEventStore['pool'];
  egressFetch: typeof fetch;
}) {
  const { config, secretVault, pool, egressFetch } = options;
  const production = readRuntimeIdentity().environment === 'production';
  const getGrokConfig = () => {
    if (production && !pool && config.grokSubscription?.enabled === true) {
      throw new GrokProtocolError('shared_postgres_runtime_required', 503);
    }
    return config.grokSubscription;
  };
  // A disabled/unconfigured provider remains backwards compatible, but hot enablement
  // must not silently create a separate cooldown/refresh authority in each process.
  getGrokConfig();
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
    getConfig: getGrokConfig,
    ...(await createGrokCredentialPersistence(pool, config.runtimeEventStore)),
    oauthClient,
    requireRotationCoordinator: production,
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

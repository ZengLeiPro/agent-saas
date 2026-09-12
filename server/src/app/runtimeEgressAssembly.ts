import { join } from 'node:path';

import { EgressConfigStore } from '../data/egressConfig.js';
import { readRuntimeIdentity } from '../release/runtimeIdentity.js';
import {
  EgressDispatcherRegistry,
  createEgressFetch,
  createEgressWebSocketConnector,
  createWebToolEgressFetch,
  installStagingGlobalEgressFetch,
} from '../runtime/egressDispatcher.js';
import type { EgressConfig } from '../runtime/egressPolicy.js';
import type { SecretVault } from '../security/secretVault.js';
import type { AppConfig } from '../types/index.js';
import { serverLogger } from '../utils/logger.js';

export function initializeRuntimeEgress(input: {
  processCwd: string;
  config: AppConfig;
  secretVault?: SecretVault;
}) {
  const runtimeEnvironment = readRuntimeIdentity().environment;
  const egressConfigStore = new EgressConfigStore(
    join(input.processCwd, 'data', 'egress-config.json'),
    input.config.egress as EgressConfig | undefined,
    runtimeEnvironment,
  );
  const egressLogger = serverLogger.child('Egress');
  let egressProxyCredential: string | undefined;
  let credentialRefresh = Promise.resolve();
  const refreshEgressProxyCredential = (): Promise<void> => {
    credentialRefresh = credentialRefresh.then(async () => {
      const ref = egressConfigStore.getProxyCredentialRef();
      if (!ref || !input.secretVault) {
        egressProxyCredential = undefined;
        return;
      }
      try {
        egressProxyCredential = await input.secretVault.getSecret(ref, {
          actor: 'system',
          userId: '__system__',
          scopes: ['secret:egress-proxy:read'],
        });
      } catch (error) {
        egressProxyCredential = undefined;
        egressLogger.warn(
          `代理凭据解析失败，按无凭据处理: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
    return credentialRefresh;
  };
  void refreshEgressProxyCredential();
  const egressDispatchers = new EgressDispatcherRegistry(
    {
      getConfig: () => egressConfigStore.getConfig(),
      getConfigVersion: () => egressConfigStore.getConfigVersion(),
      getProxyCredential: () => egressProxyCredential,
      refresh: async () => {
        if (egressConfigStore.refreshIfChanged()) await refreshEgressProxyCredential();
        else await credentialRefresh;
      },
    },
    egressLogger,
  );
  const egressFetch = createEgressFetch(egressDispatchers, egressLogger);
  const restoreGlobalEgressFetch = installStagingGlobalEgressFetch(runtimeEnvironment, egressFetch);
  return {
    egressConfigStore,
    refreshEgressProxyCredential,
    egressDispatchers,
    egressFetch,
    webToolEgressFetch: createWebToolEgressFetch(egressDispatchers, egressLogger),
    egressWebSocketConnector: createEgressWebSocketConnector(egressDispatchers, egressLogger),
    restoreGlobalEgressFetch,
  };
}

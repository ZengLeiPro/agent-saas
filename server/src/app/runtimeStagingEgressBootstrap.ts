import type { AppConfig } from '../types/index.js';
import { readRuntimeIdentity } from '../release/runtimeIdentity.js';
import {
  EgressDispatcherRegistry,
  createEgressFetch,
  installStagingGlobalEgressFetch,
  type EgressDispatcherLogger,
  type GlobalFetchTarget,
} from '../runtime/egressDispatcher.js';
import { isStagingServerEgressSafe, type EgressConfig } from '../runtime/egressPolicy.js';

export interface RuntimeStagingEgressBootstrapOptions {
  environment?: string;
  target?: GlobalFetchTarget;
  baseFetch?: typeof fetch;
  proxyFetch?: Parameters<typeof createEgressFetch>[3];
  logger?: EgressDispatcherLogger;
}

export interface RuntimeStagingEgressBootstrap {
  fetchImpl?: typeof fetch;
  shutdown(): Promise<void>;
}

let activeBootstrap: RuntimeStagingEgressBootstrap | undefined;

function currentRuntimeEnvironment(): string | undefined {
  try {
    return readRuntimeIdentity().environment;
  } catch {
    // The authoritative config startup assertion reports invalid identities.
    return undefined;
  }
}

/**
 * Install the Staging fail-closed fetch before any credential adapter is built.
 * This bootstrap deliberately has no Vault-backed proxy credential: otherwise
 * reaching the Vault would itself depend on first reaching the Vault.
 */
export function installRuntimeStagingEgressBootstrap(
  config: AppConfig,
  options: RuntimeStagingEgressBootstrapOptions = {},
): RuntimeStagingEgressBootstrap {
  const environment = options.environment ?? currentRuntimeEnvironment();
  if (environment !== 'staging') return { shutdown: async () => undefined };
  if (activeBootstrap) return activeBootstrap;

  const egressConfig = config.egress as EgressConfig | undefined;
  if (!egressConfig || !isStagingServerEgressSafe(egressConfig)) {
    throw new Error('staging bootstrap egress must be full-proxy and fail-closed');
  }

  const logger = options.logger ?? { warn: () => undefined };
  const registry = new EgressDispatcherRegistry(
    {
      getConfig: () => egressConfig,
      getConfigVersion: () => 0,
    },
    logger,
  );
  const target = options.target ?? globalThis;
  const guardedFetch = createEgressFetch(
    registry,
    logger,
    options.baseFetch ?? target.fetch,
    options.proxyFetch,
  );
  const restore = installStagingGlobalEgressFetch(environment, guardedFetch, target);
  let closed = false;

  activeBootstrap = {
    fetchImpl: guardedFetch,
    shutdown: async () => {
      if (closed) return;
      closed = true;
      restore();
      await registry.close();
    },
  };
  return activeBootstrap;
}

export async function shutdownRuntimeStagingEgressBootstrap(): Promise<void> {
  const bootstrap = activeBootstrap;
  activeBootstrap = undefined;
  await bootstrap?.shutdown();
}

export async function shutdownRuntimeEgress(
  restoreGlobalFetch: () => void,
  registry: EgressDispatcherRegistry,
  mcpManager: { shutdown(): Promise<void> },
): Promise<void> {
  restoreGlobalFetch();
  await Promise.all([
    registry.close(),
    mcpManager.shutdown(),
    shutdownRuntimeStagingEgressBootstrap(),
  ]);
}

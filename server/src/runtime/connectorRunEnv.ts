import { resolve } from 'path';

import { buildIsolatedGitCredentialEnv } from '../security/gitCredentialIsolation.js';

export interface ConnectorRuntimeIdentity {
  userId: string;
  username: string;
  tenantId: string;
}

export interface ConnectorRuntimeEnvResolverConfig {
  resolveConnectorRuntimeEnv?: (identity: ConnectorRuntimeIdentity) => Promise<Record<string, string>>;
}

export async function buildConnectorRunEnv(
  config: ConnectorRuntimeEnvResolverConfig,
  identity: { id?: string; userId?: string; username?: string; tenantId?: string },
): Promise<Record<string, string>> {
  const userId = identity.id ?? identity.userId;
  if (!userId || !identity.username || !identity.tenantId) return {};
  const connectorEnv = config.resolveConnectorRuntimeEnv
    ? await config.resolveConnectorRuntimeEnv({
        userId,
        username: identity.username,
        tenantId: identity.tenantId,
      })
    : {};
  return {
    ...connectorEnv,
    ...buildIsolatedGitCredentialEnv({
      tokenCommand: `printf '%s' "\${GH_TOKEN:-\${GITHUB_TOKEN:-}}"`,
      credentialAvailable: Boolean(connectorEnv.GH_TOKEN || connectorEnv.GITHUB_TOKEN),
      allowGhCli: true,
      ghConfigDir: resolve('/tmp', `gh-${identity.username}`),
    }),
  };
}

export async function reconcileConnectorRunEnv(
  config: ConnectorRuntimeEnvResolverConfig,
  input: {
    identity: { id?: string; userId?: string; username?: string; tenantId?: string };
    env?: Record<string, string>;
    resolvedFor?: ConnectorRuntimeIdentity;
    injectedKeys?: string[];
  },
): Promise<Record<string, string>> {
  const userId = input.identity.id ?? input.identity.userId;
  const sameOwner = Boolean(
    userId
    && input.identity.username
    && input.identity.tenantId
    && input.resolvedFor?.userId === userId
    && input.resolvedFor.username === input.identity.username
    && input.resolvedFor.tenantId === input.identity.tenantId,
  );
  const env = { ...input.env };
  if (sameOwner) return env;
  for (const key of input.injectedKeys ?? []) delete env[key];
  return {
    ...env,
    ...await buildConnectorRunEnv(config, input.identity),
  };
}

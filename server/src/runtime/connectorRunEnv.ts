import { resolve } from 'path';

import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import { buildIsolatedGitCredentialEnv } from '../security/gitCredentialIsolation.js';

export interface ConnectorRuntimeEnvResolverConfig {
  resolveConnectorRuntimeEnv?: (identity: {
    username: string;
    tenantId: string;
  }) => Promise<Record<string, string>>;
}

export async function buildConnectorRunEnv(
  config: ConnectorRuntimeEnvResolverConfig,
  identity: { username?: string; tenantId?: string },
): Promise<Record<string, string>> {
  if (!identity.username) return {};
  const connectorEnv = config.resolveConnectorRuntimeEnv
    ? await config.resolveConnectorRuntimeEnv({
        username: identity.username,
        tenantId: identity.tenantId ?? DEFAULT_TENANT_ID,
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

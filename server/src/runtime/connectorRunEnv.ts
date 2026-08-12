import { resolve } from 'path';

import { buildIsolatedGitCredentialEnv } from '../security/gitCredentialIsolation.js';
import type { FeishuTokenBrokerLike } from '../feishu/tokenBroker.js';
import type { ConnectorConnectionStore } from '../connectors/connectionStore.js';
import { pausedWorkspaceCliEnv } from '../connectors/runtimeState.js';

export interface ConnectorRuntimeIdentity {
  userId: string;
  username: string;
  tenantId: string;
}

export interface ConnectorRuntimeEnvResolverConfig {
  resolveConnectorRuntimeEnv?: (identity: ConnectorRuntimeIdentity) => Promise<Record<string, string>>;
}

export function resolveDwsConnectorRunEnv(
  connectionStore: ConnectorConnectionStore,
  identity: ConnectorRuntimeIdentity,
): Record<string, string> {
  return connectionStore.isRuntimeEnabled(identity.username, 'dws')
    ? {}
    : pausedWorkspaceCliEnv('dws', identity.userId);
}

export async function resolveFeishuConnectorRunEnv(
  broker: FeishuTokenBrokerLike | undefined,
  identity: ConnectorRuntimeIdentity,
  onError?: (error: Error) => void,
  connectionStore?: ConnectorConnectionStore,
): Promise<Record<string, string>> {
  if (connectionStore && !connectionStore.isRuntimeEnabled(identity.username, 'feishu')) {
    return pausedWorkspaceCliEnv('feishu', identity.userId);
  }
  if (!broker) return {};
  try {
    const token = await broker.ensureFresh(identity);
    return {
      LARKSUITE_CLI_APP_ID: token.appId,
      LARKSUITE_CLI_USER_ACCESS_TOKEN: token.accessToken,
    };
  } catch (error) {
    onError?.(error instanceof Error ? error : new Error(String(error)));
    return {};
  }
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

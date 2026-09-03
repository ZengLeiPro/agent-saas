import type { ServerRemoteDispatchConfig } from '../runtime/rawRuntimeRunDispatchTypes.js';
import type { SecretVault } from '../security/secretVault.js';
import type { ServerRemoteConfig } from './config.js';

const SERVER_REMOTE_VAULT_CALLER = {
  actor: 'system' as const,
  userId: '__system__',
  scopes: ['secret:server_remote:read'],
};

export async function resolveServerRemoteDispatchConfig(
  config: ServerRemoteConfig | undefined,
  vault: SecretVault,
): Promise<ServerRemoteDispatchConfig | undefined> {
  if (!config) return undefined;
  let authToken: string | undefined;
  if (config.authTokenRef) {
    try {
      authToken = await vault.getSecret(config.authTokenRef, SERVER_REMOTE_VAULT_CALLER);
    } catch (error) {
      throw new Error(
        `serverRemote.authTokenRef "${config.authTokenRef}" 解析失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else if (config.authToken) {
    authToken = config.authToken;
  }
  if (!authToken) {
    throw new Error('serverRemote 凭证解析失败：authToken/authTokenRef 都为空（schema 应已拦截）');
  }
  return {
    baseUrl: config.baseUrl,
    authToken,
    ...(config.authTokenRef ? { authTokenRef: config.authTokenRef } : {}),
    ...(config.invokeTimeoutMs !== undefined ? { invokeTimeoutMs: config.invokeTimeoutMs } : {}),
  };
}

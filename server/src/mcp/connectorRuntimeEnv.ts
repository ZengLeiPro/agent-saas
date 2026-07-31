import type {
  McpConfigStore,
  McpSecretRequirement,
  ManagedMcpServer,
} from '../data/mcpConfig.js';
import type { McpOAuthService } from './oauthService.js';
import type { SecretVault, VaultCaller } from '../security/secretVault.js';

const RUNTIME_ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

export interface ConnectorRuntimeEnvResolverOptions {
  store: McpConfigStore;
  vault: SecretVault;
  oauthService?: McpOAuthService;
  onError?: (error: Error, context: { serverId: string; source: 'secret' | 'oauth' }) => void;
  /** 凭据已由原生 Connector 接管的 MCP adapter。 */
  excludedServerIds?: ReadonlySet<string>;
}

export interface ConnectorRuntimeEnvContext {
  username: string;
  tenantId: string;
}

export async function resolveConnectorRuntimeEnv(
  options: ConnectorRuntimeEnvResolverOptions,
  context: ConnectorRuntimeEnvContext,
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  const servers = options.store.getEffectiveServers(context.username, context.tenantId);

  for (const server of servers) {
    if (options.excludedServerIds?.has(server.id)) continue;
    try {
      await applySecretRuntimeEnv(options, context, server, env);
    } catch (error) {
      options.onError?.(toError(error), { serverId: server.id, source: 'secret' });
    }
    try {
      await applyOAuthRuntimeEnv(options, context, server, env);
    } catch (error) {
      options.onError?.(toError(error), { serverId: server.id, source: 'oauth' });
    }
  }

  return env;
}

async function applySecretRuntimeEnv(
  options: ConnectorRuntimeEnvResolverOptions,
  context: ConnectorRuntimeEnvContext,
  server: ManagedMcpServer,
  env: Record<string, string>,
): Promise<void> {
  for (const requirement of server.secretRequirements ?? []) {
    const names = runtimeEnvNames([
      ...(requirement.target === 'env' ? [requirement.name] : []),
      ...(requirement.runtimeEnv ?? []),
    ]);
    if (names.length === 0) continue;
    const ref = resolveRequirementRef(options.store, context, server, requirement);
    if (!ref) continue;
    const value = await options.vault.getSecret(ref, vaultCaller(context));
    for (const name of names) env[name] = value;
  }
}

async function applyOAuthRuntimeEnv(
  options: ConnectorRuntimeEnvResolverOptions,
  context: ConnectorRuntimeEnvContext,
  server: ManagedMcpServer,
  env: Record<string, string>,
): Promise<void> {
  const names = runtimeEnvNames(
    'url' in server.config ? server.config.oauth?.runtimeEnv : undefined,
  );
  if (names.length === 0 || !options.oauthService) return;
  const accessToken = await options.oauthService.runtimeAccessToken({
    username: context.username,
    tenantId: context.tenantId,
    serverId: server.id,
  });
  if (!accessToken) return;
  for (const name of names) env[name] = accessToken;
}

function resolveRequirementRef(
  store: McpConfigStore,
  context: ConnectorRuntimeEnvContext,
  server: ManagedMcpServer,
  requirement: McpSecretRequirement,
): string | undefined {
  if (requirement.scope === 'user') {
    return store.getUserConfig(context.username).secretRefs?.[server.id]?.[requirement.key];
  }
  return server.secretRefs?.[requirement.key];
}

function runtimeEnvNames(names: string[] | undefined): string[] {
  return [...new Set((names ?? []).map((name) => name.trim()).filter((name) => RUNTIME_ENV_NAME_RE.test(name)))];
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function vaultCaller(context: ConnectorRuntimeEnvContext): VaultCaller {
  return {
    actor: 'mcp_proxy',
    userId: context.username,
    tenantId: context.tenantId,
    scopes: ['secret:mcp:read', 'secret:mcp_oauth:read'],
  };
}

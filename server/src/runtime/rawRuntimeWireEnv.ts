import type { WorkspaceRef } from '../agent/toolRuntime.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import { resolveAzerothInjection } from '../integrations/azeroth/tokens.js';

/** 只把明确允许的 Azeroth 凭据装配到 tenant-remote Hand。 */
export function buildTenantRemoteHandWireEnv(workspace: WorkspaceRef): Record<string, string> {
  const tenantId = workspace.tenantId ?? DEFAULT_TENANT_ID;
  const env: Record<string, string> = {};
  const username = workspace.username;
  if (username) {
    const injection = resolveAzerothInjection(tenantId, username);
    if (injection) {
      env.AZEROTH_TOKEN = injection.token;
      if (injection.apiUrl) env.AZEROTH_API_URL = injection.apiUrl;
    }
  }
  return env;
}

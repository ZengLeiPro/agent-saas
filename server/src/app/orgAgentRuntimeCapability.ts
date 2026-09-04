import type { AgentDwsAccountRecord } from '../data/agentDwsAccounts/index.js';
import { principalFor } from '../dws/agentAuthFlow.js';
import { HttpTransport, supportsSharedReadOnlyMount } from '../runtime/httpTransport.js';
import type { ConnectorServerRemoteResolver } from './agentDwsRuntime.js';

const DEFAULT_CAPABILITY_TTL_MS = 5_000;

export function createOrgAgentRuntimeCapabilityProbe(options: {
  isRuntimeWorkerV2Ready: () => boolean;
  resolveServerRemote: ConnectorServerRemoteResolver;
  ttlMs?: number;
  createTransport?: (
    remote: Awaited<ReturnType<ConnectorServerRemoteResolver>>,
  ) => Pick<HttpTransport, 'health'>;
}) {
  let cached: { key: string; ready: boolean; expiresAt: number } | undefined;
  return async (account: AgentDwsAccountRecord): Promise<boolean> => {
    if (!options.isRuntimeWorkerV2Ready()) return false;
    try {
      const remote = await options.resolveServerRemote(principalFor(account));
      const key = remote.baseUrl.replace(/\/$/u, '');
      const now = Date.now();
      if (cached?.key === key && cached.expiresAt > now) return cached.ready;
      const transport = options.createTransport?.(remote) ?? new HttpTransport(remote);
      const health = await transport.health();
      const ready = health.status === 'ok' && supportsSharedReadOnlyMount(health.metadata);
      cached = {
        key,
        ready,
        expiresAt: now + Math.max(0, options.ttlMs ?? DEFAULT_CAPABILITY_TTL_MS),
      };
      return ready;
    } catch {
      return false;
    }
  };
}

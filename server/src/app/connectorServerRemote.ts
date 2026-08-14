import type { DwsWorkspacePrincipal } from '../dws/authFlow.js';

interface ConnectorServerRemote {
  baseUrl: string;
  authToken: string;
  invokeTimeoutMs?: number;
}

export function hasAcsConnector(hands: Array<{
  id: string;
  rollout?: { mode?: string };
}> | undefined): boolean {
  return hands?.some(hand => (hand.id === 'agent-saas-acs' || /acs/i.test(hand.id))
    && hand.rollout?.mode !== 'disabled'
    && hand.rollout?.mode !== 'drain') ?? false;
}

export function createConnectorServerRemoteResolver<T extends { id: string }>(options: {
  defaultRemote?: ConnectorServerRemote;
  eligibleHands(principal: DwsWorkspacePrincipal): T[];
  resolveHand(hand: T): Promise<ConnectorServerRemote>;
}): (principal: DwsWorkspacePrincipal) => Promise<ConnectorServerRemote> {
  return async principal => {
    if (options.defaultRemote) return options.defaultRemote;
    const eligible = options.eligibleHands(principal);
    const hand = eligible.find(candidate => candidate.id === 'agent-saas-acs')
      ?? eligible.find(candidate => /acs/i.test(candidate.id));
    if (!hand) throw new Error(`用户 ${principal.id} 没有可用的 ACS 连接器执行环境`);
    return options.resolveHand(hand);
  };
}

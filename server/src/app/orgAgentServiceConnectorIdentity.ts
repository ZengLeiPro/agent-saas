import {
  hasExactAgentDwsProfile,
  type AgentDwsAccountStore,
} from '../data/agentDwsAccounts/index.js';
import type { OrgAgentStore } from '../data/orgAgents/store.js';
import type { UserStore } from '../data/users/store.js';

export interface RunScopedConnectorIdentity {
  userId: string;
  username: string;
  tenantId: string;
}

export async function resolveRunScopedConnectorIdentity(
  context: RunScopedConnectorIdentity,
  userStore?: UserStore,
  orgAgentStore?: OrgAgentStore,
  accountStore?: AgentDwsAccountStore,
): Promise<RunScopedConnectorIdentity | undefined> {
  const owner = userStore?.findByUsername(context.username);
  if (owner) {
    return !owner.disabled && owner.id === context.userId && owner.tenantId === context.tenantId
      ? context
      : undefined;
  }
  const serviceShaped =
    context.username.startsWith('agent-dws:') || context.userId.startsWith('adws-');
  if (!serviceShaped) return userStore ? undefined : context;
  if (
    !userStore ||
    !orgAgentStore ||
    !accountStore ||
    !context.username.startsWith('agent-dws:') ||
    !context.userId.startsWith('adws-')
  )
    return undefined;
  const agentId = context.username.slice('agent-dws:'.length);
  const accountId = context.userId.slice('adws-'.length);
  const [agent, account] = await Promise.all([
    Promise.resolve(orgAgentStore?.get(agentId)),
    accountStore.getForTenant(context.tenantId, accountId),
  ]);
  return agent?.enabled &&
    agent.tenantId === context.tenantId &&
    account?.status === 'active' &&
    account.agentId === agentId &&
    hasExactAgentDwsProfile(account)
    ? context
    : undefined;
}

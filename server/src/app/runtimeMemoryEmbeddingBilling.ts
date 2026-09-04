import { relative, resolve, sep } from 'node:path';
import type { BillingService } from '../data/billing/service.js';
import { TENANT_SLUG_PATTERN } from '../data/tenants/types.js';
import type { UserStore } from '../data/users/store.js';

export function createMemoryEmbeddingBillingRunStarter(input: {
  agentCwd: string;
  getBillingService(): BillingService | undefined;
  userStore?: UserStore;
}) {
  return async (workspaceDir: string) => {
    const billingService = input.getBillingService();
    if (!billingService) return undefined;
    const rel = relative(input.agentCwd, resolve(workspaceDir));
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) return undefined;
    const [tenantId, userId] = rel.split(sep);
    if (!tenantId || !userId || !TENANT_SLUG_PATTERN.test(tenantId)) return undefined;
    const user = input.userStore?.findById(userId);
    return await billingService.beginUtilityModelRun({
      tenantId,
      userId,
      username: user?.username ?? userId,
      channel: 'memory_embedding',
    });
  };
}

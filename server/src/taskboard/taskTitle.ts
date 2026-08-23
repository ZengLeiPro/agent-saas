import { randomUUID } from 'node:crypto';

import {
  generateTitleWithFallback,
  type TitleGeneratorConfig,
  type TitleModelAdapterFactory,
} from '../agent/titleGenerator.js';
import type { BillingService } from '../data/billing/service.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import type { TokenUsageStore } from '../data/usage/store.js';
import { resolveUserCwd } from '../workspace/resolver.js';
import type { TaskboardIdentity } from './types.js';

export interface TaskboardTitleGeneratorOptions {
  agentCwd?: string;
  titleGeneratorConfigs?: TitleGeneratorConfig[];
  titleModelAdapterFactory?: TitleModelAdapterFactory;
  refreshSharedConfig?: () => void;
  getTitleSystemPrompt?: () => string;
  tokenUsageStore?: TokenUsageStore;
  billingService?: BillingService;
}

export function createTaskboardTitleGenerator(options: TaskboardTitleGeneratorOptions) {
  return async (description: string, identity: TaskboardIdentity): Promise<string | null> => {
    options.refreshSharedConfig?.();
    if (!description.trim() || !options.agentCwd || !options.titleGeneratorConfigs?.length) return null;

    const sessionId = `task-title-${randomUUID()}`;
    let utilityBilling: Awaited<ReturnType<BillingService['beginUtilityModelRun']>> | undefined;

    try {
      utilityBilling = options.billingService
        ? await options.billingService.beginUtilityModelRun({
            tenantId: identity.tenantId || DEFAULT_TENANT_ID,
            userId: identity.ownerUserId,
            username: identity.username,
            sessionId,
            channel: 'title',
          })
        : undefined;
      return await generateTitleWithFallback(
        description,
        '',
        options.titleGeneratorConfigs,
        undefined,
        undefined,
        {
          systemPrompt: options.getTitleSystemPrompt?.(),
          modelAdapterFactory: options.titleModelAdapterFactory,
          runtimeContext: {
            sessionId,
            tenantId: identity.tenantId,
            cwd: resolveUserCwd(options.agentCwd, {
              id: identity.ownerUserId,
              tenantId: identity.tenantId,
              username: identity.username,
              role: identity.userRole ?? 'user',
            }),
          },
          beforeModelCall: () => utilityBilling?.beforeModelCall(),
          onUsage: async (model, usage) => {
            await utilityBilling?.recordUsage(model, usage);
            if (!options.tokenUsageStore) return;
            options.tokenUsageStore.recordResult({
              username: identity.username,
              tenantId: identity.tenantId || DEFAULT_TENANT_ID,
              channel: 'title',
              modelUsage: { [model]: usage },
              occurredAtMs: Date.now(),
            });
          },
        },
      );
    } catch {
      return null;
    } finally {
      await utilityBilling?.finalize();
    }
  };
}

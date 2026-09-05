import type { Express } from 'express';

import type { AdminConfigMutationService } from '../config/adminConfigMutationService.js';
import { createCodexSubscriptionAdminRouter } from '../routes/codexSubscriptionAdmin.js';
import { createProviderQuotaAdminRouter } from '../routes/providerQuotaAdmin.js';
import type { AppConfig } from './config.js';
import type { AppRuntime } from './runtimeContracts.js';

/** 模型供应商账号侧的平台管理接口：Codex 订阅授权 + 各家套餐额度。 */
export function registerModelProviderAdminRoutes(
  app: Express,
  runtime: AppRuntime,
  deps: {
    processCwd: string;
    config: AppConfig;
    configMutationService: AdminConfigMutationService;
  },
): void {
  app.use(
    '/api/admin/codex-subscription',
    createCodexSubscriptionAdminRouter({
      processCwd: deps.processCwd,
      config: deps.config,
      configMutationService: deps.configMutationService,
      credentialManager: runtime.codexCredentialManager,
      deviceAuthService: runtime.codexDeviceAuthService,
      closeWebSockets: (refs) =>
        refs && runtime.codexWebSocketCredentialShutdown
          ? runtime.codexWebSocketCredentialShutdown(refs)
          : runtime.codexWebSocketShutdown?.(),
    }),
  );
  app.use(
    '/api/admin/provider-quota',
    createProviderQuotaAdminRouter({ service: runtime.providerQuotaService }),
  );
}

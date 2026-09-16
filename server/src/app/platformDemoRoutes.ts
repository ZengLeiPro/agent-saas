import type { Express } from 'express';

import type { AppRuntime } from './runtime.js';
import {
  createPlatformDemoRouter,
  createRejectPlatformDemoProductionWrites,
} from '../platformDemo/index.js';
import {
  getPlatformDemoCapabilityStore,
  getPlatformDemoSessionStore,
} from '../platformDemo/runtimeStores.js';

/** Mount platform-demo sample-data routes and production-write guards. */
export function registerPlatformDemoRoutes(app: Express, runtime: AppRuntime): void {
  const capabilities = getPlatformDemoCapabilityStore();
  const sessions = getPlatformDemoSessionStore();
  app.use('/api', createRejectPlatformDemoProductionWrites({ capabilities }));
  if (!runtime.membershipStore) return;
  app.use(
    '/api/platform-demo',
    createPlatformDemoRouter({
      capabilities,
      sessions,
      getMembership: (tenantId, userId) => runtime.membershipStore!.getMembership(tenantId, userId),
      listMemberships: (tenantId) => runtime.membershipStore!.listMemberships(tenantId),
      audit: runtime.governanceAuditStore,
    }),
  );
}

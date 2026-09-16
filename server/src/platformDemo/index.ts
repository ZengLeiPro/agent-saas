export {
  PLATFORM_DEMO_BANNER,
  PLATFORM_DEMO_CAPABILITY,
  PLATFORM_DEMO_MENU_LABEL,
  isPlatformDemoFeatureEnabled,
  platformDemoSessionKey,
  type PlatformDemoAccess,
  type PlatformDemoCapability,
  type PlatformDemoCapabilityGrant,
  type PlatformDemoSessionDraft,
} from './types.js';
export {
  InMemoryPlatformDemoCapabilityStore,
  type PlatformDemoCapabilityStore,
} from './capabilityStore.js';
export {
  PgPlatformDemoCapabilityStore,
  type PgPlatformDemoCapabilityStoreOptions,
} from './pgCapabilityStore.js';
export {
  InMemoryPlatformDemoSessionStore,
  type PlatformDemoSessionStore,
} from './demoSessionStore.js';
export {
  PgPlatformDemoSessionStore,
  type PgPlatformDemoSessionStoreOptions,
} from './pgSessionStore.js';
export {
  platformDemoAnalyticsFixture,
  platformDemoConfigFixture,
  platformDemoConfigFixtures,
} from './fixtures.js';
export {
  PlatformDemoAccessError,
  assertPlatformAdminCanManageDemoGrants,
  platformDemoAccessErrorBody,
  resolvePlatformDemoAccess,
} from './auth.js';
export {
  assertDemoIdentityBlockedFromProductionWrite,
  createRejectPlatformDemoProductionWrites,
} from './rejectProductionAdminWrites.js';
export { createPlatformDemoRouter, type PlatformDemoRouterDeps } from './routes.js';

export {
  configurePlatformDemoRuntimeStores,
  getPlatformDemoCapabilityStore,
  getPlatformDemoSessionStore,
  resetPlatformDemoRuntimeStoresForTests,
} from './runtimeStores.js';

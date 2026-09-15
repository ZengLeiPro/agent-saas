import {
  InMemoryPlatformDemoCapabilityStore,
  type PlatformDemoCapabilityStore,
} from './capabilityStore.js';
import {
  InMemoryPlatformDemoSessionStore,
  type PlatformDemoSessionStore,
} from './demoSessionStore.js';

let capabilityStore: PlatformDemoCapabilityStore | undefined;
let sessionStore: PlatformDemoSessionStore | undefined;

export function getPlatformDemoCapabilityStore(): PlatformDemoCapabilityStore {
  if (!capabilityStore) capabilityStore = new InMemoryPlatformDemoCapabilityStore();
  return capabilityStore;
}

export function getPlatformDemoSessionStore(): PlatformDemoSessionStore {
  if (!sessionStore) sessionStore = new InMemoryPlatformDemoSessionStore();
  return sessionStore;
}

/** Wire PG-backed stores in production after governance migrations. */
export function configurePlatformDemoRuntimeStores(options: {
  capabilities: PlatformDemoCapabilityStore;
  sessions: PlatformDemoSessionStore;
}): void {
  capabilityStore = options.capabilities;
  sessionStore = options.sessions;
}

/** Test-only reset. */
export function resetPlatformDemoRuntimeStoresForTests(): void {
  capabilityStore = new InMemoryPlatformDemoCapabilityStore();
  sessionStore = new InMemoryPlatformDemoSessionStore();
}

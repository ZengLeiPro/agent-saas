import type pg from 'pg';
import {
  LocalSubscriptionCredentialLock,
  PgSubscriptionCredentialLock,
} from './subscriptionCredentialLock.js';
import { createSubscriptionCredentialRuntimeStateStore } from './subscriptionCredentialRuntimeState.js';
import { createGrokRefreshJournal } from './subscriptionRefreshJournal.js';
import { SubscriptionPgSessionContext } from './subscriptionPgSessionContext.js';
/** Pair a lock, state store, and journal so pool-starvation cannot break refresh coordination. */
export async function createGrokCredentialPersistence(
  pool: pg.Pool | undefined,
  config?: { backend: string; tablePrefix?: string },
) {
  const session = pool ? new SubscriptionPgSessionContext(pool) : undefined;
  const queryPool = session?.pool;
  return {
    lock:
      pool && session
        ? new PgSubscriptionCredentialLock(pool, session.run)
        : new LocalSubscriptionCredentialLock(),
    runtimeStateStore: await createSubscriptionCredentialRuntimeStateStore(
      queryPool,
      config,
      'grok',
    ),
    refreshJournal: await createGrokRefreshJournal(
      queryPool,
      config?.backend === 'pg' ? config.tablePrefix : undefined,
    ),
  };
}

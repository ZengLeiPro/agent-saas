import { AsyncLocalStorage } from 'node:async_hooks';
import type pg from 'pg';
import type { PgLockPool, PgSubscriptionLockScope } from './subscriptionCredentialLock.js';
type LockClient = Awaited<ReturnType<PgLockPool['connect']>>;
/** Only queries made in this provider's locked async scope reuse its checked-out client. */
export class SubscriptionPgSessionContext {
  private readonly storage = new AsyncLocalStorage<LockClient>();
  readonly pool: pg.Pool;
  readonly run: PgSubscriptionLockScope = (client, action) => this.storage.run(client, action);
  constructor(pool: pg.Pool) {
    this.pool = new Proxy(pool, {
      get: (target, key) => {
        if (key === 'query')
          return (...args: unknown[]) => {
            const session = this.storage.getStore() ?? target;
            return Reflect.apply(session.query, session, args);
          };
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
}

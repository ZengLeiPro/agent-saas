import {
  type GovernanceProjectionOutboxItem,
  type GovernanceProjectionOutboxStore,
  type GovernanceProjectorMap,
} from './types.js';

const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,119}$/;

function stableErrorCode(error: unknown): string {
  if (error && typeof error === 'object') {
    for (const key of ['errorCode', 'code'] as const) {
      const value = (error as Record<string, unknown>)[key];
      if (typeof value === 'string' && ERROR_CODE_PATTERN.test(value)) return value;
    }
  }
  if (error instanceof Error && ERROR_CODE_PATTERN.test(error.message)) return error.message;
  return 'GOVERNANCE_PROJECTION_FAILED';
}

export interface GovernanceProjectionReconcilerOptions {
  store: GovernanceProjectionOutboxStore;
  projectors: GovernanceProjectorMap;
  workerId: string;
  leaseMs?: number;
  batchSize?: number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  now?: () => Date;
  executeFenced?: (
    item: GovernanceProjectionOutboxItem,
    operation: () => Promise<void>,
  ) => Promise<void>;
}

export class GovernanceProjectionReconciler {
  private readonly leaseOwner: string;
  private readonly leaseMs: number;
  private readonly batchSize: number;
  private readonly baseRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly now: () => Date;

  constructor(private readonly options: GovernanceProjectionReconcilerOptions) {
    if (!options.workerId.trim()) throw new Error('GOVERNANCE_PROJECTION_INVALID');
    this.leaseOwner = options.workerId;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.batchSize = options.batchSize ?? 25;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 1_000;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 5 * 60_000;
    this.now = options.now ?? (() => new Date());
    if (![this.leaseMs, this.batchSize, this.baseRetryDelayMs, this.maxRetryDelayMs]
      .every(value => Number.isInteger(value) && value > 0)) {
      throw new Error('GOVERNANCE_PROJECTION_INVALID');
    }
  }

  async reconcileOne(): Promise<GovernanceProjectionOutboxItem | null> {
    const claimed = await this.options.store.claim({
      leaseOwner: this.leaseOwner,
      leaseMs: this.leaseMs,
      limit: 1,
    });
    return claimed[0] ? this.execute(claimed[0]) : null;
  }

  async reconcileBatch(limit = this.batchSize): Promise<GovernanceProjectionOutboxItem[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('GOVERNANCE_PROJECTION_INVALID');
    }
    const claimed = await this.options.store.claim({
      leaseOwner: this.leaseOwner,
      leaseMs: this.leaseMs,
      limit,
    });
    return Promise.all(claimed.map(item => this.execute(item)));
  }

  private async execute(item: GovernanceProjectionOutboxItem): Promise<GovernanceProjectionOutboxItem> {
    const lease = {
      outboxId: item.outboxId,
      leaseOwner: this.leaseOwner,
      leaseFence: item.leaseFence,
    };
    const projector = this.options.projectors[item.projector];
    const heartbeat = setInterval(() => {
      void this.options.store.renewLease({ ...lease, leaseMs: this.leaseMs }).catch(() => false);
    }, Math.max(1, Math.floor(this.leaseMs / 3)));
    heartbeat.unref?.();
    try {
      if (!projector) throw { code: 'GOVERNANCE_PROJECTOR_MISSING' };
      const project = () => projector(item.payload, item);
      if (this.options.executeFenced) await this.options.executeFenced(item, project);
      else await project();
    } catch (error) {
      const terminal = item.attempt >= item.maxAttempts;
      const retryAt = terminal ? undefined : new Date(
        this.now().getTime() + this.retryDelayMs(item.attempt),
      ).toISOString();
      return this.options.store.fail({
        ...lease,
        errorCode: stableErrorCode(error),
        ...(retryAt ? { retryAt } : {}),
      });
    } finally {
      clearInterval(heartbeat);
    }
    return this.options.store.complete(lease);
  }

  private retryDelayMs(attempt: number): number {
    const exponent = Math.max(0, Math.min(30, attempt - 1));
    return Math.min(this.maxRetryDelayMs, this.baseRetryDelayMs * (2 ** exponent));
  }
}

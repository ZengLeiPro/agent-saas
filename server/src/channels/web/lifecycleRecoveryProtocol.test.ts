import { describe, expect, it } from 'vitest';
import { LifecycleRecoveryRequestLedger } from './lifecycleRecoveryProtocol.js';

describe('M50-05 recovery request protocol fence', () => {
  it('deduplicates requestId and replays the cached read response', () => {
    const ledger = new LifecycleRecoveryRequestLedger<{ seq: number }>();
    const request = { requestId: 'sync-1', networkGeneration: 4 };
    expect(ledger.admit(request)).toEqual({ status: 'fresh' });
    ledger.complete(request, { seq: 10 });
    expect(ledger.admit(request)).toEqual({ status: 'duplicate', response: { seq: 10 } });
  });

  it('rejects old wifi requests after a cellular generation is observed', () => {
    const ledger = new LifecycleRecoveryRequestLedger();
    expect(ledger.admit({ requestId: 'wifi', networkGeneration: 7 })).toEqual({ status: 'fresh' });
    expect(ledger.admit({ requestId: 'cell', networkGeneration: 8 })).toEqual({ status: 'fresh' });
    expect(ledger.admit({ requestId: 'late-wifi', networkGeneration: 7 }))
      .toEqual({ status: 'stale_generation', latestNetworkGeneration: 8 });
  });
});

import { describe, expect, it } from 'vitest';
import { canRunLegacyDwsListener, readDwsDeliveryProtocol, runnableDwsDeliverySql } from './deliveryProtocol.js';

describe('DWS reader-first protocol discrimination', () => {
  it('recognizes only genuinely absent old markers as legacy', () => {
    expect(readDwsDeliveryProtocol({ kinds: ['at_me'] })).toBe('legacy');
    expect(readDwsDeliveryProtocol({ deliveryProtocol: null })).toBe('unsupported');
    expect(readDwsDeliveryProtocol({ deliveryProtocol: 'future-v7' })).toBe('unsupported');
    expect(readDwsDeliveryProtocol([])).toBe('unsupported');
    expect(readDwsDeliveryProtocol({ deliveryProtocol: 'durable-v1' })).toBe('durable-v1');
  });
  it('excludes blocked, migrated and future accounts from both SQL selection and direct starts', () => {
    for (const deliveryProtocol of ['durable-v1', 'handoff_pending', 'unsupported', 'future-v7']) {
      expect(canRunLegacyDwsListener({ deliveryProtocol })).toBe(false);
    }
    expect(canRunLegacyDwsListener({ deliveryProtocol: 'legacy', identityCleanupPending: {} })).toBe(false);
    expect(runnableDwsDeliverySql()).toContain("->>'deliveryProtocol'='legacy'");
    expect(runnableDwsDeliverySql()).toContain('identityCleanupPending');
    expect(() => runnableDwsDeliverySql({ deliveryProtocol: 'injected' as 'legacy' })).toThrow();
  });
});

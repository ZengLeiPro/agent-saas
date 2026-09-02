import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  providerContractDigest,
  signTestEventReceipt,
  validateProviderContract,
  validateTestEventReceipt,
} from './mobile-telemetry-release-gate.mjs';

const fixture = JSON.parse(readFileSync(new URL('../telemetry/provider-contract.test-fixture.json', import.meta.url)));
const pending = JSON.parse(readFileSync(new URL('../telemetry/provider-contract.json', import.meta.url)));
const key = 'e'.repeat(32);
const release = 'b'.repeat(40);
function productionContract() {
  const value = structuredClone(fixture);
  delete value.exampleOnly;
  value.provider.environment = 'production';
  value.provider.release = release;
  value.sloPolicy.status = 'approved-by-fixture-owner';
  return value;
}
function receipt(contract) {
  const value = {
    schemaVersion: 1,
    release,
    environment: 'production',
    contractDigest: providerContractDigest(contract),
    dashboardId: contract.provider.dashboardId,
    alertPolicyId: contract.provider.alertPolicyId,
    testEvent: { kind: 'session_start', providerReceiptId: 'fixture-provider-receipt-123', observedAt: '2026-09-01T07:00:00.000Z' },
    signature: '',
  };
  value.signature = signTestEventReceipt(value, key);
  return value;
}

test('M60-05 production config fails closed for missing provider/owner/dashboard/alert/SLO facts', () => {
  assert.throws(() => validateProviderContract(pending, { production: true, release }), /missing or pending/);
  assert.throws(() => validateProviderContract(fixture, { production: true, release }), /test fixture/);
});

test('M60-05 explicitly-labelled test thresholds validate only as a non-production fixture', () => {
  assert.equal(validateProviderContract(fixture, { production: false, release }).exampleOnly, true);
});

test('M60-05 complete provider-neutral production facts and signed test-event receipt pass', () => {
  const contract = productionContract();
  validateProviderContract(contract, { production: true, release });
  assert.equal(validateTestEventReceipt(receipt(contract), contract, { release, key }).testEvent.kind, 'session_start');
});

test('M60-05 test-event receipt tamper/release/dashboard/replay substitution fails closed', () => {
  const contract = productionContract();
  const valid = receipt(contract);
  for (const mutate of [
    (value) => { value.release = 'c'.repeat(40); },
    (value) => { value.dashboardId = 'other-dashboard'; },
    (value) => { value.testEvent.providerReceiptId = 'substituted-receipt'; },
    (value) => { value.signature = `hmac-sha256:${'0'.repeat(64)}`; },
  ]) {
    const changed = structuredClone(valid);
    mutate(changed);
    assert.throws(() => validateTestEventReceipt(changed, contract, { release, key }));
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { safeComponentResults } from './promotion-diagnostics-scopes.mjs';
const scopes = () => ({
  acs: { rollbackAttempted: false, rollbackVerified: false, state: 'target' },
  app: { rollbackAttempted: false, rollbackVerified: false, state: 'before' },
  web: { rollbackAttempted: true, rollbackVerified: true, state: 'before' },
});
test('scoped diagnostic projection retains partial update without exporting arbitrary data', () => {
  const value = scopes();
  value.acs.credentials = 'PRIVATE'; value.private = 'PRIVATE';
  assert.deepEqual(safeComponentResults(value), scopes());
  assert.doesNotMatch(JSON.stringify(safeComponentResults(value)), /PRIVATE/);
});
for (const scope of ['acs', 'app', 'web']) {
  for (const mode of ['missing', 'contradiction', 'wrong-type', 'unknown-state']) {
    test(`scoped diagnostics refuse ${scope} ${mode} instead of manufacturing rollback success`, () => {
      const value = scopes();
      if (mode === 'missing') delete value[scope];
      if (mode === 'contradiction') value[scope] = { rollbackAttempted: false, rollbackVerified: true, state: 'before' };
      if (mode === 'wrong-type') value[scope].rollbackAttempted = 'false';
      if (mode === 'unknown-state') value[scope].state = 'SECRET_STATE';
      assert.equal(safeComponentResults(value), null);
    });
  }
}
test('absence and invalid collection types remain unknown', () => {
  for (const value of [null, undefined, [], 1, 'PRIVATE', {}]) assert.equal(safeComponentResults(value), null);
});

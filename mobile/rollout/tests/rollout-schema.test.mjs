import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '../../..');

test('machine schemas and canonical/test policies are parseable JSON', async () => {
  for (const file of [
    'mobile/rollout/schema/rollout-policy.schema.json',
    'mobile/rollout/schema/gate-input.schema.json',
    'mobile/rollout/schema/stage-receipt.schema.json',
    'mobile/rollout/rollout-policy.json',
    'mobile/rollout/fixtures/rollout-policy.test-fixture.json',
  ]) {
    const source = await readFile(path.join(root, file), 'utf8');
    assert.doesNotThrow(() => JSON.parse(source), file);
  }
});

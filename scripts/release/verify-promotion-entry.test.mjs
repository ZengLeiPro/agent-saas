import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { verifyPromotionEntry } from './verify-promotion-entry.mjs';

const fixturePath = 'scripts/release/fixtures/manifest-v1-runtime-deploy.json';

async function historicalV1() {
  return JSON.parse(await readFile(fixturePath, 'utf8'));
}

test('rejects a real historical v1 RC before App or ACS Runtime deployment', async () => {
  const manifest = await historicalV1();
  assert.equal(manifest.releaseId, 'rc-20260829-25');
  assert.throws(
    () => verifyPromotionEntry(manifest),
    /Historical Manifest v1 cannot deploy Runtime components \(api, runtimeWorker, acs\)/u,
  );
});

test('allows v1 evidence verification only when all Runtime components stay frozen', async () => {
  const manifest = await historicalV1();
  for (const component of ['api', 'runtimeWorker', 'acs']) {
    manifest.components[component].action = 'keep';
  }
  assert.deepEqual(verifyPromotionEntry(manifest), { schemaVersion: 1, runtimeDeploys: [] });
});

test('allows v2 Runtime deploys whose identity and managed units are RC-bound', async () => {
  const manifest = await historicalV1();
  manifest.schemaVersion = 2;
  assert.deepEqual(verifyPromotionEntry(manifest), {
    schemaVersion: 2,
    runtimeDeploys: ['api', 'runtimeWorker', 'acs'],
  });
});

import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writeOperationReceipt } from './write-operation-receipt.mjs';

test('writes an immutable component receipt bound to the Manifest target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'operation-receipt-'));
  const digest = `sha256:${'a'.repeat(64)}`;
  const manifest = join(root, 'manifest.json');
  await writeFile(
    manifest,
    JSON.stringify({
      releaseId: 'rc-20260827-01',
      digest,
      components: { web: { action: 'deploy', sourceSha: 'b'.repeat(40), artifactDigest: digest } },
    }),
  );
  const options = {
    manifest,
    digest,
    component: 'web',
    outcome: 'succeeded',
    operation: 'run-1-attempt-1',
    actor: 'release-bot',
    'recorded-at': '2026-08-27T00:00:00.000Z',
    output: join(root, 'receipts'),
  };
  const first = await writeOperationReceipt(options);
  const second = await writeOperationReceipt(options);
  assert.equal(second.digest, first.digest);
  await assert.rejects(writeOperationReceipt({ ...options, outcome: 'failed' }), /EEXIST|already/u);
});

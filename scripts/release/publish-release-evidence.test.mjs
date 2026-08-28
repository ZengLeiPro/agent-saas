import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createEvidenceService } from './evidence-service.mjs';
import { createValidReleaseEvidence } from './release-evidence-fixture.test-helper.mjs';
import { publishReleaseEvidence } from './publish-release-evidence.mjs';

const READ_TOKEN = 'automatic-evidence-read-token-32-bytes-long';
const WRITE_TOKEN = 'automatic-evidence-write-token-32-bytes-long';

test('publishes immutable evidence and verifies it with the separate read identity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'publish-evidence-'));
  const server = createEvidenceService({ root, readToken: READ_TOKEN, writeToken: WRITE_TOKEN });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const evidence = createValidReleaseEvidence();
  const actual = await publishReleaseEvidence({
    evidence,
    url: `http://127.0.0.1:${port}/release-evidence`,
    readToken: READ_TOKEN,
    writeToken: WRITE_TOKEN,
  });
  assert.deepEqual(actual, evidence);
});

test('rejects token reuse before sending evidence', async () => {
  await assert.rejects(
    publishReleaseEvidence({
      evidence: createValidReleaseEvidence(),
      url: 'https://evidence.example.test/release-evidence',
      readToken: READ_TOKEN,
      writeToken: READ_TOKEN,
    }),
    /Separate Release Evidence read and write tokens/u,
  );
});

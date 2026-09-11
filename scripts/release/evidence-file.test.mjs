import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readEvidenceFile, readEvidenceJson } from './evidence-file.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'bounded-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test('bounded evidence accepts exact bytes and rejects one byte over budget', async (t) => {
  const root = await fixture(t); const path = join(root, 'file');
  await writeFile(path, '1234'); assert.equal((await readEvidenceFile(path, 4)).toString(), '1234');
  await assert.rejects(readEvidenceFile(path, 3), /byte limit/u);
  for (const size of [0, -1, 4194305, NaN, Infinity])
    await assert.rejects(readEvidenceFile(path, size), /byte limit/u);
});
test('symlinks, directories and FIFO are rejected without following or blocking', async (t) => {
  const root = await fixture(t); const path = join(root, 'file');
  await writeFile(path, '{}'); await symlink(path, join(root, 'link'));
  await assert.rejects(readEvidenceJson(join(root, 'link')));
  await mkdir(join(root, 'directory'));
  await assert.rejects(readEvidenceFile(join(root, 'directory')), /regular file/u);
  const result = spawnSync('mkfifo', [join(root, 'fifo')]);
  assert.equal(result.status, 0);
  await assert.rejects(readEvidenceFile(join(root, 'fifo')), /regular file/u);
});
test('invalid JSON and UTF-8 fail without parser content disclosure', async (t) => {
  const root = await fixture(t); const path = join(root, 'file');
  for (const bytes of ['', '{"DO_NOT_EXPORT":undefined}', Buffer.from([0xff, 0xfe])]) {
    await writeFile(path, bytes);
    await assert.rejects(readEvidenceJson(path), (error) => {
      assert.match(error.message, /not valid UTF-8 JSON/u);
      assert.doesNotMatch(error.message, /DO_NOT_EXPORT/u); return true;
    });
  }
  await writeFile(path, '{"status":"passed"}');
  assert.deepEqual(await readEvidenceJson(path), { status: 'passed' });
});

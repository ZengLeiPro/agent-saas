import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const helper = new URL('./list-acr-build-records.sh', import.meta.url);

async function fakeAliyun(root, body) {
  const bin = join(root, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'aliyun'), `#!/usr/bin/env bash\n${body}\n`);
  await chmod(join(bin, 'aliyun'), 0o755);
  return bin;
}

function env(root, bin) {
  return {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    RUNNER_TEMP: root,
    ACR_AK: 'read-id',
    ACR_SK: 'read-secret',
    ACR_REGION_ID: 'cn-test',
    ACR_INSTANCE_ID: 'instance',
    ACR_REPO_ID: 'repository',
  };
}

test('collects every ACR build-record page so a later-page tag collision remains visible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acr-pages-'));
  const bin = await fakeAliyun(
    root,
    `set -euo pipefail
page=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = --PageNo ]; then page=$2; shift 2; else shift; fi
done
node - "$page" <<'NODE'
const page = Number(process.argv[2]);
const records = page === 1
  ? Array.from({ length: 100 }, (_, index) => ({
      BuildRecordId: 'record-' + index,
      BuildStatus: 'SUCCESS',
      Image: { ImageTag: index === 0 ? 'main-abcdef' : 'other-' + index },
    }))
  : [{ BuildRecordId: 'record-100', BuildStatus: 'SUCCESS', Image: { ImageTag: 'retry-abcdef' } }];
process.stdout.write(JSON.stringify({ Code: 'success', IsSuccess: true, PageNo: page, PageSize: 100, TotalCount: '101', BuildRecords: records }));
NODE`,
  );
  const output = join(root, 'records.json');
  const result = spawnSync('bash', [helper.pathname, output], {
    encoding: 'utf8',
    env: env(root, bin),
  });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(value.BuildRecords.length, 101);
  assert.equal(
    value.BuildRecords.filter((record) => record.Image.ImageTag.endsWith('-abcdef')).length,
    2,
  );
  await rm(root, { recursive: true, force: true });
});

test('retries the full ACR snapshot when TotalCount changes once during pagination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acr-pages-retry-'));
  const calls = join(root, 'calls');
  const bin = await fakeAliyun(
    root,
    `set -euo pipefail
page=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = --PageNo ]; then page=$2; shift 2; else shift; fi
done
printf '%s\n' "$page" >> '${calls}'
call_count=$(wc -l < '${calls}')
if [ "$call_count" -eq 1 ]; then total=101; count=100; else total=102; if [ "$page" = 1 ]; then count=100; else count=2; fi; fi
node - "$page" "$total" "$count" <<'NODE'
const [page, total, count] = process.argv.slice(2).map(Number);
const offset = (page - 1) * 100;
const records = Array.from({ length: count }, (_, index) => ({ BuildRecordId: 'record-' + (offset + index) }));
process.stdout.write(JSON.stringify({ Code: 'success', IsSuccess: true, PageNo: page, PageSize: 100, TotalCount: String(total), BuildRecords: records }));
NODE`,
  );
  const output = join(root, 'records.json');
  const result = spawnSync('bash', [helper.pathname, output], {
    encoding: 'utf8',
    env: env(root, bin),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /retrying stable snapshot/u);
  const value = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(value.TotalCount, '102');
  assert.equal(value.BuildRecords.length, 102);
  assert.equal((await readFile(calls, 'utf8')).trim().split('\n').length, 4);
  await rm(root, { recursive: true, force: true });
});

test('fails closed when ACR TotalCount keeps changing during bounded snapshot retries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acr-pages-drift-'));
  const bin = await fakeAliyun(
    root,
    `set -euo pipefail
page=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = --PageNo ]; then page=$2; shift 2; else shift; fi
done
if [ "$page" = 1 ]; then total=101; count=100; else total=102; count=2; fi
node - "$page" "$total" "$count" <<'NODE'
const [page, total, count] = process.argv.slice(2).map(Number);
const records = Array.from({ length: count }, (_, index) => ({ BuildRecordId: 'record-' + page + '-' + index }));
process.stdout.write(JSON.stringify({ Code: 'success', IsSuccess: true, PageNo: page, PageSize: 100, TotalCount: String(total), BuildRecords: records }));
NODE`,
  );
  const result = spawnSync('bash', [helper.pathname, join(root, 'records.json')], {
    encoding: 'utf8',
    env: env(root, bin),
  });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /total changed during pagination and did not stabilize after 3 attempts/u,
  );
  await rm(root, { recursive: true, force: true });
});

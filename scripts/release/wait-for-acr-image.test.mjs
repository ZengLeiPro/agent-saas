import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const releaseSha = 'a'.repeat(40);
const script = new URL('./wait-for-acr-image.sh', import.meta.url);

async function runWait(scenario) {
  const root = await mkdtemp(join(tmpdir(), `wait-acr-${scenario}-`));
  const bin = join(root, 'bin');
  const output = join(root, 'image.json');
  const events = join(root, 'events');
  await mkdir(bin);
  await writeFile(
    join(bin, 'git'),
    `#!/usr/bin/env bash
set -eu
test "$#" -eq 2
test "$1" = rev-list
test "$2" = --all
printf '%s\n' '${releaseSha}'
`,
  );
  await writeFile(
    join(bin, 'aliyun'),
    `#!/usr/bin/env bash
set -euo pipefail
action=$2
case "$action" in
  ListRepoBuildRecord)
    test "$#" -eq 18
    test "$3:$4:$5:$6:$7:$8:$9:\${10}:\${11}:\${12}:\${13}:\${14}:\${15}:\${17}:\${18}" = '--mode:AK:--access-key-id:read-id:--access-key-secret:read-secret:--region:cn-test:--InstanceId:instance:--RepoId:repository:--PageNo:--PageSize:100'
    page=\${16}
    printf 'list:%s\n' "$page" >> '${events}'
    calls=$(grep -c '^list:' '${events}')
    record_id=record-1
    if [ '${scenario}' = record-drift ] && [ "$calls" -gt 2 ]; then record_id=record-2; fi
    node - "$page" "$record_id" <<'NODE'
const [pageText, recordId] = process.argv.slice(2);
const page = Number(pageText);
const records = page === 1
  ? Array.from({ length: 100 }, (_, index) => ({
      BuildRecordId: 'other-' + index,
      BuildStatus: 'SUCCESS',
      Image: { ImageTag: 'other-' + index },
    }))
  : [{ BuildRecordId: recordId, BuildStatus: 'SUCCESS', Image: { ImageTag: 'main-aaaaaa' } }];
process.stdout.write(JSON.stringify({ Code: 'success', IsSuccess: true, PageNo: page, PageSize: 100, TotalCount: '101', BuildRecords: records }));
NODE
    ;;
  ListRepoBuildRecordLog)
    test "$#" -eq 16
    test "$3:$4:$5:$6:$7:$8:$9:\${10}:\${11}:\${12}:\${13}:\${14}:\${15}:\${16}" = '--mode:AK:--access-key-id:read-id:--access-key-secret:read-secret:--region:cn-test:--InstanceId:instance:--BuildRecordId:record-1:--Offset:0'
    printf 'log:record-1\n' >> '${events}'
    log_sha='${releaseSha.slice(0, 7)}'
    if [ '${scenario}' = log-sha-mismatch ]; then log_sha='${'b'.repeat(7)}'; fi
    printf '{"Code":"success","IsSuccess":true,"BuildRecordLogs":[{"LineNumber":5,"Message":"commit info: * main %s [origin/main] subject"}]}' "$log_sha"
    ;;
  GetRepoTag)
    test "$#" -eq 16
    test "$3:$4:$5:$6:$7:$8:$9:\${10}:\${11}:\${12}:\${13}:\${14}:\${15}:\${16}" = '--mode:AK:--access-key-id:read-id:--access-key-secret:read-secret:--region:cn-test:--InstanceId:instance:--RepoId:repository:--Tag:main-aaaaaa'
    printf 'tag:main-aaaaaa\n' >> '${events}'
    tag_calls=$(grep -c '^tag:' '${events}')
    digest='${'a'.repeat(64)}'
    if [ '${scenario}' = digest-drift ] && [ "$tag_calls" -gt 1 ]; then digest='${'b'.repeat(64)}'; fi
    printf '{"Status":"NORMAL","Digest":"sha256:%s"}' "$digest"
    ;;
  *) echo "unexpected aliyun action: $action" >&2; exit 1 ;;
esac
`,
  );
  await Promise.all([chmod(join(bin, 'git'), 0o755), chmod(join(bin, 'aliyun'), 0o755)]);
  const result = spawnSync('bash', [script.pathname], {
    cwd: new URL('../..', import.meta.url),
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      RUNNER_TEMP: root,
      RELEASE_SHA: releaseSha,
      ACR_AK: 'read-id',
      ACR_SK: 'read-secret',
      ACR_REGION_ID: 'cn-test',
      ACR_INSTANCE_ID: 'instance',
      ACR_REPO_ID: 'repository',
      ACR_REGISTRY: 'registry.example',
      ACR_REPOSITORY: 'namespace/image',
      OUTPUT_FILE: output,
    },
  });
  return { root, output, events, result };
}

test('executes the strict full Staging ACS record and tag confirmation sequence', async () => {
  const run = await runWait('success');
  assert.equal(run.result.status, 0, run.result.stderr);
  const value = JSON.parse(await readFile(run.output, 'utf8'));
  assert.equal(value.reference, `registry.example/namespace/image@sha256:${'a'.repeat(64)}`);
  assert.deepEqual((await readFile(run.events, 'utf8')).trim().split('\n'), [
    'list:1',
    'list:2',
    'log:record-1',
    'tag:main-aaaaaa',
    'list:1',
    'list:2',
    'tag:main-aaaaaa',
  ]);
  await rm(run.root, { recursive: true, force: true });
});

test('rejects a Staging ACS BuildRecordId substitution during final confirmation', async () => {
  const run = await runWait('record-drift');
  assert.notEqual(run.result.status, 0);
  assert.match(run.result.stderr, /no longer has one successful selected BuildRecordId/u);
  await rm(run.root, { recursive: true, force: true });
});

test('rejects a Staging ACS tag digest change between stable reads', async () => {
  const run = await runWait('digest-drift');
  assert.notEqual(run.result.status, 0);
  assert.equal((await readFile(run.events, 'utf8')).match(/^tag:/gmu)?.length, 2);
  await rm(run.root, { recursive: true, force: true });
});

test('rejects a Staging ACR log whose commit info does not match the requested SHA', async () => {
  const run = await runWait('log-sha-mismatch');
  assert.notEqual(run.result.status, 0);
  assert.match(run.result.stderr, /cloned bbbbbbb \(main\), not source commit/u);
  await rm(run.root, { recursive: true, force: true });
});

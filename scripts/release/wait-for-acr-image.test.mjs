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
  await writeFile(join(bin, 'git'), `#!/usr/bin/env bash\nprintf '%s\n' '${releaseSha}'\n`);
  await writeFile(
    join(bin, 'aliyun'),
    `#!/usr/bin/env bash
set -euo pipefail
action=$2
arg() {
  wanted=$1; shift
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "$wanted" ]; then printf '%s' "$2"; return 0; fi
    shift
  done
  return 1
}
test "$(arg --region "$@")" = cn-test
case "$action" in
  ListRepoBuildRecord)
    test "$(arg --InstanceId "$@")" = instance
    test "$(arg --RepoId "$@")" = repository
    test "$(arg --PageSize "$@")" = 100
    page=$(arg --PageNo "$@")
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
    test "$(arg --InstanceId "$@")" = instance
    test "$(arg --BuildRecordId "$@")" = record-1
    test "$(arg --Offset "$@")" = 0
    test "$(arg --PageSize "$@")" = 100
    printf 'log:record-1\n' >> '${events}'
    log_sha='${releaseSha}'
    if [ '${scenario}' = log-sha-mismatch ]; then log_sha='${'b'.repeat(40)}'; fi
    printf '{"Code":"success","IsSuccess":true,"BuildRecordLogs":[{"BuildStage":"GIT_CLONE","Message":"checked out %s"}]}' "$log_sha"
    ;;
  GetRepoTag)
    test "$(arg --InstanceId "$@")" = instance
    test "$(arg --RepoId "$@")" = repository
    test "$(arg --Tag "$@")" = main-aaaaaa
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

test('executes the full Staging ACS record and tag confirmation sequence', async () => {
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

test('rejects a Staging ACR log that is not bound to the requested full SHA', async () => {
  const run = await runWait('log-sha-mismatch');
  assert.notEqual(run.result.status, 0);
  assert.match(run.result.stderr, /not bound to full source commit/u);
  await rm(run.root, { recursive: true, force: true });
});

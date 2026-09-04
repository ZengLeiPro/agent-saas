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
  await mkdir(bin);
  await writeFile(join(bin, 'git'), `#!/usr/bin/env bash\nprintf '%s\n' '${releaseSha}'\n`);
  await writeFile(
    join(bin, 'aliyun'),
    `#!/usr/bin/env bash
set -euo pipefail
action=$2
case "$action" in
  ListRepoBuildRecord)
    count_file='${root}/list-count'
    count=0; [ ! -f "$count_file" ] || count=$(cat "$count_file")
    count=$((count + 1)); printf '%s' "$count" > "$count_file"
    record_id=record-1
    if [ '${scenario}' = record-drift ] && [ "$count" -gt 1 ]; then record_id=record-2; fi
    printf '{"Code":"success","IsSuccess":true,"PageNo":1,"PageSize":100,"TotalCount":"1","BuildRecords":[{"BuildRecordId":"%s","BuildStatus":"SUCCESS","Image":{"ImageTag":"main-aaaaaa"}}]}' "$record_id"
    ;;
  ListRepoBuildRecordLog)
    printf '{"Code":"success","IsSuccess":true,"BuildRecordLogs":[{"BuildStage":"GIT_CLONE","Message":"checked out ${releaseSha}"}]}'
    ;;
  GetRepoTag)
    count_file='${root}/tag-count'
    count=0; [ ! -f "$count_file" ] || count=$(cat "$count_file")
    count=$((count + 1)); printf '%s' "$count" > "$count_file"
    digest='${'a'.repeat(64)}'
    if [ '${scenario}' = digest-drift ] && [ "$count" -gt 1 ]; then digest='${'b'.repeat(64)}'; fi
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
  return { root, output, result };
}

test('resolves a Staging ACS digest through the full record and tag confirmation sequence', async () => {
  const run = await runWait('success');
  assert.equal(run.result.status, 0, run.result.stderr);
  const value = JSON.parse(await readFile(run.output, 'utf8'));
  assert.equal(value.reference, `registry.example/namespace/image@sha256:${'a'.repeat(64)}`);
  assert.equal(await readFile(join(run.root, 'list-count'), 'utf8'), '2');
  assert.equal(await readFile(join(run.root, 'tag-count'), 'utf8'), '2');
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
  await rm(run.root, { recursive: true, force: true });
});

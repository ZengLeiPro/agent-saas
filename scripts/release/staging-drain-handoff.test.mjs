import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const deployPath = new URL('./deploy-staging-release.sh', import.meta.url);

test('Staging drains before current/env mutation and uses its own proof path', async () => {
  const deploy = await readFile(deployPath, 'utf8');
  const drain = deploy.indexOf('  drain_acs_before_cutover\n');
  assert.ok(drain > 0 && drain < deploy.indexOf('runtime_mutated=true'));
  assert.ok(drain < deploy.indexOf('ln -sfn "$target" "$current"'));
  assert.ok(drain < deploy.indexOf('node - "$MANIFEST_PATH" "$acs_env"'));
  assert.match(deploy, /ACS_HEALTH_URL=http:\/\/127\.0\.0\.1:3410\/health/u);
  assert.match(deploy, /ACS_DRAIN_STATE_PATH="\$run_root\/acs-drain\.json"/u);
  assert.doesNotMatch(deploy, /kill -USR2|seq 1 330/u);
  const unit = await readFile(
    new URL(
      '../../daemon-packaging/systemd/agent-saas-acs-orchestrator-staging.service.template',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(
    unit,
    /Environment=ACS_ORCH_DRAIN_STATE_FILE=\/run\/agent-saas-staging\/acs-drain\.json/u,
  );
  execFileSync('bash', ['-n', deployPath.pathname]);
});

for (const recoveryFails of [false, true]) {
  test(`Staging pre-cutover drain failure preserves accepted work; cancellation failure=${recoveryFails}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'staging-drain-cleanup-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const deploy = await readFile(deployPath, 'utf8');
    const lifecycle = deploy.slice(
      deploy.indexOf('# BEGIN staging deploy cleanup lifecycle'),
      deploy.indexOf('# END staging deploy cleanup lifecycle'),
    );
    const script = join(root, 'case.sh');
    await writeFile(
      script,
      `#!/usr/bin/env bash
set -euo pipefail
candidate=$CASE_ROOT/candidate
artifact_persistence_probe=$CASE_ROOT/artifact
acs_health_probe=$CASE_ROOT/acs-health
api_ready_probe=$CASE_ROOT/api-ready
rollback_root=$CASE_ROOT
server_config=$CASE_ROOT/config
server_env=$CASE_ROOT/server.env
acs_env=$CASE_ROOT/acs.env
acs_identity=$CASE_ROOT/acs.json
server_unit=$CASE_ROOT/server.service
worker_unit=$CASE_ROOT/worker.service
acs_unit=$CASE_ROOT/acs.service
run_root=$CASE_ROOT
previous=$CASE_ROOT/previous
current=$CASE_ROOT/current
deployment_attempt_id=1-1
had_server_config=true
had_server_env=true
had_acs_env=true
had_previous_identity=true
had_server_unit=true
had_worker_unit=true
had_acs_unit=true
had_previous_release=true
ACS_DRAIN_PID=101
ACS_DRAIN_DROPIN=$CASE_ROOT/guard
acs_mutation_started=false
cp() { printf 'restore:%s\\n' "$*" >> "$CASE_ROOT/log"; }
rm() { return 0; }
systemctl() { printf 'systemctl:%s\\n' "$*" >> "$CASE_ROOT/log"; }
cancel_acs_deployment_drain() { printf 'cancel\\n' >> "$CASE_ROOT/log"; return ${recoveryFails ? 1 : 0}; }
release_acs_drain_guard() { printf 'unguard\\n' >> "$CASE_ROOT/log"; return 0; }
${lifecycle}
exit 23
`,
    );
    const result = spawnSync('bash', [script], {
      env: { ...process.env, CASE_ROOT: root },
      encoding: 'utf8',
    });
    assert.equal(result.status, 23, result.stderr);
    const log = await readFile(join(root, 'log'), 'utf8');
    assert.ok(log.indexOf('restore:') < log.indexOf('cancel\n'));
    assert.match(log, /cancel\nunguard/u);
    assert.doesNotMatch(log, /systemctl:(restart|stop|start)/u);
    const recovery = JSON.parse(await readFile(join(root, 'recovery-status.json'), 'utf8'));
    assert.equal(recovery.status, recoveryFails ? 'needs_human' : 'restore_commands_completed');
  });
}

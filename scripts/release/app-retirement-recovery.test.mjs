import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
const deploy = await readFile(new URL('./deploy-production-release.sh', import.meta.url), 'utf8');
const repair = deploy.slice(
  deploy.indexOf('retire_failed_app_generation() {'),
  deploy.indexOf('\nhand_off_retired_authority() {'),
);
const finalization = new URL('./verify-app-retirement.sh', import.meta.url).pathname;

for (const scenario of ['clean', 'children', 'mainpidchanged', 'job', 'unknownTasks', 'normal']) {
  test(`repair retires an already-failed generation only after proving no surviving authority: ${scenario}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'failed-app-retirement-'));
    try {
      await mkdir(join(root, 'cgroup', 'unit'), { recursive: true });
      await writeFile(
        join(root, 'cgroup', 'unit', 'cgroup.events'),
        `populated ${scenario === 'children' ? 1 : 0}\n`,
      );
      const result = spawnSync(
        'bash',
        [
          '-c',
          `set -euo pipefail
systemctl() {
  printf '%s\\n' "$*" >> "$TEST_ROOT/events"
  case "$*" in
    *--property=ActiveState*) [ -e "$TEST_ROOT/reset" ] && echo inactive || echo failed ;;
    *--property=MainPID*) if [ "$CASE" = mainpidchanged ] && [ -e "$TEST_ROOT/pidread" ]; then echo 42; else echo 0; touch "$TEST_ROOT/pidread"; fi ;;
    *--property=ControlPID*) echo 0 ;;
    *--property=TasksCurrent*) [ "$CASE" = unknownTasks ] && echo '[not set]' || echo 0 ;;
    *--property=ControlGroup*) echo /unit ;;
    'list-jobs --no-legend --no-pager') if [ "$CASE" = job ]; then echo '21 agent-saas-server@blue.service start waiting'; fi ;;
    'disable agent-saas-server@blue') return 0 ;;
    'reset-failed agent-saas-server@blue') touch "$TEST_ROOT/reset" ;;
    'is-enabled --quiet agent-saas-server@blue') return 1 ;;
    *) return 99 ;;
  esac
}
${repair}
retire_failed_app_generation agent-saas-server@blue "$TEST_ROOT/guard"`,
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            TEST_ROOT: root,
            CASE: scenario,
            PRODUCTION_RECOVERY_MODE: scenario === 'normal' ? 'normal' : 'repair',
            APP_REPAIR_CGROUP_ROOT: join(root, 'cgroup'),
          },
        },
      );
      assert.equal(result.status === 0, scenario === 'clean', result.stderr);
      if (scenario === 'clean') {
        const events = await readFile(join(root, 'events'), 'utf8');
        assert.ok(events.indexOf('disable ') < events.indexOf('reset-failed '));
        assert.doesNotMatch(events, /stop|restart|kill/u);
        assert.equal(await readFile(join(root, 'guard'), 'utf8'), '');
      } else await assert.rejects(readFile(join(root, 'reset')), { code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const scenario of [
  'inactive',
  'acknowledged',
  'enabled',
  'emptyguard',
  'wrongpid',
  'failed',
]) {
  test(`expand finalization freshly verifies the retired generation: ${scenario}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'finalization-retirement-'));
    try {
      const manifest = join(root, 'manifest.json');
      await writeFile(
        manifest,
        JSON.stringify({
          releaseId: 'rc-20260908-01',
          digest: `sha256:${'a'.repeat(64)}`,
          components: { api: { action: 'deploy' }, runtimeWorker: { action: 'deploy' } },
        }),
      );
      for (const name of ['active-color', 'runtime-worker-active-color'])
        await writeFile(join(root, name), 'green');
      for (const role of ['server', 'runtime-worker']) {
        await writeFile(join(root, `agent-saas-${role}-blue.pid`), '42');
        await writeFile(
          join(root, `agent-saas-${role}-blue.draining`),
          scenario === 'emptyguard'
            ? ''
            : JSON.stringify({
                pid: scenario === 'wrongpid' ? 43 : 42,
                runtimeQuiesced: false,
                activeStreams: 1,
                activeUploads: 0,
              }),
        );
      }
      const result = spawnSync(
        'bash',
        [
          '-c',
          `set -euo pipefail
systemctl() {
  case "$*" in
    'is-enabled --quiet '*) [ "$CASE" = enabled ] ;;
    *--property=ActiveState*) case "$CASE" in inactive|failed) echo "$CASE" ;; *) echo active ;; esac ;;
    *--property=MainPID*) [ "$CASE" = inactive ] && echo 0 || echo 42 ;;
    *) return 1 ;;
  esac
}
source "$PROOF_SCRIPT" "$MANIFEST"`,
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            CASE: scenario,
            PROOF_SCRIPT: finalization,
            MANIFEST: manifest,
            APP_RETIREMENT_RUN_ROOT: root,
            APP_RETIREMENT_CONFIG_ROOT: root,
          },
        },
      );
      assert.equal(
        result.status === 0,
        ['inactive', 'acknowledged'].includes(scenario),
        result.stderr,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

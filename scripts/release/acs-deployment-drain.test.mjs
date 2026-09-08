import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
const helper = new URL('./acs-deployment-drain.sh', import.meta.url).pathname;

test('actual compatibility cutover never restarts after a failed drain', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acs-compat-drain-'));
  try {
    await mkdir(join(root, 'scripts/release'), { recursive: true });
    await writeFile(
      join(root, 'scripts/release/acs-deployment-drain.sh'),
      'drain_acs_before_cutover() { return "$DRAIN_RESULT"; }\nrelease_acs_drain_guard() { :; }\n',
    );
    const source = await readFile(
      new URL('../deploy-acs-orchestrator.sh', import.meta.url),
      'utf8',
    );
    const block = source.slice(source.indexOf('# ── 3. Drain'), source.indexOf('# ── 4. 等新进程'));
    assert.ok(block.includes('drain_acs_before_cutover'));
    assert.doesNotMatch(block, /RESTART_FALLBACK|kill -KILL|kill -TERM/u);
    for (const status of ['0', '75']) {
      const result = spawnSync(
        'bash',
        ['-ec', 'systemctl() { echo RESTARTED; }; rollback_and_exit() { exit "$1"; };\n' + block],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            APP_DIR: root,
            RUNTIME_PREFLIGHT_ROOT: root,
            COMPAT_RELEASE_ID: 'compat-test',
            ORCHESTRATOR_ARTIFACT_DIGEST: 'sha256:' + 'a'.repeat(64),
            SYSTEMCTL_BIN: 'systemctl',
            ACS_SERVICE_NAME: 'acs',
            DRAIN_RESULT: status,
          },
        },
      );
      assert.equal(result.status, Number(status), result.stderr);
      assert.equal(result.stdout.includes('RESTARTED'), status === '0');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const mocks = `
systemctl() {
  printf 'systemctl %s\\n' "$*" >> "$TEST_ROOT/events"
  case "$*" in
    'is-active --quiet acs') [ ! -e "$TEST_ROOT/signalled" ] || [ "$CASE" = timeout ] || [ "$CASE" = pidchange ] ;;
    *--property=MainPID*)
      if [ ! -e "$TEST_ROOT/signalled" ]; then echo 42
      elif [ "$CASE" = pidchange ]; then echo 43
      elif [ "$CASE" = exitbetweenreads ] || [ "$CASE" = deactivating ]; then echo 0
      else echo 42; fi ;;
    *--property=ExecMainPID*) [ "$CASE" = foreignexit ] && echo 43 || echo 42 ;;
    *--property=ActiveState*)
      if [ "$CASE" = exitbetweenreads ] || [ "$CASE" = deactivating ] || [ "$CASE" = legacybusy ]; then
        if [ -e "$TEST_ROOT/transition-observed" ]; then echo inactive
        else touch "$TEST_ROOT/transition-observed"; [ "$CASE" = deactivating ] && echo deactivating || echo active; fi
      elif [ "$CASE" = legacyforced ]; then
        count=$(cat "$TEST_ROOT/legacy-polls" 2>/dev/null || echo 0)
        if [ "$count" -lt 8 ]; then echo $((count + 1)) > "$TEST_ROOT/legacy-polls"; echo active; else echo failed; fi
      else case "$CASE" in timeout|pidchange) echo active ;; forced|legacyearlyforced|killed) echo failed ;; *) echo inactive ;; esac; fi ;;
    *--property=ExecMainStatus*) case "$CASE" in forced|legacyforced|legacyearlyforced) echo 1 ;; killed) echo 9 ;; *) echo 0 ;; esac ;;
    *--property=ExecMainCode*) [ "$CASE" != killed ] && echo 1 || echo 2 ;;
    *--property=Result*) case "$CASE" in forced|legacyforced|legacyearlyforced) echo exit-code ;; killed) echo signal ;; *) echo success ;; esac ;;
    daemon-reload|'start acs') return 0 ;;
    *) return 1 ;;
  esac
}
kill() {
  printf 'kill %s\\n' "$*" >> "$TEST_ROOT/events"
  if [ "$1" = -USR1 ]; then touch "$TEST_ROOT/cancelled"; return 0; fi
  test "$1:$2" = -USR2:42 || return 1
  test "$(cat "$ACS_SYSTEMD_RUNTIME_ROOT/acs.service.d/90-agent-saas-promotion-drain.conf")" = $'[Service]\\nRestart=no' || return 1
  touch "$TEST_ROOT/signalled"
  if [ "$CASE" != missingproof ]; then printf '%s' '{"protocolVersion":1,"pid":42,"state":"completed","inflight":0}' > "$ACS_DRAIN_STATE_PATH"; fi
}
curl() {
  local protocol=1 inflight=0 state=idle draining=false
  case "$CASE" in
    legacybusy|legacyforced|legacyearlyforced) protocol=0; inflight=3 ;;
    legacyquiet) protocol=0 ;;
    legacydraining) protocol=0; draining=true ;;
    legacyinvalid) protocol=0; inflight=null ;;
    unknownprotocol) protocol=2 ;;
  esac
  if [ -e "$TEST_ROOT/signalled" ] && [ ! -e "$TEST_ROOT/cancelled" ]; then state=timed_out; draining=false; fi
  printf '{"inflight":%s,"draining":%s,"lifecycle":{"drainDeadlineMs":120000},"deploymentDrain":{"protocolVersion":%s,"pid":42,"state":"%s"}}' "$inflight" "$draining" "$protocol" "$state"
}
sleep() { echo 'wait tick' >> "$TEST_ROOT/events"; SECONDS=$((SECONDS + 15)); }
`;

for (const scenario of [
  'clean',
  'legacyquiet',
  'exitbetweenreads',
  'deactivating',
  'foreignexit',
  'forced',
  'killed',
  'missingproof',
  'legacybusy',
  'legacyforced',
  'legacyearlyforced',
  'legacydraining',
  'legacyinvalid',
  'unknownprotocol',
  'timeout',
  'pidchange',
]) {
  test(`ACS cutover observes old PID outcome: ${scenario}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'acs-drain-host-'));
    try {
      const env = {
        ...process.env,
        TEST_ROOT: root,
        CASE: scenario,
        ACS_SERVICE_NAME: 'acs',
        ACS_SYSTEMD_RUNTIME_ROOT: join(root, 'systemd'),
        ACS_DRAIN_STATE_PATH: join(root, 'drain.json'),
        MANIFEST_PATH: join(root, 'manifest.json'),
        GITHUB_RUN_ID: '123',
        GITHUB_RUN_ATTEMPT: '2',
        release_id: 'rc-20260908-01',
        manifest_digest: `sha256:${'a'.repeat(64)}`,
      };
      const script = `set -euo pipefail\nsource "$DRAIN_HELPER"\n${mocks}\ndrain_acs_before_cutover`;
      const result = spawnSync('bash', ['-c', script], {
        encoding: 'utf8',
        env: { ...env, DRAIN_HELPER: helper },
      });
      const success = [
        'clean',
        'legacyquiet',
        'legacybusy',
        'legacyforced',
        'exitbetweenreads',
        'deactivating',
      ].includes(scenario);
      assert.equal(result.status === 0, success, result.stderr);
      const proofPath = join(root, 'acs-drain-123-2.json');
      if (success) {
        const proof = JSON.parse(await readFile(proofPath, 'utf8'));
        assert.equal(proof.pid, 42);
        assert.equal(proof.exitStatus, scenario === 'legacyforced' ? 1 : 0);
        assert.equal(
          proof.state,
          scenario === 'legacyforced' ? 'forced_legacy_cutover' : 'completed',
        );
        const events = await readFile(join(root, 'events'), 'utf8');
        assert.ok(events.indexOf('daemon-reload') < events.indexOf('kill -USR2'));
      } else await assert.rejects(readFile(proofPath), { code: 'ENOENT' });
      if (scenario === 'legacybusy') {
        assert.match(result.stderr, /stopping admission and waiting for accepted work/u);
        assert.match(await readFile(join(root, 'events'), 'utf8'), /kill -USR2 42/u);
        assert.match(await readFile(join(root, 'events'), 'utf8'), /wait tick/u);
        assert.match(result.stderr, /Waiting for ACS drain/u);
      }
      if (['legacydraining', 'legacyinvalid'].includes(scenario)) {
        assert.equal(result.status, 75);
        assert.doesNotMatch(await readFile(join(root, 'events'), 'utf8'), /kill|daemon-reload/u);
      }
      if (scenario === 'legacyforced') {
        assert.match(result.stderr, /audited one-time compatibility cutover/u);
      }
      assert.doesNotMatch(
        await readFile(join(root, 'events'), 'utf8'),
        /restart|kill -KILL|kill -TERM/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('failed native drain restores the old generation admission and Restart policy without replacing its PID', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acs-drain-cancel-'));
  try {
    const result = spawnSync(
      'bash',
      [
        '-c',
        `set -euo pipefail
source "$DRAIN_HELPER"
${mocks}
if drain_acs_before_cutover; then exit 99; fi
cancel_acs_deployment_drain
test ! -e "$ACS_SYSTEMD_RUNTIME_ROOT/acs.service.d/90-agent-saas-promotion-drain.conf"
test -e "$TEST_ROOT/cancelled"`,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          DRAIN_HELPER: helper,
          TEST_ROOT: root,
          CASE: 'timeout',
          ACS_SERVICE_NAME: 'acs',
          ACS_SYSTEMD_RUNTIME_ROOT: join(root, 'systemd'),
          ACS_DRAIN_STATE_PATH: join(root, 'drain.json'),
          MANIFEST_PATH: join(root, 'manifest.json'),
          GITHUB_RUN_ID: '123',
          GITHUB_RUN_ATTEMPT: '2',
          release_id: 'rc-20260908-01',
          manifest_digest: `sha256:${'a'.repeat(64)}`,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const events = await readFile(join(root, 'events'), 'utf8');
    assert.match(events, /kill -USR1 42/u);
    assert.doesNotMatch(events, /restart|kill -KILL|kill -TERM|start acs/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

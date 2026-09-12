import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  observeProductionRuntime,
  readDiagnosticFile,
  safeErrno,
} from './production-runtime-observation.mjs';

const NOW = Date.parse('2026-09-12T00:00:00Z');
const BOOT = '11111111-2222-3333-4444-555555555555';
const SHA = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;
const RELEASE = 'rc-20260911-117';
const READY = '/run/agent-saas-runtime-worker-green.ready';
const STATUS = `${READY}.status.json`;
const CONFIG = '/run/agent-saas-runtime-worker-green.config-identity.json';
function fixture() {
  const files = new Map();
  const put = (path, value, metadata = {}) =>
    files.set(path, {
      text: typeof value === 'string' ? value : JSON.stringify(value),
      uid: 0,
      gid: 0,
      mode: 0o600,
      ...metadata,
    });
  put('/proc/sys/kernel/random/boot_id', BOOT);
  put('/proc/meminfo', 'MemTotal: 4096 kB\nMemAvailable: 1024 kB\nOther: secret\n');
  put('/proc/pressure/memory', 'some avg10=1.23 avg60=0.00\nfull avg10=0.12 avg60=0.00\n');
  put('/etc/agent-saas/active-color', 'blue');
  put('/etc/agent-saas/runtime-worker-active-color', 'green');
  for (const [prefix, color, pid] of [
    ['server', 'blue', 100],
    ['runtime-worker', 'green', 101],
  ]) {
    put(`/run/agent-saas-${prefix}-${color}.pid`, String(pid));
    put(`/proc/${pid}/stat`, `${pid} (node worker) S ${Array(18).fill('0').join(' ')} 123456`);
    put(`/proc/${pid}/cgroup`, `0::/system.slice/agent-saas-${prefix}@${color}.service\n`);
    put(
      `/etc/agent-saas/${prefix}-${color}.release.env`,
      `AGENT_SAAS_RELEASE_ID=${RELEASE}\nAGENT_SAAS_RELEASE_SHA=${SHA}\nAGENT_SAAS_SERVER_DIGEST=${DIGEST}\nSECRET=NEVER_EXPORT_ME\n`,
    );
    put(`/run/agent-saas-${prefix}-${color}.config-identity.json`, {
      status: 'consistent',
      releaseId: RELEASE,
      lastObservedAt: new Date(NOW).toISOString(),
      secret: 'NEVER_EXPORT_ME',
    });
  }
  const status = {
    schemaVersion: 1,
    environment: 'production',
    pid: 101,
    bootId: BOOT,
    processStartTicks: '123456',
    releaseSha: SHA,
    releaseId: RELEASE,
    serverDigest: DIGEST,
    sampledAt: new Date(NOW).toISOString(),
    state: 'admission_paused',
    configStatus: 'consistent',
    privateSnapshotCurrent: true,
    admission: {
      state: 'paused',
      admitting: false,
      reason: 'host_mem_available_low',
      availableBytes: 1024,
      secret: 'NEVER_EXPORT_ME',
    },
    refresh: { pending: false, durationMs: 2, secret: 'NEVER_EXPORT_ME' },
    secret: 'NEVER_EXPORT_ME',
  };
  put(STATUS, status);
  const options = {
    now: NOW,
    uid: 0,
    read: (path) => {
      const file = files.get(path);
      if (file instanceof Error) throw file;
      if (!file) throw Object.assign(new Error('NEVER_EXPORT_ME'), { code: 'ENOENT' });
      return file;
    },
    realpath: () => `/opt/agent-saas-app/releases/${DIGEST.slice(7)}`,
    show: (unit) =>
      `MainPID=${unit.includes('runtime-worker') ? '101' : '100'}\nActiveState=active\nSubState=running\nControlGroup=/system.slice/${unit}\n`,
  };
  return { files, put, status, options, observe: () => observeProductionRuntime(options) };
}

test('identifies a current same-generation memory pause without confusing admission with process identity', () => {
  const result = fixture().observe();
  assert.equal(result.memory.totalBytes, 4096 * 1024);
  assert.equal(result.memory.availableBytes, 1024 * 1024);
  assert.equal(result.memory.psiSomeAvg10, 1.23);
  assert.equal(result.memory.psiFullAvg10, 0.12);
  assert.equal(result.api.identityBound, true);
  assert.equal(result.runtimeWorker.identityBound, true);
  assert.equal(result.runtimeWorker.readyfile.errno, 'ENOENT');
  assert.equal(result.runtimeWorker.readiness.availability, 'current');
  assert.deepEqual([result.retry.allowed, result.retry.reasonCode], [true, 'admission_paused']);
  assert.ok(result.retry.identityKey.includes('123456'));
  assert.doesNotMatch(JSON.stringify(result), /NEVER_EXPORT_ME|SECRET=/u);
});

for (const errno of ['EACCES', 'EPERM', 'EIO', 'ELOOP']) {
  test(`preserves readyfile ${errno} and forbids blind retry`, () => {
    const f = fixture();
    f.files.set(
      READY,
      Object.assign(new Error('private error body NEVER_EXPORT_ME'), { code: errno }),
    );
    const result = f.observe();
    assert.equal(result.runtimeWorker.readyfile.errno, errno);
    assert.equal(result.retry.allowed, false);
    assert.equal(result.retry.reasonCode, 'worker_readyfile_io_error');
    assert.doesNotMatch(JSON.stringify(result), /NEVER_EXPORT_ME/u);
  });
}
for (const text of ['999\n', '101evil', '0', '-2', '9007199254740992']) {
  test(`rejects wrong or malformed ready PID ${text.trim()}`, () => {
    const f = fixture();
    f.put(READY, text);
    assert.equal(f.observe().retry.reasonCode, 'worker_readyfile_pid_mismatch');
    assert.equal(f.observe().retry.allowed, false);
  });
}
for (const [key, value] of [
  ['pid', 999],
  ['bootId', '22222222-2222-3333-4444-555555555555'],
  ['processStartTicks', '123457'],
  ['releaseSha', 'c'.repeat(40)],
  ['serverDigest', `sha256:${'d'.repeat(64)}`],
  ['releaseId', 'rc-20260911-118'],
  ['environment', 'staging'],
  ['schemaVersion', 2],
]) {
  test(`rejects a status snapshot with mismatched ${key}`, () => {
    const f = fixture();
    f.put(STATUS, { ...f.status, [key]: value });
    const result = f.observe();
    assert.equal(result.runtimeWorker.readiness.availability, 'identity_mismatch');
    assert.equal(result.retry.allowed, false);
  });
}
for (const offset of [-5001, 1001]) {
  test(`rejects stale or future readiness by ${offset}ms`, () => {
    const f = fixture();
    f.put(STATUS, { ...f.status, sampledAt: new Date(NOW + offset).toISOString() });
    assert.equal(f.observe().runtimeWorker.readiness.availability, 'stale_or_unprotected');
    assert.equal(f.observe().retry.allowed, false);
  });
}
for (const metadata of [{ uid: 1000 }, { mode: 0o644 }]) {
  test(`does not trust unprotected private evidence ${JSON.stringify(metadata)}`, () => {
    const f = fixture();
    f.put(STATUS, f.status, metadata);
    assert.equal(f.observe().retry.allowed, false);
  });
}
for (const status of ['drifted', 'unverifiable', 'unavailable']) {
  test(`does not let a stale consistent sidecar override private config ${status}`, () => {
    const f = fixture();
    f.put(CONFIG, { status, releaseId: RELEASE });
    assert.equal(f.observe().retry.allowed, false);
  });
}
test('private config must belong to active release', () => {
  const f = fixture();
  f.put(CONFIG, { status: 'consistent', releaseId: 'rc-20260911-116' });
  assert.equal(f.observe().retry.reasonCode, 'worker_config_release_mismatch');
});
test('legacy readyfile withdrawal remains unknown instead of assuming memory pressure', () => {
  const f = fixture();
  f.files.delete(STATUS);
  assert.equal(f.observe().retry.reasonCode, 'worker_readiness_reason_unavailable');
  assert.equal(f.observe().retry.allowed, false);
});
test('retention authority unavailable is not a transient memory retry', () => {
  const f = fixture();
  f.put(STATUS, {
    ...f.status,
    admission: {
      state: 'paused',
      admitting: false,
      reason: 'runtime_event_retention_status_unavailable',
    },
  });
  assert.equal(f.observe().retry.allowed, false);
});
for (const state of ['config_refresh_slow', 'config_refresh_timeout']) {
  test(`${state} can be re-observed only while all process identities remain bound`, () => {
    const f = fixture();
    f.put(STATUS, { ...f.status, state });
    assert.equal(f.observe().retry.allowed, true);
    f.put('/proc/101/cgroup', '0::/system.slice/agent-saas-runtime-worker@green.service-extra\n');
    assert.equal(f.observe().retry.allowed, false);
  });
}
test('draining and unreadable drain state both stop retries', () => {
  const f = fixture();
  f.put('/run/agent-saas-runtime-worker-green.draining', '101');
  assert.equal(f.observe().retry.reasonCode, 'worker_draining');
  f.files.set(
    '/run/agent-saas-runtime-worker-green.draining',
    Object.assign(new Error('secret'), { code: 'EACCES' }),
  );
  assert.equal(f.observe().retry.reasonCode, 'worker_drain_unverifiable');
});
test('diagnostic errno rejects arbitrary strings and serialized hostile content', () => {
  assert.equal(safeErrno({ code: 'API_TOKEN=secret' }), 'UNKNOWN');
  const f = fixture();
  f.put(STATUS, '{ secret: NEVER_EXPORT_ME');
  assert.equal(f.observe().retry.allowed, false);
  assert.doesNotMatch(JSON.stringify(f.observe()), /NEVER_EXPORT_ME/u);
});
test('real diagnostic file reader is bounded, no-follow and non-blocking for FIFOs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'production-diagnostic-'));
  try {
    const path = join(dir, 'status');
    writeFileSync(path, 'safe', { mode: 0o600 });
    assert.equal(readDiagnosticFile(path).text, 'safe');
    assert.equal(readDiagnosticFile(path).mode, 0o600);
    assert.throws(() => readDiagnosticFile(path, 2));
    symlinkSync(path, join(dir, 'link'));
    assert.throws(() => readDiagnosticFile(join(dir, 'link')));
    writeFileSync(path, Buffer.from([0xff]));
    assert.throws(() => readDiagnosticFile(path));
    execFileSync('mkfifo', [join(dir, 'fifo')]);
    assert.throws(() => readDiagnosticFile(join(dir, 'fifo')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('slow systemd observations do not misclassify a freshly published sidecar as future evidence', (t) => {
  const f = fixture();
  let time = NOW;
  t.mock.method(Date, 'now', () => time);
  f.options.now = undefined;
  const show = f.options.show;
  f.options.show = (unit) => {
    time += 2000;
    f.put(STATUS, { ...f.status, sampledAt: new Date(time).toISOString() });
    return show(unit);
  };
  const result = f.observe();
  assert.equal(result.runtimeWorker.readiness.availability, 'current');
  assert.equal(result.retry.allowed, true);
  assert.equal(result.observedAt, new Date(NOW + 4000).toISOString());
});

test('re-observes a same-generation readyfile that recovered between the reader and diagnostic sample', () => {
  const f = fixture();
  f.put(READY, '101\n');
  f.put(STATUS, { ...f.status, state: 'ready', admission: { state: 'healthy', admitting: true } });
  assert.equal(f.observe().retry.allowed, true);
  f.files.delete(READY);
  assert.equal(f.observe().retry.allowed, false);
  f.put(READY, '101\n');
  f.put(STATUS, {
    ...f.status,
    state: 'ready',
    privateSnapshotCurrent: false,
    admission: { state: 'healthy', admitting: true },
  });
  assert.equal(f.observe().retry.allowed, false);
});

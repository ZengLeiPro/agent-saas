import { execFileSync } from 'node:child_process';
import { constants, openSync, closeSync, fstatSync, readSync, realpathSync } from 'node:fs';

const ERRNOS = new Set([
  'ENOENT',
  'EACCES',
  'EPERM',
  'EIO',
  'ENOTDIR',
  'ELOOP',
  'EAGAIN',
  'ETIMEDOUT',
  'ENOSPC',
  'EROFS',
]);
const CONFIG = new Set(['consistent', 'drifted', 'unverifiable', 'not_collected']);
const STATES = new Set([
  'ready',
  'admission_paused',
  'config_drifted',
  'config_unverifiable',
  'config_not_collected',
  'config_unavailable',
  'private_snapshot_unavailable',
  'config_refresh_pending',
  'config_refresh_slow',
  'config_refresh_timeout',
  'config_refresh_failed',
  'projection_failed',
  'draining',
]);
const MEMORY_REASONS = new Set([
  'host_mem_available_low',
  'host_mem_available_critical',
  'worker_cgroup_near_high',
  'memory_psi_full',
  'memory_psi_some',
]);
const ADMISSION_REASONS = new Set([
  ...MEMORY_REASONS,
  'runtime_event_retention_status_unavailable',
  'runtime_worker_not_ready',
]);
const NUMBERS = [
  'totalBytes',
  'availableBytes',
  'psiSomeAvg10',
  'psiFullAvg10',
  'cgroupCurrentBytes',
  'cgroupHighBytes',
  'cgroupMaxBytes',
  'cgroupWorkingSetBytes',
  'cgroupSlabReclaimableBytes',
  'enterAvailableBytes',
  'resumeAvailableBytes',
];
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const SHA = /^[a-f0-9]{40}$/u;
const RELEASE = /^rc-[0-9]{8}-[0-9]{2,}$/u;
const BOOT = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
export const safeErrno = (error) => (ERRNOS.has(error?.code) ? error.code : 'UNKNOWN');
const numeric = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const pidOf = (text) =>
  /^[1-9][0-9]*$/u.test(String(text).trim()) && Number.isSafeInteger(Number(String(text).trim()))
    ? Number(String(text).trim())
    : null;

/** No symlinks, devices, FIFOs, unbounded files, parser excerpts, environment dumps or journals. */
export function readDiagnosticFile(path, limit = 16384) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error('Invalid diagnostic file');
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > limit) throw new Error('Diagnostic exceeds limit');
    return {
      text: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)),
      mode: stat.mode & 0o777,
      uid: stat.uid,
      gid: stat.gid,
    };
  } finally {
    closeSync(fd);
  }
}

function systemd(unit) {
  return execFileSync(
    'systemctl',
    ['show', unit, '--property=MainPID,ActiveState,SubState,ControlGroup'],
    { encoding: 'utf8', timeout: 2000, maxBuffer: 16384, stdio: 'pipe' },
  );
}
function fields(text) {
  return Object.fromEntries(
    String(text)
      .split('\n')
      .map((line) => {
        const i = line.indexOf('=');
        return [line.slice(0, i), line.slice(i + 1)];
      }),
  );
}

export function observeProductionRuntime({
  now,
  read = readDiagnosticFile,
  realpath = realpathSync,
  show = systemd,
  uid = process.getuid?.() ?? null,
} = {}) {
  const file = (path, limit) => {
    try {
      const value = read(path, limit);
      return { ...value, status: 'read', errno: null };
    } catch (error) {
      return { status: 'unreadable', errno: safeErrno(error) };
    }
  };
  const metadata = (value) => ({
    status: value.status,
    errno: value.errno,
    mode: value.mode ?? null,
    uid: value.uid ?? null,
    gid: value.gid ?? null,
  });
  const parse = (value) => {
    try {
      return JSON.parse(value.text);
    } catch {
      return null;
    }
  };
  const boot = file('/proc/sys/kernel/random/boot_id');
  const bootId = BOOT.test(boot.text?.trim() ?? '') ? boot.text.trim() : null;

  const meminfo = file('/proc/meminfo');
  const pressure = file('/proc/pressure/memory');
  const memory = {
    status: meminfo.status,
    errno: meminfo.errno,
    psiStatus: pressure.status,
    psiErrno: pressure.errno,
  };
  for (const [key, output] of [
    ['MemTotal', 'totalBytes'],
    ['MemAvailable', 'availableBytes'],
  ]) {
    const match = meminfo.text?.match(new RegExp(`^${key}:\\s+([0-9]+)\\s+kB$`, 'm'));
    const value = match ? Number(match[1]) * 1024 : undefined;
    if (numeric(value)) memory[output] = value;
  }
  for (const [key, output] of [
    ['some', 'psiSomeAvg10'],
    ['full', 'psiFullAvg10'],
  ]) {
    const match = pressure.text?.match(new RegExp(`^${key}\\s+avg10=([0-9]+(?:\\.[0-9]+)?)`, 'm'));
    const value = match ? Number(match[1]) : undefined;
    if (numeric(value)) memory[output] = value;
  }

  function role(name) {
    const prefix = name === 'api' ? 'agent-saas-server' : 'agent-saas-runtime-worker';
    const marker =
      name === 'api'
        ? '/etc/agent-saas/active-color'
        : '/etc/agent-saas/runtime-worker-active-color';
    const markerFile = file(marker);
    const color = /^(blue|green)$/u.test(markerFile.text?.trim() ?? '')
      ? markerFile.text.trim()
      : null;
    const result = { activeColor: color, marker: metadata(markerFile), identityBound: false };
    if (!color) return result;
    const unit = `${prefix}@${color}.service`;
    const link = `/opt/agent-saas-app/${name === 'api' ? 'color' : 'worker'}/${color}`;
    let artifactDigest = null;
    let linkErrno = null;
    try {
      const target = String(realpath(link));
      if (/^\/opt\/agent-saas-app\/releases\/[a-f0-9]{64}$/u.test(target))
        artifactDigest = `sha256:${target.slice(-64)}`;
    } catch (error) {
      linkErrno = safeErrno(error);
    }
    let properties = {};
    let systemdErrno = null;
    try {
      properties = fields(show(unit));
    } catch (error) {
      systemdErrno = safeErrno(error);
    }
    const mainPid = pidOf(properties.MainPID);
    const pidfile = file(`/run/${prefix}-${color}.pid`);
    const pid = pidOf(pidfile.text);
    const stat = mainPid ? file(`/proc/${mainPid}/stat`) : {};
    const start = stat.text
      ?.slice(stat.text.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/u)[19];
    const processStartTicks = /^[0-9]{1,24}$/u.test(start ?? '') ? start : null;
    const cgroup = mainPid ? file(`/proc/${mainPid}/cgroup`) : {};
    const controlGroup = properties.ControlGroup;
    const cgroupMatches =
      typeof controlGroup === 'string' &&
      controlGroup.startsWith('/') &&
      controlGroup !== '/' &&
      !controlGroup.split('/').includes('..') &&
      cgroup.text
        ?.split('\n')
        .some((line) => line.split(':').slice(2).join(':') === controlGroup) === true;
    const env = file(
      `/etc/agent-saas/${name === 'api' ? 'server' : 'runtime-worker'}-${color}.release.env`,
    );
    const releaseEnv = fields(env.text ?? '');
    const releaseSha = SHA.test(releaseEnv.AGENT_SAAS_RELEASE_SHA ?? '')
      ? releaseEnv.AGENT_SAAS_RELEASE_SHA
      : null;
    const releaseId = RELEASE.test(releaseEnv.AGENT_SAAS_RELEASE_ID ?? '')
      ? releaseEnv.AGENT_SAAS_RELEASE_ID
      : null;
    const serverDigest = DIGEST.test(releaseEnv.AGENT_SAAS_SERVER_DIGEST ?? '')
      ? releaseEnv.AGENT_SAAS_SERVER_DIGEST
      : null;
    const ready = name === 'runtimeWorker' ? file(`/run/${prefix}-${color}.ready`, 128) : null;
    const privateFile = file(`/run/${prefix}-${color}.config-identity.json`);
    const privateSummary = parse(privateFile);
    const configStatus = CONFIG.has(privateSummary?.status) ? privateSummary.status : 'unavailable';
    Object.assign(result, {
      unit,
      artifactDigest,
      linkErrno,
      pid,
      mainPid,
      processStartTicks,
      cgroupMatches,
      activeState: ['active', 'inactive', 'failed', 'activating', 'deactivating'].includes(
        properties.ActiveState,
      )
        ? properties.ActiveState
        : 'unknown',
      subState: ['running', 'dead', 'failed', 'start', 'stop', 'auto-restart'].includes(
        properties.SubState,
      )
        ? properties.SubState
        : 'unknown',
      systemdErrno,
      releaseEnvironment: metadata(env),
      pidfile: { ...metadata(pidfile), pid },
      releaseSha,
      releaseId,
      readyfile: ready ? { ...metadata(ready), pid: pidOf(ready.text) } : null,
      config: {
        ...metadata(privateFile),
        status: configStatus,
        releaseId: RELEASE.test(privateSummary?.releaseId ?? '') ? privateSummary.releaseId : null,
        observedAt: Number.isFinite(Date.parse(privateSummary?.lastObservedAt))
          ? new Date(privateSummary.lastObservedAt).toISOString()
          : null,
      },
    });
    result.identityBound = Boolean(
      bootId &&
      mainPid &&
      mainPid === pid &&
      processStartTicks &&
      cgroupMatches &&
      properties.ActiveState === 'active' &&
      artifactDigest &&
      artifactDigest === serverDigest &&
      releaseSha &&
      releaseId,
    );
    if (name !== 'runtimeWorker') return result;
    result.cgroupMemory = {};
    if (cgroupMatches) {
      for (const [name, output] of [
        ['memory.current', 'currentBytes'],
        ['memory.high', 'highBytes'],
        ['memory.max', 'maxBytes'],
      ]) {
        const value = file(`/sys/fs/cgroup${controlGroup}/${name}`);
        const text = value.text?.trim();
        const bytes = /^[0-9]+$/u.test(text ?? '') ? Number(text) : null;
        result.cgroupMemory[output] = {
          status: value.status,
          errno: value.errno,
          bytes: numeric(bytes) ? bytes : null,
          unlimited: text === 'max',
        };
      }
    }
    const drain = file(`/run/${prefix}-${color}.draining`);
    result.drain = metadata(drain);
    const statusFile = file(`/run/${prefix}-${color}.ready.status.json`);
    const status = parse(statusFile);
    const age = (now ?? Date.now()) - Date.parse(status?.sampledAt);
    const bound =
      result.identityBound &&
      status?.schemaVersion === 1 &&
      status.environment === 'production' &&
      status.pid === mainPid &&
      status.bootId === bootId &&
      status.processStartTicks === processStartTicks &&
      status.serverDigest === artifactDigest &&
      status.releaseSha === releaseSha &&
      status.releaseId === releaseId;
    const current =
      bound &&
      Number.isFinite(age) &&
      age >= -1000 &&
      age <= 5000 &&
      statusFile.uid === 0 &&
      statusFile.mode === 0o600;
    result.readiness = {
      ...metadata(statusFile),
      availability:
        statusFile.status !== 'read'
          ? 'unavailable'
          : !bound
            ? 'identity_mismatch'
            : !current
              ? 'stale_or_unprotected'
              : 'current',
    };
    if (current) {
      result.readiness.state = STATES.has(status.state) ? status.state : 'unknown';
      result.readiness.configStatus = CONFIG.has(status.configStatus)
        ? status.configStatus
        : 'unavailable';
      result.readiness.privateSnapshotCurrent = status.privateSnapshotCurrent === true;
      const admission = status.admission;
      result.readiness.admission = {
        state: ['paused', 'healthy', 'unknown'].includes(admission?.state)
          ? admission.state
          : 'unknown',
        admitting: admission?.admitting === true,
        reason: ADMISSION_REASONS.has(admission?.reason) ? admission.reason : null,
        ...Object.fromEntries(
          NUMBERS.flatMap((key) => (numeric(admission?.[key]) ? [[key, admission[key]]] : [])),
        ),
      };
      result.readiness.refresh = {
        pending: status.refresh?.pending === true,
        slow: status.refresh?.slow === true,
        durationMs: numeric(status.refresh?.durationMs) ? status.refresh.durationMs : null,
      };
    }
    return result;
  }
  const api = role('api');
  const runtimeWorker = role('runtimeWorker');
  const stable =
    api.identityBound &&
    runtimeWorker.identityBound &&
    api.artifactDigest === runtimeWorker.artifactDigest;
  const worker = runtimeWorker;
  let reasonCode = 'runtime_identity_unverifiable';
  let retryable = false;
  if (stable) {
    if (worker.readyfile.errno && worker.readyfile.errno !== 'ENOENT')
      reasonCode = 'worker_readyfile_io_error';
    else if (worker.readyfile.status === 'read' && worker.readyfile.pid !== worker.mainPid)
      reasonCode = 'worker_readyfile_pid_mismatch';
    else if (worker.drain.status === 'read') reasonCode = 'worker_draining';
    else if (worker.drain.errno !== 'ENOENT') reasonCode = 'worker_drain_unverifiable';
    else if (worker.config.status === 'drifted' || worker.readiness.configStatus === 'drifted')
      reasonCode = 'worker_config_drifted';
    else if (worker.config.status === 'unverifiable') reasonCode = 'worker_config_unverifiable';
    else if (worker.config.status === 'unavailable')
      reasonCode = 'worker_config_snapshot_unavailable';
    else if (worker.config.releaseId !== worker.releaseId)
      reasonCode = 'worker_config_release_mismatch';
    else if (worker.readiness.availability !== 'current')
      reasonCode = 'worker_readiness_reason_unavailable';
    else {
      reasonCode = worker.readiness.state;
      const memoryPause =
        reasonCode === 'admission_paused' &&
        MEMORY_REASONS.has(worker.readiness.admission?.reason) &&
        worker.readiness.configStatus === 'consistent' &&
        worker.readiness.privateSnapshotCurrent;
      const refreshWait =
        ['config_refresh_slow', 'config_refresh_timeout'].includes(reasonCode) &&
        ['consistent', 'not_collected'].includes(worker.readiness.configStatus);
      const recovered =
        reasonCode === 'ready' &&
        worker.readyfile.status === 'read' &&
        worker.readyfile.pid === worker.mainPid &&
        worker.config.status === 'consistent' &&
        worker.readiness.configStatus === 'consistent' &&
        worker.readiness.privateSnapshotCurrent &&
        worker.readiness.admission?.admitting === true;
      retryable = Boolean(memoryPause || refreshWait || recovered);
    }
  }
  const identityKey = stable
    ? JSON.stringify([
        bootId,
        ...[api, worker].flatMap((entry) => [
          entry.activeColor,
          entry.mainPid,
          entry.processStartTicks,
          entry.artifactDigest,
          entry.releaseSha,
          entry.releaseId,
        ]),
      ])
    : null;
  return {
    schemaVersion: 1,
    observedAt: new Date(now ?? Date.now()).toISOString(),
    executorUid: uid,
    bootId,
    memory,
    api,
    runtimeWorker,
    retry: { allowed: retryable, reasonCode, identityKey },
  };
}

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ID = /^[1-9][0-9]*$/u;
const STATES = new Set(['running', 'passed', 'failed']);
const REASONS = new Set([
  'runtime_identity_unverifiable',
  'worker_readyfile_io_error',
  'worker_readyfile_pid_mismatch',
  'worker_draining',
  'worker_drain_unverifiable',
  'worker_config_drifted',
  'worker_config_unverifiable',
  'worker_config_snapshot_unavailable',
  'worker_config_release_mismatch',
  'worker_readiness_reason_unavailable',
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
  'unknown',
]);
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
  'UNKNOWN',
]);
const READERS = new Set(['read-production-state.mjs', 'read-live-production-components.mjs']);
export function executionIdentity(runId, runAttempt) {
  if (!ID.test(runId ?? '') || !ID.test(runAttempt ?? ''))
    throw new Error('Preflight run identity is required');
  return { runId, runAttempt };
}
export function writeDiagnosticReport(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
}
function bound(value, context) {
  return (
    value?.schemaVersion === 1 &&
    value.runId === context.runId &&
    value.runAttempt === context.runAttempt &&
    ID.test(value.runId) &&
    ID.test(value.runAttempt)
  );
}
export function safePreflightSummary(value, context) {
  if (
    !bound(value, context) ||
    value.phase !== 'before_production_mutation' ||
    value.scope !== 'current_attempt_only' ||
    !STATES.has(value.status) ||
    !READERS.has(value.reader)
  )
    return null;
  const attempts = Array.isArray(value.attempts) ? value.attempts.slice(0, 32) : [];
  const last = attempts.at(-1);
  const observed = last?.observation;
  const ready = observed?.runtimeWorker?.readyfile;
  return {
    schemaVersion: 1,
    runId: value.runId,
    runAttempt: value.runAttempt,
    phase: value.phase,
    scope: value.scope,
    status: value.status,
    reader: value.reader,
    attempts: attempts.length,
    priorRecoveryRequired: value.priorRecoveryRequired === true,
    failureClass: ['none', 'reader_timeout', 'worker_readiness', 'reader_validation'].includes(
      last?.failureClass,
    )
      ? last.failureClass
      : 'unknown',
    reasonCode: REASONS.has(observed?.retry?.reasonCode) ? observed.retry.reasonCode : 'unknown',
    readyfileErrno: ERRNOS.has(ready?.errno) ? ready.errno : null,
    readyfilePid: Number.isSafeInteger(ready?.pid) && ready.pid > 0 ? ready.pid : null,
    mainPid:
      Number.isSafeInteger(observed?.runtimeWorker?.mainPid) && observed.runtimeWorker.mainPid > 0
        ? observed.runtimeWorker.mainPid
        : null,
    identityChanged: value.identityChanged === true,
    timedOut: value.timedOut === true,
    readerExitCode:
      Number.isSafeInteger(last?.exitCode) && last.exitCode >= 0 && last.exitCode <= 255
        ? last.exitCode
        : null,
  };
}
export function safePrechangeFailure(value, context) {
  if (
    !bound(value, context) ||
    value.phase !== 'before_production_mutation' ||
    value.scope !== 'current_attempt_only' ||
    value.outcome !== 'failed_before_change'
  )
    return null;
  return {
    schemaVersion: 1,
    runId: value.runId,
    runAttempt: value.runAttempt,
    phase: value.phase,
    scope: value.scope,
    outcome: value.outcome,
    priorRecoveryRequired: value.priorRecoveryRequired === true,
  };
}
export function baselineProvenance(source, state) {
  if (!['live', 'last_committed'].includes(source)) throw new Error('Unknown baseline source');
  return {
    schemaVersion: 1,
    source,
    historicalBuildBaseline: source === 'last_committed',
    productionPreflight: source === 'last_committed' ? 'failed' : 'passed',
    promotionAuthorized: false,
    observedAt: Number.isFinite(Date.parse(state?.observedAt))
      ? new Date(state.observedAt).toISOString()
      : null,
  };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [command, output, ...args] = process.argv.slice(2);
  const identity = executionIdentity(process.env.GITHUB_RUN_ID, process.env.GITHUB_RUN_ATTEMPT);
  if (command === 'prechange-failure') {
    if (!['fresh', 'retry_before_change', 'retry_after_change'].includes(args[0]))
      throw new Error('Explicit preflight retry mode is required');
    writeDiagnosticReport(output, {
      schemaVersion: 1,
      ...identity,
      phase: 'before_production_mutation',
      scope: 'current_attempt_only',
      outcome: 'failed_before_change',
      priorRecoveryRequired: args[0] === 'retry_after_change',
    });
  } else if (command === 'baseline') {
    const value = baselineProvenance(args[0], JSON.parse(readFileSync(args[1], 'utf8')));
    writeDiagnosticReport(output, { ...value, ...identity });
    process.stdout.write(
      `Production baseline: ${value.source}; current preflight: ${value.productionPreflight}; promotion authorization: NOT granted.\n`,
    );
  } else if (command === 'transfer') {
    const codes = args.map(Number);
    if (
      codes.length !== 2 ||
      codes.some((code) => !Number.isInteger(code) || code < 0 || code > 255)
    )
      throw new Error('Invalid preflight transfer status');
    writeDiagnosticReport(output, {
      schemaVersion: 1,
      ...identity,
      readerExitCode: codes[0],
      diagnosticsTransferExitCode: codes[1],
    });
  } else throw new Error('Unknown preflight report command');
}

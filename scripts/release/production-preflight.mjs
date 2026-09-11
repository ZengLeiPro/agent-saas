import { spawnSync } from 'node:child_process';
import { linkSync, lstatSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { observeProductionRuntime } from './production-runtime-observation.mjs';
import { executionIdentity, writeDiagnosticReport } from './production-preflight-report.mjs';

const READERS = new Set(['read-production-state.mjs', 'read-live-production-components.mjs']);
const STAGES = new Set(['steady-state', 'candidate-readback']);
const RETRIES = new Set(['fresh', 'retry_before_change', 'retry_after_change']);
const root = dirname(fileURLToPath(import.meta.url));

export async function runProductionPreflight(options, dependencies = {}) {
  const {
    reader,
    configIdentityStage = 'steady-state',
    output,
    diagnostics,
    retryMode = 'fresh',
  } = options;
  if (
    !READERS.has(reader) ||
    !STAGES.has(configIdentityStage) ||
    !RETRIES.has(retryMode) ||
    !output ||
    !diagnostics ||
    output === diagnostics
  )
    throw new Error('Invalid production preflight request');
  if (reader === 'read-production-state.mjs' && configIdentityStage !== 'steady-state')
    throw new Error('Steady-state reader cannot use a candidate stage');
  const identity = executionIdentity(options.runId, options.runAttempt);
  const clock = dependencies.clock ?? (() => performance.now());
  const observe = dependencies.observe ?? (() => observeProductionRuntime());
  const sleep = dependencies.sleep ?? delay;
  const deadlineMs = dependencies.deadlineMs ?? 75_000;
  const intervalMs = dependencies.intervalMs ?? 2_000;
  if (
    !Number.isFinite(deadlineMs) ||
    deadlineMs <= 0 ||
    !Number.isFinite(intervalMs) ||
    intervalMs <= 0
  )
    throw new Error('Invalid observation budget');
  const end = clock() + deadlineMs;
  const execute =
    dependencies.execute ??
    ((candidate, remaining) => {
      const result = spawnSync(
        process.execPath,
        [
          resolve(root, reader),
          '--config-identity-stage',
          configIdentityStage,
          '--output',
          candidate,
        ],
        {
          encoding: 'utf8',
          stdio: 'pipe',
          timeout: Math.max(1, Math.min(30_000, Math.floor(remaining))),
          killSignal: 'SIGKILL',
          maxBuffer: 65536,
        },
      );
      return {
        exitCode: result.status ?? (result.error?.code === 'ETIMEDOUT' ? 124 : 1),
        workerReadinessFailure:
          /Unable to read production readyfile for runtimeWorker|Worker readyfile does not match systemd MainPID|Production Runtime Worker ConfigIdentity/u.test(
            String(result.stderr ?? ''),
          ),
      };
    });
  const report = {
    schemaVersion: 1,
    ...identity,
    reader,
    configIdentityStage,
    phase: 'before_production_mutation',
    scope: 'current_attempt_only',
    status: 'running',
    priorRecoveryRequired: retryMode === 'retry_after_change',
    attempts: [],
  };
  writeDiagnosticReport(diagnostics, report);
  try {
    lstatSync(output);
    throw new Error('Preflight refuses an existing output');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      report.status = 'failed';
      writeDiagnosticReport(diagnostics, report);
      throw error;
    }
  }
  let firstIdentity;
  let success = false;
  try {
    while (clock() < end && report.attempts.length < 32) {
      const candidate = `${output}.preflight-${process.pid}-${report.attempts.length + 1}`;
      try {
        const result = await execute(candidate, end - clock());
        let observation;
        try {
          observation = observe();
        } catch {
          observation = {
            schemaVersion: 1,
            retry: {
              allowed: false,
              reasonCode: 'runtime_identity_unverifiable',
              identityKey: null,
            },
          };
        }
        const failureClass =
          result.exitCode === 0
            ? 'none'
            : result.exitCode === 124
              ? 'reader_timeout'
              : result.workerReadinessFailure
                ? 'worker_readiness'
                : 'reader_validation';
        report.attempts.push({ exitCode: result.exitCode, failureClass, observation });
        const observedIdentity = observation.retry?.identityKey;
        if (firstIdentity !== undefined && observedIdentity !== firstIdentity) {
          report.identityChanged = true;
          break;
        }
        if (clock() >= end) {
          report.timedOut = true;
          break;
        }
        if (result.exitCode === 0) {
          // The ORIGINAL strict reader is the only authority. Diagnostic snapshots never authorize writes.
          const state = JSON.parse(readFileSync(candidate, 'utf8'));
          if (
            state.environment !== 'production' ||
            !state.components ||
            Array.isArray(state.components)
          )
            throw new Error('Reader produced an invalid production state');
          linkSync(candidate, output); // Atomic create-only; never replace a previous observation.
          success = true;
          break;
        }
        if (
          !result.workerReadinessFailure ||
          observation.retry?.allowed !== true ||
          !observedIdentity
        )
          break;
        firstIdentity ??= observedIdentity;
        writeDiagnosticReport(diagnostics, report);
        await sleep(Math.min(intervalMs, Math.max(0, end - clock())));
      } finally {
        rmSync(candidate, { force: true });
      }
    }
  } finally {
    report.status = success ? 'passed' : 'failed';
    if (!success && clock() >= end) report.timedOut = true;
    writeDiagnosticReport(diagnostics, report);
  }
  return { ok: success, report };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const flags = {};
    for (let i = 2; i < process.argv.length; i += 2) {
      const key = process.argv[i];
      if (
        ![
          '--reader',
          '--config-identity-stage',
          '--output',
          '--diagnostics',
          '--retry-mode',
          '--run-id',
          '--run-attempt',
        ].includes(key) ||
        !process.argv[i + 1] ||
        Object.hasOwn(flags, key)
      )
        throw new Error('Invalid preflight flags');
      flags[key] = process.argv[i + 1];
    }
    const result = await runProductionPreflight({
      reader: flags['--reader'],
      configIdentityStage: flags['--config-identity-stage'],
      output: flags['--output'],
      diagnostics: flags['--diagnostics'],
      retryMode: flags['--retry-mode'],
      runId: flags['--run-id'],
      runAttempt: flags['--run-attempt'],
    });
    if (!result.ok) {
      const last = result.report.attempts.at(-1)?.observation;
      process.stderr.write(
        `Strict production reader rejected; worker observation=${last?.retry?.reasonCode ?? 'unknown'}; readyfile errno=${last?.runtimeWorker?.readyfile?.errno ?? 'none'}; attempts=${result.report.attempts.length}. See production-preflight.json.\n`,
      );
      process.exitCode = 1;
    }
  } catch {
    process.stderr.write(
      'Production preflight failed; no production mutation was attempted by this reader.\n',
    );
    process.exitCode = 1;
  }
}

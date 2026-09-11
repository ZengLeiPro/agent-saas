import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

// All stages share ONE deadline. The 120-minute Actions job retains 15 minutes
// for checkout, re-verification, receipt upload and cleanup. Stage limits are
// ceilings, not additive allocations; no stage may reset the overall budget.
export const SUBMIT_LIMITS = Object.freeze({
  totalMs: 105 * 60_000,
  preflightMs: 2 * 60_000,
  uploadMs: 45 * 60_000,
  processingMs: 90 * 60_000,
  internalMs: 30 * 60_000,
  heartbeatMs: 30_000,
  pollMs: 20_000,
  killGraceMs: 5_000,
});

const states = new Set([
  'STARTING', 'RUNNING', 'BUILD_FOUND', 'BUILD_NOT_FOUND', 'NOT_VISIBLE',
  'PROCESSING', 'VALID', 'FAILED', 'INVALID', 'IN_BETA_TESTING',
  'MISSING_EXPORT_COMPLIANCE', 'PROCESSING_EXCEPTION', 'EXPIRED',
  'READY_FOR_BETA_TESTING', 'IN_EXPORT_COMPLIANCE_REVIEW', 'UNKNOWN',
]);

export class SubmissionProgress {
  constructor({ limits = SUBMIT_LIMITS, signal, log = console.log, summaryPath } = {}) {
    this.limits = limits;
    this.signal = signal;
    this.log = log;
    this.summaryPath = summaryPath;
    this.started = performance.now();
    this.deadline = this.started + limits.totalMs;
  }

  check() {
    this.signal?.throwIfAborted();
    if (performance.now() >= this.deadline) throw new Error('Overall TestFlight submission deadline exceeded');
  }

  async run(stage, limitMs, action) {
    assert.match(stage, /^[a-z-]+$/u);
    this.check();
    const started = performance.now();
    const budgetMs = Math.min(limitMs, this.deadline - started);
    assert.ok(budgetMs > 0 && budgetMs <= 105 * 60_000, 'Invalid submission stage budget');
    const end = started + budgetMs;
    const deadlineUtc = new Date(Date.now() + budgetMs).toISOString();
    const controller = new AbortController();
    const abort = () => controller.abort(this.signal.reason);
    this.signal?.addEventListener('abort', abort, { once: true });
    let state = 'STARTING';
    let outputBytes = 0;
    let lastOutput;
    const emit = (event, summarize = false) => {
      const now = performance.now();
      const record = {
        stage, event, state,
        elapsedSeconds: Math.floor((now - started) / 1000),
        remainingSeconds: Math.max(0, Math.ceil((end - now) / 1000)),
        overallRemainingSeconds: Math.max(0, Math.ceil((this.deadline - now) / 1000)),
        deadlineUtc,
        ...(stage === 'upload' ? {
          toolOutputBytes: outputBytes,
          lastToolOutputSecondsAgo: lastOutput === undefined ? null : Math.floor((now - lastOutput) / 1000),
        } : {}),
      };
      // Only fixed stage/state enums and numeric counters are public. Tool
      // stdout/stderr, credentials, tokens and server response bodies are not.
      this.log(`[App Store Connect] ${JSON.stringify(record)}`);
      if (summarize && this.summaryPath) {
        appendFileSync(this.summaryPath, `\n- ${stage}: **${event}**; state=${state}; elapsed=${record.elapsedSeconds}s; remaining=${record.remainingSeconds}s; deadline=${deadlineUtc}\n`);
      }
    };
    const timer = setTimeout(() => controller.abort(new Error(`${stage} deadline exceeded`)), Math.ceil(budgetMs));
    const heartbeat = setInterval(() => emit('heartbeat'), this.limits.heartbeatMs);
    const phase = {
      signal: controller.signal,
      state(next) {
        const safe = states.has(next) ? next : 'UNKNOWN';
        if (safe !== state) { state = safe; emit('state'); }
      },
      activity(bytes) { outputBytes += bytes; lastOutput = performance.now(); },
      async sleep(ms) { await delay(ms, undefined, { signal: controller.signal }); },
    };
    try {
      emit('started', true);
      const result = await action(phase);
      controller.signal.throwIfAborted();
      this.check();
      emit('completed', true);
      return result;
    } catch (error) {
      emit(this.signal?.aborted ? 'cancelled' : controller.signal.aborted ? 'timed-out' : 'failed', true);
      throw controller.signal.aborted ? controller.signal.reason : error;
    } finally {
      clearTimeout(timer);
      clearInterval(heartbeat);
      this.signal?.removeEventListener('abort', abort);
    }
  }
}

// Never stream arbitrary altool text into a public Actions log. Drain both
// streams continuously, retain at most 16 KiB, and expose only ITMS error codes.
// Heartbeats report tool activity, NOT an invented upload percentage.
export async function runUploadProcess(command, args, {
  env, descriptor, phase, killGraceMs = SUBMIT_LIMITS.killGraceMs,
} = {}) {
  phase.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let child;
    let stopping;
    let escalation;
    let tail = Buffer.alloc(0);
    let spawnError;
    const grouped = process.platform !== 'win32';
    const kill = (signal) => {
      if (!child?.pid) return;
      try {
        if (grouped) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if (error.code !== 'ESRCH') spawnError = 'PROCESS_CLEANUP_ERROR';
      }
    };
    const abort = () => {
      if (stopping) return;
      stopping = phase.signal.reason || new Error('Upload cancelled');
      kill('SIGTERM');
      escalation = setTimeout(() => kill('SIGKILL'), killGraceMs);
    };
    const consume = (chunk) => {
      phase.activity(chunk.length);
      tail = Buffer.concat([tail, chunk.subarray(-16 * 1024)]).subarray(-16 * 1024);
    };
    try {
      child = spawn(command, args, {
        env, detached: grouped, shell: false,
        stdio: ['ignore', 'pipe', 'pipe', ...(descriptor === undefined ? [] : [descriptor])],
      });
    } catch {
      reject(new Error('Unable to start Apple upload tool'));
      return;
    }
    phase.signal.addEventListener('abort', abort, { once: true });
    if (phase.signal.aborted) abort();
    phase.state('RUNNING');
    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    child.on('error', (error) => {
      spawnError = ['ENOENT', 'EACCES'].includes(error.code) ? error.code : 'SPAWN_ERROR';
    });
    // close, not exit: a helper process can still hold the output pipe open.
    child.on('close', (code, signal) => {
      clearTimeout(escalation);
      phase.signal.removeEventListener('abort', abort);
      // Also reap descendants that closed their pipes but outlived the leader.
      kill('SIGKILL');
      const codes = [...new Set(tail.toString('utf8').match(/\bITMS-[0-9]{4,6}\b/gu) || [])].slice(0, 10);
      tail = Buffer.alloc(0);
      if (stopping) reject(stopping);
      else if (spawnError) reject(new Error(`Unable to run Apple upload tool (${spawnError})`));
      else if (code !== 0) reject(new Error(`Apple binary upload failed (exit=${code}, signal=${signal || 'none'}, codes=${codes.join(',') || 'none'}); inspect App Store Connect Build Uploads`));
      else resolve('Apple upload command completed; processing is checked separately');
    });
  });
}

export async function uploadIpa(ipaPath, credentials, privateKeysDirectory, phase) {
  // An isolated directory prevents stale keys from breaking wx writes and lets
  // finally clean up only this invocation, including open/spawn/timeout errors.
  mkdirSync(privateKeysDirectory, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(privateKeysDirectory, 'upload-'));
  let descriptor;
  try {
    writeFileSync(join(directory, `AuthKey_${credentials.keyId}.p8`), credentials.privateKey, { mode: 0o600, flag: 'wx' });
    descriptor = openSync(ipaPath, 'r');
    const env = { ...process.env, API_PRIVATE_KEYS_DIR: directory };
    delete env.APP_STORE_CONNECT_API_KEY_P8;
    return await runUploadProcess('xcrun', [
      'altool', '--upload-app', '--file', '/dev/fd/3', '--type', 'ios',
      '--apiKey', credentials.keyId, '--apiIssuer', credentials.issuerId,
      '--output-format', 'json',
    ], { env, descriptor, phase });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(directory, { recursive: true, force: true });
  }
}

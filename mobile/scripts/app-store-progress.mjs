import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, chmodSync, closeSync, constants, copyFileSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { UploadOutput, UploadResultError } from './app-store-upload-result.mjs';
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
  visibilityMs: 15 * 60_000,
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
  'UPLOAD_REPORTED_SUCCESS', 'UPLOAD_REJECTED', 'UPLOAD_UNCONFIRMED',
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

  identify(identity) {
    assert.match(identity.appId ?? '', /^[1-9][0-9]{1,19}$/u, 'Invalid submission app ID');
    assert.match(identity.version ?? '', /^[0-9]{1,5}(?:\.[0-9]{1,5}){0,2}$/u, 'Invalid submission version');
    assert.match(identity.buildNumber ?? '', /^[0-9]{1,20}(?:\.[0-9]{1,20}){0,2}$/u, 'Invalid submission build number');
    this.identity = { appId: identity.appId, version: identity.version, buildNumber: identity.buildNumber };
    if (this.summaryPath) appendFileSync(this.summaryPath, `\n### Exact TestFlight target\n\nApp: ${identity.appId}; version: ${identity.version}; build: ${identity.buildNumber}. A tool receipt is not build processing success.\n`);
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
    let uploadDiagnostic;
    const emit = (event, summarize = false) => {
      const now = performance.now();
      const record = {
        stage, event, state,
        ...(this.identity || {}),
        ...(uploadDiagnostic ? { uploadDiagnostic } : {}),
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
        if (uploadDiagnostic) appendFileSync(this.summaryPath, `\nUpload diagnostic (no raw tool output):\n\n\`\`\`json\n${JSON.stringify(uploadDiagnostic)}\n\`\`\`\n`);
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
      uploadResult(diagnostic) { uploadDiagnostic = diagnostic; emit('upload-result', true); },
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
// streams continuously, parse bounded receipts, and expose only safe diagnostics.
// Heartbeats report tool activity, NOT an invented upload percentage.
export async function runUploadProcess(command, args, {
  env, descriptor, phase, killGraceMs = SUBMIT_LIMITS.killGraceMs,
} = {}) {
  phase.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let child;
    let stopping;
    let escalation;
    const output = new UploadOutput();
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
    const consume = (name, chunk) => {
      phase.activity(chunk.length);
      output.consume(name, chunk);
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
    child.stdout.on('data', (chunk) => consume('stdout', chunk));
    child.stderr.on('data', (chunk) => consume('stderr', chunk));
    child.on('error', (error) => {
      spawnError = ['ENOENT', 'EACCES'].includes(error.code) ? error.code : 'SPAWN_ERROR';
    });
    // close, not exit: a helper process can still hold the output pipe open.
    child.on('close', (code, signal) => {
      clearTimeout(escalation);
      phase.signal.removeEventListener('abort', abort);
      // Also reap descendants that closed their pipes but outlived the leader.
      kill('SIGKILL');
      if (stopping) { reject(stopping); return; }
      if (spawnError) { reject(new Error(`Unable to run Apple upload tool (${spawnError})`)); return; }
      try {
        const diagnostic = output.finish(code, signal);
        phase.state(diagnostic.accepted ? 'UPLOAD_REPORTED_SUCCESS'
          : diagnostic.reason === 'TOOL_REPORTED_ERROR' || diagnostic.reason === 'PROCESS_EXIT_ERROR' ? 'UPLOAD_REJECTED' : 'UPLOAD_UNCONFIRMED');
        phase.uploadResult?.(diagnostic);
        if (!diagnostic.accepted) throw new UploadResultError(diagnostic);
        resolve(diagnostic);
      } catch (error) { reject(error); }
    });
  });
}

export class UploadIntegrityError extends Error {}
function requireIntegrity(valid, message) {
  if (!valid) throw new UploadIntegrityError(message);
}

async function fileHash(path, descriptor) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path, descriptor === undefined ? {} : { fd: descriptor, autoClose: false, start: 0 })) hash.update(bytes);
  return hash.digest('hex');
}

export async function uploadIpa(ipaPath, credentials, privateKeysDirectory, phase) {
  // altool expects a regular named .ipa, not a process-local /dev/fd/3. Its
  // helpers may reopen the file. Make a private read-only byte-identical copy;
  // keep the original descriptor open and recheck both hashes before success.
  mkdirSync(privateKeysDirectory, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(privateKeysDirectory, 'upload-'));
  let descriptor;
  try {
    phase.signal.throwIfAborted();
    const stat = lstatSync(ipaPath);
    requireIntegrity(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0, 'Upload IPA must be a nonempty regular file');
    descriptor = openSync(ipaPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    requireIntegrity(opened.ino === stat.ino && opened.dev === stat.dev, 'Upload IPA changed while opening');
    const before = await fileHash(ipaPath, descriptor);
    const staged = join(directory, 'upload.ipa');
    copyFileSync(ipaPath, staged, constants.COPYFILE_EXCL);
    chmodSync(staged, 0o400);
    requireIntegrity(await fileHash(staged) === before, 'Staged IPA digest mismatch');
    const keys = join(directory, 'private_keys');
    mkdirSync(keys, { mode: 0o700 });
    writeFileSync(join(keys, `AuthKey_${credentials.keyId}.p8`), credentials.privateKey, { mode: 0o600, flag: 'wx' });
    const env = { ...process.env, API_PRIVATE_KEYS_DIR: keys };
    delete env.APP_STORE_CONNECT_API_KEY_P8;
    const result = await runUploadProcess('xcrun', [
      'altool', '--upload-app', '--file', staged, '--type', 'ios',
      '--apiKey', credentials.keyId, '--apiIssuer', credentials.issuerId,
      '--output-format', 'json',
    ], { env, phase });
    phase.signal.throwIfAborted();
    requireIntegrity(await fileHash(staged) === before, 'Uploaded IPA copy changed');
    requireIntegrity(await fileHash(ipaPath, descriptor) === before, 'Original IPA changed during upload');
    return result;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(directory, { recursive: true, force: true });
  }
}

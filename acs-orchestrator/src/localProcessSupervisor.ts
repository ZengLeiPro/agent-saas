import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { OWNED_WAIT_BUDGETS } from './ownedWait.js';

export interface LocalProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** No local process event proves that a remote exec command has stopped. */
  remoteState?: 'unknown' | 'not_started';
  reason?: 'aborted' | 'timeout' | 'stdio_timeout' | 'spawn_error' | 'output_limit';
}

export interface LocalProcessOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  collectOutput?: boolean;
  maxOutputBytes?: number;
}

const supervised = new WeakMap<ChildProcessWithoutNullStreams, Promise<LocalProcessResult>>();

export function localProcessResult(
  child: ChildProcessWithoutNullStreams,
  options: LocalProcessOptions = {},
): Promise<LocalProcessResult> {
  const existing = supervised.get(child);
  if (existing) return existing;
  const task = superviseLocalProcess(child, options);
  supervised.set(child, task);
  return task;
}

/** Bounds transport cleanup; it is deliberately not a remote process supervisor. */
export function superviseLocalProcess(
  child: ChildProcessWithoutNullStreams,
  options: LocalProcessOptions = {},
): Promise<LocalProcessResult> {
  return new Promise((resolve) => {
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let reason: LocalProcessResult['reason'];
    let stdout = '';
    let stderr = '';
    let collected = 0;
    const maxBytes = options.maxOutputBytes ?? 8 * 1024 * 1024;
    const outDecoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (callback: () => void, ms: number) => {
      const timer = setTimeout(() => { timers.delete(timer); callback(); }, ms);
      timer.unref?.();
      timers.add(timer);
    };
    const signal = (value: NodeJS.Signals) => {
      // child.killed means kill(2) was requested, not that an exit was observed.
      if (exited) return;
      try { child.kill(value); } catch { /* The result remains unknown. */ }
    };
    const finish = (forced: boolean) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      options.signal?.removeEventListener('abort', onAbort);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      stdout += outDecoder.end();
      stderr += errDecoder.end();
      if (forced) {
        // A descendant can retain stdio forever. Closing our pipes only ends the
        // local wait; the ownership layer retains the remote uncertainty.
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      }
      resolve({
        stdout, stderr,
        exitCode: reason ? -1 : exitCode,
        signal: exitSignal,
        ...(reason ? { reason, remoteState: child.pid ? 'unknown' as const : 'not_started' as const } : {}),
      });
    };
    const terminate = (cause: NonNullable<LocalProcessResult['reason']>) => {
      if (settled || reason) return;
      reason = cause;
      signal('SIGTERM');
      later(() => {
        signal('SIGKILL');
        later(() => finish(true), OWNED_WAIT_BUDGETS.killGraceMs);
      }, OWNED_WAIT_BUDGETS.termGraceMs);
    };
    const collect = (chunk: Buffer | string, decoder: StringDecoder, channel: 'stdout' | 'stderr') => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, maxBytes - collected);
      const accepted = bytes.subarray(0, remaining);
      collected += accepted.length;
      const text = decoder.write(accepted);
      if (channel === 'stdout') stdout += text;
      else stderr += text;
      if (accepted.length < bytes.length) terminate('output_limit');
    };
    const onStdout = (chunk: Buffer | string) => collect(chunk, outDecoder, 'stdout');
    const onStderr = (chunk: Buffer | string) => collect(chunk, errDecoder, 'stderr');
    const onAbort = () => terminate('aborted');
    if (options.collectOutput !== false) {
      child.stdout.on('data', onStdout);
      child.stderr.on('data', onStderr);
    }
    child.on('error', () => {
      if (settled) return;
      reason ??= 'spawn_error';
      // A spawn error without a pid proves no process started. An error after
      // spawn does not; bound its remaining local cleanup normally.
      if (!child.pid) finish(true);
      else {
        signal('SIGTERM');
        later(() => { signal('SIGKILL'); later(() => finish(true), OWNED_WAIT_BUDGETS.killGraceMs); }, OWNED_WAIT_BUDGETS.termGraceMs);
      }
    });
    child.stdin.on('error', () => terminate('spawn_error'));
    child.stdout.on('error', () => terminate('stdio_timeout'));
    child.stderr.on('error', () => terminate('stdio_timeout'));
    child.on('exit', (code, value) => {
      if (settled) return;
      exited = true;
      exitCode = code;
      exitSignal = value;
      later(() => { reason ??= 'stdio_timeout'; finish(true); }, OWNED_WAIT_BUDGETS.killGraceMs);
    });
    child.on('close', (code, value) => {
      exited = true;
      exitCode = code;
      exitSignal = value;
      finish(false);
    });
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    if (options.timeoutMs !== undefined) {
      if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) terminate('timeout');
      else later(() => terminate('timeout'), options.timeoutMs);
    }
  });
}

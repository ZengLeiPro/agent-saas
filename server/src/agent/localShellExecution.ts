import { spawn } from 'child_process';
import { existsSync } from 'fs';

import type { ToolInvocationStreamChunk, ToolInvocationResponse } from '../runtime/handProtocol.js';
import type { WorkspaceRef } from './toolRuntime.js';
import { persistShellOutputFiles } from './shellOutputFiles.js';
import {
  DEFAULT_SHELL_TIMEOUT_MS,
  MAX_SHELL_CAPTURE_BYTES,
  MAX_SHELL_STREAM_BYTES,
  formatShellOutput,
} from './toolOutput.js';

export interface LocalShellExecutionOptions {
  workspace: WorkspaceRef;
  command: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onChunk?: (chunk: ToolInvocationStreamChunk) => void | Promise<void>;
  invocationId?: string;
  runtimeEnv?: Record<string, string>;
  envBuilder?: (workspace: WorkspaceRef) => Record<string, string>;
  findDeniedPathMention: (workspace: WorkspaceRef, command: string) => string | undefined;
}

export async function runLocalShellStreaming(options: LocalShellExecutionOptions): Promise<ToolInvocationResponse> {
  const { workspace, command, timeoutMs, signal, onChunk, invocationId, runtimeEnv } = options;
  return await new Promise<ToolInvocationResponse>((resolvePromise) => {
    const deniedPath = options.findDeniedPathMention(workspace, command);
    if (deniedPath) {
      resolvePromise({
        status: 'error',
        error: `server-local sandbox denied command referencing protected path: ${deniedPath}`,
        metadata: { sandboxDenied: true, path: deniedPath },
      });
      return;
    }
    // P4 防御纵深：spawn 子进程 env 走 envBuilder（按 workspace.tenantId 隔离敏感凭据）。
    // envBuilder 未注入时（旧测试 / 内部直调 ServerLocalExecutionProvider）保持 process.env
    // 旧行为，避免破坏向后兼容；生产路径通过 createDefaultExecutionTransportRegistry({ envBuilder })
    // 在 app/runtime.ts 装配时强制注入。
    const childEnv = {
      ...(options.envBuilder
        ? options.envBuilder(workspace)
        : (process.env as Record<string, string>)),
      ...(runtimeEnv ?? {}),
    };
    const child = spawn(command, {
      cwd: workspace.root,
      env: childEnv,
      shell: process.platform === 'win32' || !existsSync('/bin/bash') ? true : '/bin/bash',
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let streamedBytes = 0;
    let streamSuppressed = false;
    let timedOut = false;
    let aborted = false;
    let outputExceeded = false;
    let spawnError: Error | undefined;
    const startedAt = Date.now();
    const timeoutValue = timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS;
    let settled = false;
    let finalizing = false;
    let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
    let hardFinalizeTimer: ReturnType<typeof setTimeout> | undefined;
    let killStarted = false;
    const finish = (response: ToolInvocationResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      if (hardFinalizeTimer) clearTimeout(hardFinalizeTimer);
      signal?.removeEventListener('abort', onAbort);
      resolvePromise(response);
    };
    const killWithSignal = (signalName: NodeJS.Signals) => {
      if (child.pid && process.platform !== 'win32') {
        try { process.kill(-child.pid, signalName); return; } catch { /* fallback below */ }
      }
      if (!child.killed) child.kill(signalName);
    };
    const kill = () => {
      if (killStarted || settled) return;
      killStarted = true;
      killWithSignal('SIGTERM');
      sigkillTimer = setTimeout(() => {
        if (settled) return;
        killWithSignal('SIGKILL');
        hardFinalizeTimer = setTimeout(() => {
          void finalize(null, 'SIGKILL');
        }, 2_000);
        hardFinalizeTimer.unref?.();
      }, 2_000);
      sigkillTimer.unref?.();
    };
    const onAbort = () => {
      aborted = true;
      kill();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutValue);
    timer.unref?.();
    const emitStreamChunk = (channel: 'stdout' | 'stderr', text: string, chunkBytes: number) => {
      if (!onChunk || streamSuppressed) return;
      const remainingBytes = MAX_SHELL_STREAM_BYTES - streamedBytes;
      if (remainingBytes <= 0) {
        streamSuppressed = true;
        void onChunk({ type: 'progress', message: `Shell stream output truncated after ${MAX_SHELL_STREAM_BYTES} bytes; final result keeps a head/tail summary.` });
        return;
      }
      if (chunkBytes <= remainingBytes) {
        streamedBytes += chunkBytes;
        void onChunk({ type: 'output', channel, content: text });
        return;
      }
      streamedBytes = MAX_SHELL_STREAM_BYTES;
      streamSuppressed = true;
      void onChunk({ type: 'output', channel, content: text.slice(0, remainingBytes) });
      void onChunk({ type: 'progress', message: `Shell stream output truncated after ${MAX_SHELL_STREAM_BYTES} bytes; final result keeps a head/tail summary.` });
    };
    const emit = (channel: 'stdout' | 'stderr', chunk: Buffer) => {
      if (settled || finalizing || outputExceeded) return;
      const text = chunk.toString('utf-8');
      if (channel === 'stdout') { stdoutBytes += chunk.length; stdout += text; } else { stderrBytes += chunk.length; stderr += text; }
      if (stdoutBytes + stderrBytes > MAX_SHELL_CAPTURE_BYTES) {
        outputExceeded = true;
        kill();
        void onChunk?.({ type: 'progress', message: `Shell output exceeded hard capture limit ${MAX_SHELL_CAPTURE_BYTES} bytes; terminating command.` });
        return;
      }
      emitStreamChunk(channel, text, chunk.length);
    };
    const finalize = async (code: number | null, sig: NodeJS.Signals | null) => {
      if (settled || finalizing) return;
      finalizing = true;
      const durationMs = Date.now() - startedAt;
      let outputFiles: import('./toolOutput.js').ShellOutputFileRef[] = [];
      let outputFileError: string | undefined;
      try {
        outputFiles = await persistShellOutputFiles({
          workspaceRoot: workspace.root,
          invocationId,
          stdout,
          stderr,
          force: timedOut || aborted || outputExceeded,
        });
      } catch (err) {
        outputFileError = err instanceof Error ? err.message : String(err);
      }
      const content = formatShellOutput({
        stdout,
        stderr,
        stdoutBytes,
        stderrBytes,
        exitCode: code,
        signal: sig,
        durationMs,
        timedOut,
        aborted,
        captureLimitExceeded: outputExceeded,
        outputFiles,
        outputFileError,
      });
      const metadata = {
        exitCode: code,
        signal: sig,
        stdoutBytes,
        stderrBytes,
        durationMs,
        ...(timedOut ? { timedOut: true } : {}),
        ...(aborted ? { aborted: true } : {}),
        ...(outputFiles.length > 0 ? { outputFiles } : {}),
        ...(outputFileError ? { outputFileError } : {}),
        ...(outputExceeded ? { outputExceeded: true } : {}),
      };
      if (outputExceeded) {
        finish({ status: 'error', error: `Shell output exceeded hard capture limit ${MAX_SHELL_CAPTURE_BYTES} bytes\n\n${content}`, metadata });
        return;
      }
      if (timedOut) {
        finish({ status: 'error', error: `Shell timed out after ${timeoutValue}ms\n\n${content}`, metadata });
        return;
      }
      if (aborted) {
        finish({ status: 'error', error: `Shell aborted\n\n${content}`, metadata });
        return;
      }
      if (spawnError) {
        finish({ status: 'error', error: `${spawnError.message}\n\n${content}`, metadata });
        return;
      }
      finish(code === 0
        ? { status: 'success', content, metadata }
        : { status: 'error', error: `command exited ${code ?? sig}\n\n${content}`, metadata });
    };
    child.stdout?.on('data', (chunk: Buffer) => emit('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => emit('stderr', chunk));
    child.on('error', (err: Error) => {
      spawnError = err;
      void finalize(null, null);
    });
    child.on('close', (code: number | null, sig: NodeJS.Signals | null) => {
      void finalize(code, sig);
    });
    if (signal?.aborted) onAbort();
  });
}

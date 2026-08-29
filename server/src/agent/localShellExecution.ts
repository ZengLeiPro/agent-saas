import { spawn } from 'child_process';
import { existsSync } from 'fs';

import type { ToolInvocationStreamChunk, ToolInvocationResponse } from '../runtime/handProtocol.js';
import type { WorkspaceRef } from './toolRuntime.js';
import { persistShellOutputFiles, shellOutputBaseName } from './shellOutputFiles.js';
import { ShellChannelAccumulator } from './shellOutputAccumulator.js';
import { createThrottledShellProgress, LimitedUtf8Decoder } from './shellProgressEmitter.js';
import {
  DEFAULT_SHELL_TIMEOUT_MS,
  MAX_SHELL_SPILL_BYTES,
  SHELL_PROGRESS_SNAPSHOT_INTERVAL_MS,
  SHELL_PROGRESS_SNAPSHOT_MAX_CHARS,
  formatShellOutput,
  type ShellOutputFileRef,
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
    // P0（2026-08-29）：输出管理对标 ref/pi OutputAccumulator。
    // 内存只留头窗口 + 滚动尾窗；超过窗口后全量字节流式落盘（不终止命令），
    // 仅超过磁盘配额才终止。行数/字节数由累加器增量统计，不能靠截断后文本回头数。
    const spillBaseName = shellOutputBaseName(invocationId);
    const stdoutAcc = new ShellChannelAccumulator('stdout', workspace.root, spillBaseName);
    const stderrAcc = new ShellChannelAccumulator('stderr', workspace.root, spillBaseName);
    let quotaTerminated = false;
    let outputStorageError: string | undefined;
    let terminationReason: 'timeout' | 'aborted' | 'quota' | 'spill' | undefined;
    let timedOut = false;
    let aborted = false;
    let spawnError: Error | undefined;
    const startedAt = Date.now();
    const timeoutValue = timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS;
    let settled = false;
    let finalizing = false;
    let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
    let hardFinalizeTimer: ReturnType<typeof setTimeout> | undefined;
    let killStarted = false;
    let removeSpillFailureHandlers = () => {};
    const finish = (response: ToolInvocationResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(heartbeat);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      if (hardFinalizeTimer) clearTimeout(hardFinalizeTimer);
      signal?.removeEventListener('abort', onAbort);
      removeSpillFailureHandlers();
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
      if (killStarted) return;
      aborted = true;
      terminationReason = 'aborted';
      kill();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      if (killStarted) return;
      timedOut = true;
      terminationReason = 'timeout';
      kill();
    }, timeoutValue);
    timer.unref?.();
    // 流式进度：原始输出转发满 64KB 预算后不再静默，转为节流尾窗快照。
    const progress = createThrottledShellProgress((message) => {
      void onChunk?.({ type: 'progress', message });
    });
    const stdoutDecoder = new LimitedUtf8Decoder();
    const stderrDecoder = new LimitedUtf8Decoder();
    const handleSpillFailure = (message: string) => {
      if (outputStorageError) return;
      outputStorageError = message;
      terminationReason ??= 'spill';
      kill();
      void onChunk?.({ type: 'progress', message: `Shell full-output persistence failed; terminating command: ${message}` });
    };
    const removeStdoutSpillHandler = stdoutAcc.onSpillFailure(handleSpillFailure);
    const removeStderrSpillHandler = stderrAcc.onSpillFailure(handleSpillFailure);
    removeSpillFailureHandlers = () => {
      removeStdoutSpillHandler();
      removeStderrSpillHandler();
    };
    const buildHeartbeatMessage = (): string => {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      const stats = `running ${elapsed}s · stdout=${stdoutAcc.bytesReceived()} bytes · stderr=${stderrAcc.bytesReceived()} bytes`;
      if (!progress.isRawExhausted()) return stats;
      const tail = (stdoutAcc.bytesReceived() >= stderrAcc.bytesReceived() ? stdoutAcc : stderrAcc)
        .tailSnapshot(SHELL_PROGRESS_SNAPSHOT_MAX_CHARS);
      return tail ? `${stats}\n${tail}` : stats;
    };
    const heartbeat = setInterval(() => {
      if (settled || finalizing) return;
      progress.maybeEmitSnapshot(buildHeartbeatMessage);
    }, SHELL_PROGRESS_SNAPSHOT_INTERVAL_MS);
    heartbeat.unref?.();
    const emit = (channel: 'stdout' | 'stderr', chunk: Buffer) => {
      if (settled || finalizing || quotaTerminated || outputStorageError) return;
      const acc = channel === 'stdout' ? stdoutAcc : stderrAcc;
      const source = channel === 'stdout' ? child.stdout : child.stderr;
      const decoder = channel === 'stdout' ? stdoutDecoder : stderrDecoder;
      const feedResult = acc.feed(chunk);
      if (feedResult.backpressured && source && !source.isPaused()) {
        source.pause();
        void acc.waitUntilWritable().then(() => {
          if (!settled && !finalizing && !killStarted && !outputStorageError) source.resume();
        });
      }
      if (feedResult.spillFailed) {
        handleSpillFailure('failed to write output spill file');
        return;
      }
      if (feedResult.quotaExceeded) {
        if (!killStarted) {
          quotaTerminated = true;
          terminationReason = 'quota';
          kill();
          void onChunk?.({ type: 'progress', message: `Shell output exceeded the ${MAX_SHELL_SPILL_BYTES}-byte disk quota; terminating command.` });
        }
        return;
      }
      if (!onChunk) return;
      const allowed = progress.allowRaw(chunk.length);
      // allowed=0 时仍要调用：decoder 可能留着预算边界前的半个 UTF-8 字符，
      // 会最多消费当前 chunk 的 3 个续字节把它补完整。
      const content = decoder.decode(chunk, allowed);
      if (content) void onChunk({ type: 'output', channel, content });
      if (progress.isRawExhausted()) progress.notifyRawExhausted();
    };
    const finalize = async (code: number | null, sig: NodeJS.Signals | null) => {
      if (settled || finalizing) return;
      finalizing = true;
      clearTimeout(timer);
      clearInterval(heartbeat);
      const durationMs = Date.now() - startedAt;
      const [stdoutFinal, stderrFinal] = await Promise.all([stdoutAcc.finalize(), stderrAcc.finalize()]);
      const windowTruncated = stdoutFinal.truncatedToWindow || stderrFinal.truncatedToWindow;
      // outputQuotaTerminated 表示“配额是首次终止原因”，不是收尾残余字节顺带越线。
      // 已溢出的通道有自己的落盘文件（累加器全量保真）；未溢出的通道走既有
      // persistShellOutputFiles（超时/中止/配额终止时强制落盘）。两路共用同一
      // 基名，最终信封的 Full output files 路径与进度提示承诺的一致。
      const merged: ShellOutputFileRef[] = [];
      let outputFileError: string | undefined;
      try {
        const persisted = await persistShellOutputFiles({
          workspaceRoot: workspace.root,
          invocationId,
          baseName: spillBaseName,
          stdout: stdoutFinal.truncatedToWindow ? '' : stdoutFinal.content,
          stderr: stderrFinal.truncatedToWindow ? '' : stderrFinal.content,
          force: timedOut || aborted || quotaTerminated || Boolean(outputStorageError),
        });
        const persistedByChannel = new Map(persisted.map((file) => [file.channel, file]));
        const stdoutFile = stdoutFinal.spillFile ?? persistedByChannel.get('stdout');
        const stderrFile = stderrFinal.spillFile ?? persistedByChannel.get('stderr');
        if (stdoutFile) merged.push(stdoutFile);
        if (stderrFile) merged.push(stderrFile);
      } catch (err) {
        outputFileError = err instanceof Error ? err.message : String(err);
      }
      const spillErrors = [stdoutFinal.spillError, stderrFinal.spillError].find(Boolean);
      if (!outputFileError && spillErrors) outputFileError = spillErrors;
      const content = formatShellOutput({
        stdout: stdoutFinal.content,
        stderr: stderrFinal.content,
        stdoutBytes: stdoutFinal.totalBytes,
        stderrBytes: stderrFinal.totalBytes,
        stdoutLines: stdoutFinal.lines,
        stderrLines: stderrFinal.lines,
        exitCode: code,
        signal: sig,
        durationMs,
        timedOut,
        aborted,
        outputWindowTruncated: windowTruncated,
        outputQuotaTerminated: quotaTerminated,
        outputFiles: merged,
        outputFileError,
      });
      const metadata = {
        exitCode: code,
        signal: sig,
        stdoutBytes: stdoutFinal.totalBytes,
        stderrBytes: stderrFinal.totalBytes,
        durationMs,
        ...(timedOut ? { timedOut: true } : {}),
        ...(aborted ? { aborted: true } : {}),
        ...(merged.length > 0 ? { outputFiles: merged } : {}),
        ...(outputFileError ? { outputFileError } : {}),
        ...(windowTruncated ? { outputExceeded: true, outputWindowTruncated: true } : {}),
        ...(quotaTerminated ? { outputExceeded: true, outputQuotaTerminated: true } : {}),
      };
      if (terminationReason === 'quota') {
        finish({ status: 'error', error: `Shell output exceeded the ${MAX_SHELL_SPILL_BYTES}-byte disk quota\n\n${content}`, metadata });
        return;
      }
      if (terminationReason === 'timeout') {
        finish({ status: 'error', error: `Shell timed out after ${timeoutValue}ms\n\n${content}`, metadata });
        return;
      }
      if (terminationReason === 'aborted') {
        finish({ status: 'error', error: `Shell aborted\n\n${content}`, metadata });
        return;
      }
      if (outputFileError) {
        finish({ status: 'error', error: `Shell full-output persistence failed: ${outputFileError}\n\n${content}`, metadata });
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

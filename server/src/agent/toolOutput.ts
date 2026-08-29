export const MAX_FILE_BYTES = 128 * 1024;
export const MAX_READ_LINES = 2_000;
/** Read 单次返回给模型的 UTF-8 硬上限；完整文件仍保留在 workspace。 */
export const MAX_READ_OUTPUT_BYTES = 64 * 1024;
export const MAX_SHELL_RETURN_CHARS = 64 * 1024;
/**
 * Shell 内存捕获窗口（2026-08-29 P0 改造，对标 ref/pi 的 OutputAccumulator）：
 * 单通道输出超过 head+tail 窗口后**不终止命令**，全部字节流式写入
 * `tmp/tool-results/` 下的完整输出文件，内存只保留头/尾窗口供摘要信封使用。
 *
 * 尺寸约束：两通道窗口合计（2 × (HEAD+TAIL) ≈ 56KB）必须留在
 * MAX_SHELL_RETURN_CHARS 信封预算内，否则信封的 truncateMiddle 会切碎
 * 「完整输出文件」指引——那是大输出场景下最重要的信息。
 */
export const MAX_SHELL_HEAD_BYTES = 8 * 1024;
export const MAX_SHELL_TAIL_BYTES = 20 * 1024;
/** 单通道完整输出的磁盘配额：仅超出时才终止命令（极端保护，正常不应触发）。 */
export const MAX_SHELL_SPILL_BYTES = 512 * 1024 * 1024;
export const MAX_SHELL_STREAM_BYTES = 64 * 1024;
/** 原始流式预算耗尽后，周期性尾窗快照的最小间隔与单条快照尾窗字符上限。 */
export const SHELL_PROGRESS_SNAPSHOT_INTERVAL_MS = 5_000;
export const SHELL_PROGRESS_SNAPSHOT_MAX_CHARS = 1_024;
export const MAX_SHELL_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_SHELL_TIMEOUT_MS = MAX_SHELL_TIMEOUT_MS;
export const MAX_BACKGROUND_SHELL_TIMEOUT_MS = 24 * 60 * 60_000;
export const DEFAULT_BACKGROUND_SHELL_TIMEOUT_MS = 60 * 60_000;

export interface ShellOutputFileRef {
  channel: 'stdout' | 'stderr';
  path: string;
  bytes: number;
  sha256: string;
}

export interface ShellOutputSummary {
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | string | null;
  durationMs?: number;
  timedOut?: boolean;
  aborted?: boolean;
  /** 输出超出内存捕获窗口：摘要只呈现头/尾窗口，完整输出保留在 outputFiles（命令未被终止）。 */
  outputWindowTruncated?: boolean;
  /** 输出超出磁盘配额导致命令被终止（极端保护）。 */
  outputQuotaTerminated?: boolean;
  /** 真实总行数。窗口化后无法从 content 数出，必须由累计器提供。 */
  stdoutLines?: number;
  stderrLines?: number;
  outputFiles?: ShellOutputFileRef[];
  outputFileError?: string;
  maxChars?: number;
}

export function truncateMiddle(text: string, maxChars: number): { text: string; truncated: boolean; omittedChars: number } {
  if (text.length <= maxChars) return { text, truncated: false, omittedChars: 0 };
  const marker = '\n...[truncated {{OMITTED}} chars; showing head/tail]...\n';
  const markerReserve = marker.replace('{{OMITTED}}', String(text.length)).length;
  const keep = Math.max(0, maxChars - markerReserve);
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  const omittedChars = Math.max(0, text.length - head - tail);
  return {
    text: `${text.slice(0, head)}${marker.replace('{{OMITTED}}', String(omittedChars))}${text.slice(text.length - tail)}`,
    truncated: true,
    omittedChars,
  };
}

export function truncateUtf8Prefix(text: string, maxBytes: number): { text: string; truncated: boolean; omittedBytes: number } {
  const encoded = Buffer.from(text, 'utf8');
  if (encoded.length <= maxBytes) return { text, truncated: false, omittedBytes: 0 };
  const prefix = encoded.subarray(0, Math.max(0, maxBytes)).toString('utf8').replace(/\uFFFD$/, '');
  return {
    text: prefix,
    truncated: true,
    omittedBytes: encoded.length - Buffer.byteLength(prefix, 'utf8'),
  };
}

export function formatShellOutput(input: ShellOutputSummary): string {
  const maxChars = input.maxChars ?? MAX_SHELL_RETURN_CHARS;
  const stdoutLines = input.stdoutLines ?? countLines(input.stdout);
  const stderrLines = input.stderrLines ?? countLines(input.stderr);
  const exit = input.exitCode === undefined && input.signal === undefined
    ? undefined
    : (input.exitCode === null || input.exitCode === undefined ? `signal ${input.signal ?? 'unknown'}` : String(input.exitCode));
  const header = [
    exit === undefined ? undefined : `Exit code: ${exit}`,
    input.durationMs === undefined ? undefined : `Wall time: ${(input.durationMs / 1000).toFixed(3)}s`,
    input.timedOut ? 'Termination: timeout' : undefined,
    input.aborted ? 'Termination: aborted' : undefined,
    `Output bytes: stdout=${input.stdoutBytes} stderr=${input.stderrBytes}`,
    `Output lines: stdout=${stdoutLines} stderr=${stderrLines}`,
    input.outputFiles?.length
      ? `Full output files: ${input.outputFiles.map((file) => `${file.channel}=${file.path} (${file.bytes} bytes sha256=${file.sha256})`).join('; ')}`
      : undefined,
    input.outputFileError ? `Full output file write failed: ${input.outputFileError}` : undefined,
    input.outputWindowTruncated
      ? 'Output exceeded the in-memory capture window; full output was streamed to the files above and the command was not terminated.'
      : undefined,
    input.outputQuotaTerminated
      ? `Output exceeded the ${MAX_SHELL_SPILL_BYTES}-byte disk quota; the command was terminated after preserving captured output.`
      : undefined,
  ].filter(Boolean).join('\n');

  const channels = [
    input.stdout ? { name: 'stdout', content: input.stdout } : undefined,
    input.stderr ? { name: 'stderr', content: input.stderr } : undefined,
  ].filter((item): item is { name: string; content: string } => Boolean(item));

  if (channels.length === 0) return `${header}\n\n(no output)`;

  const overhead = header.length + channels.reduce((sum, channel) => sum + channel.name.length + 5, 0) + 8;
  const available = Math.max(2_048, maxChars - overhead);
  const perChannel = Math.max(1_024, Math.floor(available / channels.length));
  const rendered = channels.map((channel, index) => {
    const budget = index === channels.length - 1
      ? Math.max(1_024, available - perChannel * (channels.length - 1))
      : perChannel;
    return `[${channel.name}]\n${truncateMiddle(channel.content, budget).text}`;
  });
  return `${header}\n\n${rendered.join('\n')}`;
}

function countLines(text: string): number {
  if (!text) return 0;
  const lineBreaks = text.match(/\n/g)?.length ?? 0;
  return text.endsWith('\n') ? lineBreaks : lineBreaks + 1;
}

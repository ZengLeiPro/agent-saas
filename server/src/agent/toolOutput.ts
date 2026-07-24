export const MAX_FILE_BYTES = 128 * 1024;
export const MAX_READ_LINES = 2_000;
/** Read 单次返回给模型的 UTF-8 硬上限；完整文件仍保留在 workspace。 */
export const MAX_READ_OUTPUT_BYTES = 64 * 1024;
export const MAX_SHELL_RETURN_CHARS = 64 * 1024;
export const MAX_SHELL_CAPTURE_BYTES = 4 * 1024 * 1024;
export const MAX_SHELL_STREAM_BYTES = 64 * 1024;
export const MAX_SHELL_TIMEOUT_MS = 10 * 60_000;
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
  captureLimitExceeded?: boolean;
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
  const stdoutLines = countLines(input.stdout);
  const stderrLines = countLines(input.stderr);
  const exit = input.exitCode === undefined && input.signal === undefined
    ? undefined
    : (input.exitCode === null || input.exitCode === undefined ? `signal ${input.signal ?? 'unknown'}` : String(input.exitCode));
  const header = [
    exit === undefined ? undefined : `Exit code: ${exit}`,
    input.durationMs === undefined ? undefined : `Wall time: ${(input.durationMs / 1000).toFixed(3)}s`,
    `Output bytes: stdout=${input.stdoutBytes} stderr=${input.stderrBytes}`,
    `Output lines: stdout=${stdoutLines} stderr=${stderrLines}`,
    input.outputFiles?.length
      ? `Full output files: ${input.outputFiles.map((file) => `${file.channel}=${file.path} (${file.bytes} bytes sha256=${file.sha256})`).join('; ')}`
      : undefined,
    input.outputFileError ? `Full output file write failed: ${input.outputFileError}` : undefined,
    input.captureLimitExceeded
      ? `Output capture exceeded ${MAX_SHELL_CAPTURE_BYTES} bytes; process was terminated after preserving captured output.`
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

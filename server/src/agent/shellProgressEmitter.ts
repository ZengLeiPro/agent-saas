import {
  MAX_SHELL_STREAM_BYTES,
  SHELL_PROGRESS_SNAPSHOT_INTERVAL_MS,
} from './toolOutput.js';

export type ShellProgressSink = (message: string) => void;

/**
 * 按字节预算解码实时 UTF-8 输出。若预算恰好切在多字节字符中间，最多额外消费
 * 3 字节完成当前字符；不会产生 U+FFFD，也不会把未完成字符永久遗失在 decoder。
 */
export class LimitedUtf8Decoder {
  private pending = Buffer.alloc(0);

  decode(chunk: Buffer, allowedBytes: number): string {
    const allowed = Math.max(0, Math.min(chunk.length, allowedBytes));
    if (allowed === 0 && this.pending.length === 0) return '';

    let consumed = allowed;
    let candidate = Buffer.concat([this.pending, chunk.subarray(0, consumed)]);
    let completeLength = completeUtf8PrefixLength(candidate);
    let remainder = candidate.subarray(completeLength);
    if (remainder.length > 0 && consumed < chunk.length) {
      const needed = Math.max(0, expectedUtf8Length(remainder[0]) - remainder.length);
      if (needed > 0) {
        const extra = chunk.subarray(consumed, Math.min(chunk.length, consumed + needed));
        consumed += extra.length;
        candidate = Buffer.concat([candidate, extra]);
        completeLength = completeUtf8PrefixLength(candidate);
        remainder = candidate.subarray(completeLength);
      }
    }
    this.pending = Buffer.from(remainder);
    return candidate.subarray(0, completeLength).toString('utf-8');
  }
}

function completeUtf8PrefixLength(input: Buffer): number {
  if (input.length === 0) return 0;
  let lead = input.length - 1;
  while (lead >= 0 && (input[lead] & 0xc0) === 0x80) lead -= 1;
  if (lead < 0) return 0;
  return input.length - lead < expectedUtf8Length(input[lead]) ? lead : input.length;
}

function expectedUtf8Length(firstByte: number): number {
  if (firstByte < 0x80) return 1;
  if (firstByte < 0xe0) return 2;
  if (firstByte < 0xf0) return 3;
  return 4;
}

/**
 * Shell 流式进度节流器（2026-08-29 P0，对标 ref/pi BASH_UPDATE_THROTTLE_MS）。
 *
 * 旧行为：原始输出流转发满 64KB 后**静默**——10 分钟的长命令期间 Web 端零反馈。
 *
 * 新行为分两段：
 * 1. 原始输出逐字节转发，累计 ≤ 64KB（保持既有 `tool_output_delta` 追加语义，
 *    断点续读/回放语义不变）；
 * 2. 预算耗尽后进入快照模式：按 `SHELL_PROGRESS_SNAPSHOT_INTERVAL_MS` 节流，
 *    周期性推尾窗快照 + 累计字节统计，命令运行全程有节奏的进度反馈。
 *    （快照走 `tool_progress` 通道，不污染断点续读语义。）
 */
export function createThrottledShellProgress(
  sink: ShellProgressSink,
  now: () => number = Date.now,
): {
  /** 返回允许原样转发的字节数；达到预算即进入快照模式。 */
  allowRaw(chunkBytes: number): number;
  isRawExhausted(): boolean;
  /** 进入快照模式时调用（幂等），发一次模式切换提示。 */
  notifyRawExhausted(): void;
  /** 快照模式下由调用方周期性驱动；未到节流窗口不发。 */
  maybeEmitSnapshot(buildMessage: () => string): void;
} {
  let streamedBytes = 0;
  let rawExhausted = false;
  let noticeSent = false;
  let lastSnapshotAt = 0;
  return {
    allowRaw(chunkBytes: number): number {
      if (rawExhausted) return 0;
      const remainingBytes = MAX_SHELL_STREAM_BYTES - streamedBytes;
      if (chunkBytes <= remainingBytes) {
        streamedBytes += chunkBytes;
        if (streamedBytes >= MAX_SHELL_STREAM_BYTES) rawExhausted = true;
        return chunkBytes;
      }
      streamedBytes = MAX_SHELL_STREAM_BYTES;
      rawExhausted = true;
      return remainingBytes;
    },
    isRawExhausted(): boolean {
      return rawExhausted;
    },
    notifyRawExhausted(): void {
      if (noticeSent) return;
      noticeSent = true;
      sink(`Live output stream capped at ${MAX_SHELL_STREAM_BYTES} bytes; continuing with periodic tail snapshots until the command finishes.`);
    },
    maybeEmitSnapshot(buildMessage: () => string): void {
      if (!rawExhausted || !noticeSent) return;
      const at = now();
      if (at - lastSnapshotAt < SHELL_PROGRESS_SNAPSHOT_INTERVAL_MS) return;
      lastSnapshotAt = at;
      sink(buildMessage());
    },
  };
}

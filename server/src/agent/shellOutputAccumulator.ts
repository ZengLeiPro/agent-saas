import { createHash } from 'crypto';

import {
  MAX_SHELL_HEAD_BYTES,
  MAX_SHELL_SPILL_BYTES,
  MAX_SHELL_TAIL_BYTES,
  type ShellOutputFileRef,
} from './toolOutput.js';
import {
  closeShellOutputFile,
  openShellOutputFile,
  SHELL_OUTPUT_DIR,
  verifyShellOutputFile,
  type OpenShellOutputFile,
} from './shellOutputFiles.js';

/** 待写磁盘字节超过该值时暂停对应 stdout/stderr Readable，回落后恢复。 */
const MAX_PENDING_SPILL_BYTES = 1024 * 1024;
const RESUME_PENDING_SPILL_BYTES = 256 * 1024;

export interface ShellAccumulatorFeedResult {
  quotaExceeded: boolean;
  backpressured: boolean;
  spillFailed: boolean;
}

/**
 * 单通道 Shell 输出累加器（2026-08-29 P0，对标 ref/pi `OutputAccumulator`）。
 *
 * 旧行为：输出 > 4MB 就**终止命令**。大输出命令（全量测试、构建日志、数据导出）
 * 被平台杀死，且流式进度静默。
 *
 * 新行为：
 * - 内存只保留「头窗口（HEAD）+ 滚动尾窗（TAIL）」。错误与最终结果通常在尾部，
 *   头窗口保留命令开头供模型定位，二者合计约 28KB，留在信封预算内。
 * - 输出超过窗口后**不终止命令**，全部字节流式写入 `tmp/tool-results/` 下的
 *   完整输出文件（全量保真，增量算 sha256），信封头部给出路径 + sha256。
 * - 仅当单通道超过 `MAX_SHELL_SPILL_BYTES` 磁盘配额时才返回 `quotaExceeded`，
 *   由执行层据此终止命令（极端保护）。
 *
 * 行数为增量统计（`\n` 恒为单字节 0x0A，不受 UTF-8 多字节影响），大输出下
 * 不能靠截断后的文本回头数行——那会静默少报。
 */
export class ShellChannelAccumulator {
  private readonly channel: 'stdout' | 'stderr';
  private readonly workspaceRoot: string;
  private readonly spillBaseName: string;
  private readonly spillRelPath: string;
  private readonly hasher = createHash('sha256');
  private totalBytes = 0;
  private newlines = 0;
  private endsWithNewline = true;
  /** Phase 1：尚未溢出时的全量缓冲（超过窗口即刷盘并释放）。 */
  private fullBuf: Buffer = Buffer.alloc(0);
  private spilled = false;
  private openedSpillFile: OpenShellOutputFile | undefined;
  /** 串行化磁盘写入，保证字节顺序。pendingSpillBytes 驱动上游真实 pause/resume 背压。 */
  private writeChain: Promise<void> = Promise.resolve();
  private pendingSpillBytes = 0;
  private readonly writableWaiters = new Set<() => void>();
  private readonly spillFailureHandlers = new Set<(message: string) => void>();
  private spillError: string | undefined;
  /** 头窗口：完整输出的前 HEAD 字节（溢出时保留）。 */
  private headBuf: Buffer = Buffer.alloc(0);
  /** 滚动尾窗：最多保留 2×TAIL，渲染时按 UTF-8 边界裁到 TAIL。 */
  private tailBuf: Buffer = Buffer.alloc(0);
  private quotaExceeded = false;

  /**
   * @param spillBaseName 溢出文件基名。两个通道必须共用同一基名（由执行层用
   *   `shellOutputBaseName(invocationId)` 生成一次传入），与
   *   `persistShellOutputFiles` 的命名规则保持一致——进度提示里承诺的文件路径
   *   就是最终信封里 `Full output files:` 指向的路径。
   */
  constructor(channel: 'stdout' | 'stderr', workspaceRoot: string, spillBaseName: string) {
    this.channel = channel;
    this.workspaceRoot = workspaceRoot;
    this.spillBaseName = spillBaseName;
    this.spillRelPath = `${SHELL_OUTPUT_DIR}/${spillBaseName}-${channel}.txt`;
  }

  /** 累计接收字节数（含已溢出的部分）。 */
  bytesReceived(): number {
    return this.totalBytes;
  }

  /** 接收原始字节，并返回配额/背压/落盘失败状态。 */
  feed(chunk: Buffer): ShellAccumulatorFeedResult {
    if (this.quotaExceeded) {
      return { quotaExceeded: true, backpressured: false, spillFailed: Boolean(this.spillError) };
    }
    this.totalBytes += chunk.length;
    this.countNewlines(chunk);
    this.captureHead(chunk);
    this.rollTail(chunk);
    if (!this.spilled) {
      // 必须先纳入当前 chunk 再判断跨窗；否则首次跨窗的 chunk 不在 fullBuf，
      // beginSpill 刷盘时会静默丢失这段字节。
      this.fullBuf = Buffer.concat([this.fullBuf, chunk]);
      if (this.totalBytes > MAX_SHELL_HEAD_BYTES + MAX_SHELL_TAIL_BYTES) this.beginSpill();
    } else {
      this.appendSpill(chunk);
    }
    if (this.totalBytes > MAX_SHELL_SPILL_BYTES) this.quotaExceeded = true;
    return {
      quotaExceeded: this.quotaExceeded,
      backpressured: this.pendingSpillBytes > MAX_PENDING_SPILL_BYTES,
      spillFailed: Boolean(this.spillError),
    };
  }

  /** 上游 pause 后等待待写队列回落；落盘失败时也立即释放，交给失败处理器终止命令。 */
  waitUntilWritable(): Promise<void> {
    if (this.pendingSpillBytes <= RESUME_PENDING_SPILL_BYTES || this.spillError) return Promise.resolve();
    return new Promise((resolveWait) => this.writableWaiters.add(resolveWait));
  }

  onSpillFailure(handler: (message: string) => void): () => void {
    this.spillFailureHandlers.add(handler);
    if (this.spillError) queueMicrotask(() => handler(this.spillError!));
    return () => this.spillFailureHandlers.delete(handler);
  }

  /** 等待磁盘写入收尾，返回信封所需的全部事实。 */
  async finalize(): Promise<{
    content: string;
    totalBytes: number;
    lines: number;
    truncatedToWindow: boolean;
    quotaExceeded: boolean;
    spillFile?: ShellOutputFileRef;
    spillError?: string;
  }> {
    await this.writeChain.catch(() => undefined);
    const finalSha256 = this.spilled ? this.hasher.copy().digest('hex') : undefined;
    if (this.openedSpillFile && finalSha256) await this.closeAndVerifySpillFile(finalSha256);
    const truncatedToWindow = this.spilled;
    const content = truncatedToWindow
      ? this.renderWindow()
      : this.fullBuf.toString('utf-8');
    const lines = this.totalBytes === 0
      ? 0
      : this.endsWithNewline ? this.newlines : this.newlines + 1;
    const result: Awaited<ReturnType<ShellChannelAccumulator['finalize']>> = {
      content,
      totalBytes: this.totalBytes,
      lines,
      truncatedToWindow,
      quotaExceeded: this.quotaExceeded,
    };
    if (this.spilled) {
      if (this.spillError) result.spillError = this.spillError;
      else result.spillFile = {
        channel: this.channel,
        path: this.spillRelPath,
        bytes: this.totalBytes,
        sha256: finalSha256!,
      };
    }
    return result;
  }

  /** 进度快照用：取尾窗末尾的可打印文本（不产生磁盘/信封副作用）。 */
  tailSnapshot(maxChars: number): string {
    const tail = trimToUtf8(this.tailBuf, MAX_SHELL_TAIL_BYTES);
    const text = trimUtf8Prefix(tail, tail.length).toString('utf-8');
    const chars = Array.from(text);
    return chars.length > maxChars ? `…${chars.slice(-maxChars).join('')}` : text;
  }

  private countNewlines(chunk: Buffer): void {
    if (chunk.length === 0) return;
    for (let i = 0; i < chunk.length; i += 1) {
      if (chunk[i] === 0x0a) this.newlines += 1;
    }
    this.endsWithNewline = chunk[chunk.length - 1] === 0x0a;
  }

  private captureHead(chunk: Buffer): void {
    if (this.headBuf.length >= MAX_SHELL_HEAD_BYTES) return;
    const need = MAX_SHELL_HEAD_BYTES - this.headBuf.length;
    this.headBuf = Buffer.concat([this.headBuf, chunk.subarray(0, need)]);
  }

  private rollTail(chunk: Buffer): void {
    const combined = Buffer.concat([this.tailBuf, chunk]);
    const limit = MAX_SHELL_TAIL_BYTES * 2;
    this.tailBuf = combined.length > limit ? combined.subarray(combined.length - limit) : combined;
  }

  private beginSpill(): void {
    this.spilled = true;
    const buffered = this.fullBuf;
    this.fullBuf = Buffer.alloc(0);
    this.hasher.update(buffered);
    this.enqueueSpillWrite(buffered, async () => {
      this.openedSpillFile = await openShellOutputFile(
        this.workspaceRoot,
        this.spillBaseName,
        this.channel,
      );
      await this.writeToFile(buffered);
    });
  }

  private appendSpill(chunk: Buffer): void {
    this.hasher.update(chunk);
    this.enqueueSpillWrite(chunk, () => this.writeToFile(chunk));
  }

  private enqueueSpillWrite(chunk: Buffer, write: () => Promise<void>): void {
    this.pendingSpillBytes += chunk.length;
    this.writeChain = this.writeChain
      .then(write)
      .catch((err) => this.recordSpillError(err))
      .finally(() => {
        this.pendingSpillBytes = Math.max(0, this.pendingSpillBytes - chunk.length);
        this.releaseWritableWaitersIfReady();
      });
  }

  private async writeToFile(chunk: Buffer): Promise<void> {
    const handle = this.openedSpillFile?.handle;
    if (!handle) throw new Error('spill file not open');
    let offset = 0;
    while (offset < chunk.length) {
      const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, null);
      if (bytesWritten <= 0) throw new Error('spill file write made no progress');
      offset += bytesWritten;
    }
  }

  private async closeAndVerifySpillFile(expectedSha256: string): Promise<void> {
    const opened = this.openedSpillFile;
    this.openedSpillFile = undefined;
    if (!opened) return;
    try {
      if (!this.spillError) await verifyShellOutputFile(opened, this.totalBytes, expectedSha256);
    } catch (err) {
      this.recordSpillError(err);
    } finally {
      try { await closeShellOutputFile(opened); } catch (err) { this.recordSpillError(err); }
    }
  }

  private recordSpillError(error: unknown): void {
    if (this.spillError) return;
    this.spillError = error instanceof Error ? error.message : String(error);
    this.releaseWritableWaitersIfReady();
    for (const handler of this.spillFailureHandlers) {
      try { handler(this.spillError); } catch { /* 失败处理器不得反向打断输出收尾 */ }
    }
  }

  private releaseWritableWaitersIfReady(): void {
    if (this.pendingSpillBytes > RESUME_PENDING_SPILL_BYTES && !this.spillError) return;
    for (const resolveWait of this.writableWaiters) resolveWait();
    this.writableWaiters.clear();
  }

  private renderWindow(): string {
    const head = trimUtf8Prefix(this.headBuf, MAX_SHELL_HEAD_BYTES).toString('utf-8');
    const tailBytes = trimToUtf8(this.tailBuf, MAX_SHELL_TAIL_BYTES);
    const tail = trimUtf8Prefix(tailBytes, tailBytes.length).toString('utf-8');
    const shownBytes = Buffer.byteLength(head, 'utf-8') + Buffer.byteLength(tail, 'utf-8');
    const omitted = Math.max(0, this.totalBytes - shownBytes);
    return `${head}\n...[${omitted} bytes omitted from in-memory window; full output in the spill file]...\n${tail}`;
  }
}

/** 按 UTF-8 边界裁到最多 maxBytes（保头），丢弃末尾被切断的不完整字符。 */
function trimUtf8Prefix(buf: Buffer, maxBytes: number): Buffer {
  const sliced = buf.subarray(0, Math.min(buf.length, maxBytes));
  if (sliced.length === 0) return sliced;
  let lead = sliced.length - 1;
  while (lead >= 0 && (sliced[lead] & 0xc0) === 0x80) lead -= 1;
  if (lead < 0) return Buffer.alloc(0);
  const first = sliced[lead];
  const expected = first < 0x80 ? 1 : first < 0xe0 ? 2 : first < 0xf0 ? 3 : 4;
  return sliced.length - lead < expected ? sliced.subarray(0, lead) : sliced;
}

/** 按 UTF-8 边界裁到最多 maxBytes（保尾），丢弃开头被切断的续字节。 */
function trimToUtf8(buf: Buffer, maxBytes: number): Buffer {
  if (buf.length <= maxBytes) return buf;
  const sliced = buf.subarray(buf.length - maxBytes);
  let start = 0;
  while (start < sliced.length && (sliced[start] & 0xc0) === 0x80) start += 1;
  return sliced.subarray(start);
}

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ShellChannelAccumulator } from './shellOutputAccumulator.js';
import { createThrottledShellProgress, LimitedUtf8Decoder } from './shellProgressEmitter.js';
import {
  MAX_SHELL_HEAD_BYTES,
  MAX_SHELL_STREAM_BYTES,
  MAX_SHELL_TAIL_BYTES,
  SHELL_PROGRESS_SNAPSHOT_INTERVAL_MS,
} from './toolOutput.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ShellChannelAccumulator', () => {
  it('首次跨窗的 chunk 不丢字节，完整文件、sha256、行数均基于原始输出', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shell-accumulator-'));
    roots.push(root);
    const accumulator = new ShellChannelAccumulator('stdout', root, 'cross-window');
    const threshold = MAX_SHELL_HEAD_BYTES + MAX_SHELL_TAIL_BYTES;
    const first = Buffer.concat([
      Buffer.alloc(MAX_SHELL_HEAD_BYTES - 1, 'a'),
      Buffer.from('🙂\n', 'utf-8'),
      Buffer.alloc(threshold - MAX_SHELL_HEAD_BYTES - 8, 'b'),
    ]);
    const crossing = Buffer.from('CROSSING-CHUNK\n尾部🚀\n', 'utf-8');
    const expected = Buffer.concat([first, crossing]);

    accumulator.feed(first);
    accumulator.feed(crossing);
    const result = await accumulator.finalize();

    expect(result.truncatedToWindow).toBe(true);
    expect(result.totalBytes).toBe(expected.length);
    expect(result.lines).toBe(3);
    expect(result.content).toContain('omitted from in-memory window');
    expect(result.content).toContain('尾部🚀');
    expect(result.content).not.toContain('\uFFFD');
    expect(result.spillFile).toMatchObject({
      channel: 'stdout',
      bytes: expected.length,
      sha256: createHash('sha256').update(expected).digest('hex'),
    });
    expect(await readFile(join(root, result.spillFile!.path))).toEqual(expected);
  });

  it('待写队列超过 1MiB 时施加背压，回落后完整恢复且不丢字节', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shell-accumulator-backpressure-'));
    roots.push(root);
    const accumulator = new ShellChannelAccumulator('stdout', root, 'backpressure');
    const chunks = [
      Buffer.alloc(MAX_SHELL_HEAD_BYTES + MAX_SHELL_TAIL_BYTES + 1, 'a'),
      ...Array.from({ length: 20 }, () => Buffer.alloc(64 * 1024, 'b')),
    ];
    let backpressured = false;
    for (const chunk of chunks) {
      const result = accumulator.feed(chunk);
      if (result.backpressured) backpressured = true;
    }

    expect(backpressured).toBe(true);
    await accumulator.waitUntilWritable();
    const result = await accumulator.finalize();
    const expected = Buffer.concat(chunks);
    const saved = await readFile(join(root, result.spillFile!.path));
    expect(result.spillFile?.bytes).toBe(expected.length);
    expect(saved.length).toBe(expected.length);
    expect(createHash('sha256').update(saved).digest('hex'))
      .toBe(createHash('sha256').update(expected).digest('hex'));
  });

  it('溢出文件无法创建时通知执行层并且不伪造完整文件引用', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shell-accumulator-failure-'));
    roots.push(root);
    const blockedRoot = join(root, 'not-a-directory');
    await writeFile(blockedRoot, 'block');
    const accumulator = new ShellChannelAccumulator('stdout', blockedRoot, 'failure');
    const failure = new Promise<string>((resolveFailure) => accumulator.onSpillFailure(resolveFailure));

    accumulator.feed(Buffer.alloc(MAX_SHELL_HEAD_BYTES + MAX_SHELL_TAIL_BYTES + 1, 'x'));

    expect(await failure).toMatch(/ENOTDIR|not a directory|not a real directory/i);
    const result = await accumulator.finalize();
    expect(result.spillError).toBeTruthy();
    expect(result.spillFile).toBeUndefined();
  });

  it('拒绝通过 tmp 符号链接把完整输出写到 workspace 外', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shell-accumulator-symlink-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'shell-accumulator-symlink-outside-'));
    roots.push(root, outside);
    await symlink(outside, join(root, 'tmp'), 'dir');
    const accumulator = new ShellChannelAccumulator('stdout', root, 'symlink');
    const failure = new Promise<string>((resolveFailure) => accumulator.onSpillFailure(resolveFailure));

    accumulator.feed(Buffer.alloc(MAX_SHELL_HEAD_BYTES + MAX_SHELL_TAIL_BYTES + 1, 'x'));

    expect(await failure).toMatch(/ELOOP|ENOTDIR|symbolic link|too many levels|not a real directory/i);
    expect((await readdir(outside))).toEqual([]);
    const result = await accumulator.finalize();
    expect(result.spillFile).toBeUndefined();
  });

  it('命令原位等长篡改溢出文件时 sha256 校验失败，不返回虚假文件引用', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shell-accumulator-tamper-'));
    roots.push(root);
    const accumulator = new ShellChannelAccumulator('stdout', root, 'tamper');
    const payload = Buffer.alloc(MAX_SHELL_HEAD_BYTES + MAX_SHELL_TAIL_BYTES + 1, 'a');
    const outputPath = join(root, 'tmp/tool-results/tamper-stdout.txt');
    accumulator.feed(payload);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        if ((await stat(outputPath)).size === payload.length) break;
      } catch { /* 等待异步 open/write */ }
      await sleep(5);
    }
    await writeFile(outputPath, Buffer.alloc(payload.length, 'z'));

    const result = await accumulator.finalize();

    expect(result.spillError).toMatch(/content mismatch/i);
    expect(result.spillFile).toBeUndefined();
  });

  it('周期尾窗落在半个 UTF-8 字符时不产生替换符', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shell-accumulator-snapshot-utf8-'));
    roots.push(root);
    const accumulator = new ShellChannelAccumulator('stdout', root, 'snapshot-utf8');
    const emoji = Buffer.from('🙂', 'utf-8');

    accumulator.feed(emoji.subarray(0, 2));
    expect(accumulator.tailSnapshot(100)).toBe('');
    accumulator.feed(emoji.subarray(2));
    expect(accumulator.tailSnapshot(100)).toBe('🙂');
  });

  it('窗口内输出不创建文件，并保留原文', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shell-accumulator-small-'));
    roots.push(root);
    const accumulator = new ShellChannelAccumulator('stderr', root, 'small');
    accumulator.feed(Buffer.from('第一行\n第二行', 'utf-8'));

    const result = await accumulator.finalize();

    expect(result).toMatchObject({
      content: '第一行\n第二行',
      lines: 2,
      truncatedToWindow: false,
      quotaExceeded: false,
    });
    expect(result.spillFile).toBeUndefined();
  });
});

describe('createThrottledShellProgress', () => {
  it('字节预算切在 UTF-8 字符中间时补齐当前字符且不产生替换符', () => {
    const decoder = new LimitedUtf8Decoder();
    const emoji = Buffer.from('🙂', 'utf-8');

    expect(decoder.decode(emoji.subarray(0, 2), 2)).toBe('');
    expect(decoder.decode(emoji.subarray(2), 0)).toBe('🙂');
  });

  it('原始流预算耗尽后只按节流窗口发送周期快照', () => {
    let now = 1_000;
    const messages: string[] = [];
    const progress = createThrottledShellProgress((message) => messages.push(message), () => now);

    expect(progress.allowRaw(MAX_SHELL_STREAM_BYTES + 100)).toBe(MAX_SHELL_STREAM_BYTES);
    expect(progress.isRawExhausted()).toBe(true);
    progress.notifyRawExhausted();
    progress.notifyRawExhausted();
    progress.maybeEmitSnapshot(() => 'snapshot-1');
    expect(messages).toHaveLength(1);

    now += SHELL_PROGRESS_SNAPSHOT_INTERVAL_MS;
    progress.maybeEmitSnapshot(() => 'snapshot-1');
    progress.maybeEmitSnapshot(() => 'too-early');
    expect(messages).toEqual([
      expect.stringContaining('periodic tail snapshots'),
      'snapshot-1',
    ]);

    now += SHELL_PROGRESS_SNAPSHOT_INTERVAL_MS;
    progress.maybeEmitSnapshot(() => 'snapshot-2');
    expect(messages.at(-1)).toBe('snapshot-2');
  });
});

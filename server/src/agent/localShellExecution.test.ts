import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runLocalShellStreaming } from './localShellExecution.js';
import type { WorkspaceRef } from './toolRuntime.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('runLocalShellStreaming', () => {
  it('超过旧 4MB 捕获上限仍正常完成，并把完整输出落盘', async () => {
    const root = await mkdtemp(join(tmpdir(), 'local-shell-large-output-'));
    roots.push(root);
    const bytes = 4 * 1024 * 1024 + 1024;
    const workspace: WorkspaceRef = {
      root,
      userId: 'user-1',
      sessionId: 'session-1',
      executionTarget: 'server-local',
    };

    const response = await runLocalShellStreaming({
      workspace,
      command: `node -e "process.stdout.write('x'.repeat(${bytes}))"`,
      timeoutMs: 30_000,
      invocationId: 'large-local-output',
      findDeniedPathMention: () => undefined,
    });

    expect(response.status).toBe('success');
    if (response.status === 'success') {
      expect(response.metadata).toMatchObject({
        exitCode: 0,
        stdoutBytes: bytes,
        outputExceeded: true,
        outputWindowTruncated: true,
      });
      expect(response.content).toContain('Output exceeded the in-memory capture window');
      const outputFiles = response.metadata?.outputFiles as Array<{ channel: string; path: string; bytes: number }>;
      expect(outputFiles).toHaveLength(1);
      expect(outputFiles[0]).toMatchObject({ channel: 'stdout', bytes });
      expect((await stat(join(root, outputFiles[0]!.path))).size).toBe(bytes);
    }
  }, 30_000);

  it('完整输出文件无法创建时终止命令并返回 error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'local-shell-spill-failure-'));
    roots.push(root);
    await writeFile(join(root, 'tmp'), 'block spill directory');
    const workspace: WorkspaceRef = {
      root,
      userId: 'user-1',
      sessionId: 'session-1',
      executionTarget: 'server-local',
    };

    const response = await runLocalShellStreaming({
      workspace,
      command: "node -e \"process.stdout.write('x'.repeat(128 * 1024)); setTimeout(() => {}, 1000)\"",
      timeoutMs: 10_000,
      invocationId: 'spill-failure',
      findDeniedPathMention: () => undefined,
    });

    expect(response.status).toBe('error');
    if (response.status === 'error') {
      expect(response.error).toContain('full-output persistence failed');
      expect(response.metadata?.outputFileError).toBeTruthy();
    }
  });

  it('directArgv 不经过 shell 解析', async () => {
    const root = await mkdtemp(join(tmpdir(), 'local-shell-direct-'));
    roots.push(root);
    const workspace: WorkspaceRef = {
      root,
      userId: 'user-1',
      sessionId: 'session-1',
      executionTarget: 'server-local',
    };

    const response = await runLocalShellStreaming({
      workspace,
      command: 'touch should-not-exist',
      directArgv: [process.execPath, '-e', 'process.stdout.write(process.argv[1])', '$(touch should-not-exist)'],
      invocationId: 'direct-argv',
      findDeniedPathMention: () => undefined,
    });

    expect(response.status).toBe('success');
    if (response.status === 'success') {
      expect(response.content).toContain('$(touch should-not-exist)');
    }
    await expect(stat(join(root, 'should-not-exist'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('实时输出的 UTF-8 字符跨 data chunk 时不产生替换符', async () => {
    const root = await mkdtemp(join(tmpdir(), 'local-shell-utf8-'));
    roots.push(root);
    const workspace: WorkspaceRef = {
      root,
      userId: 'user-1',
      sessionId: 'session-1',
      executionTarget: 'server-local',
    };
    const streamed: string[] = [];
    const script = "const b=Buffer.from('🙂'); process.stdout.write(b.subarray(0,2)); setTimeout(() => process.stdout.write(b.subarray(2)), 30)";

    const response = await runLocalShellStreaming({
      workspace,
      command: `node -e ${JSON.stringify(script)}`,
      timeoutMs: 10_000,
      invocationId: 'utf8-split',
      findDeniedPathMention: () => undefined,
      onChunk: (chunk) => {
        if (chunk.type === 'output' && chunk.channel === 'stdout') streamed.push(chunk.content);
      },
    });

    expect(response.status).toBe('success');
    expect(streamed.join('')).toBe('🙂');
    expect(streamed.join('')).not.toContain('\uFFFD');
  });
});

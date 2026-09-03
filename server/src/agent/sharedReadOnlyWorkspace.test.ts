import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ServerLocalExecutionProvider, type WorkspaceRef } from './toolRuntime.js';

async function workspaceFixture(): Promise<{
  workspace: WorkspaceRef;
  sharedRoot: string;
  outsideFile: string;
}> {
  const base = await mkdtemp(join(tmpdir(), 'org-agent-shared-read-'));
  const root = join(base, 'work');
  const sharedRoot = join(base, 'agent-shared');
  const outsideFile = join(base, 'outside.txt');
  await Promise.all([
    mkdir(root, { recursive: true }),
    mkdir(sharedRoot, { recursive: true }),
    writeFile(outsideFile, 'secret'),
  ]);
  return {
    workspace: {
      root,
      sharedReadOnlyRoot: sharedRoot,
      executionTarget: 'server-local',
    },
    sharedRoot,
    outsideFile,
  };
}

describe('组织 Agent shared root', () => {
  it.runIf(process.platform === 'linux')(
    'Read 可读取受信挂载，并保留可继续分片读取的绝对路径',
    async () => {
      const fixture = await workspaceFixture();
      const sharedFile = join(fixture.sharedRoot, '事实.md');
      await writeFile(sharedFile, '第一行\n第二行');
      const response = await new ServerLocalExecutionProvider().execute({
        toolName: 'Read',
        input: { path: sharedFile, offset: 1, limit: 1 },
        context: { workspace: fixture.workspace },
      });
      expect(response).toMatchObject({
        status: 'success',
        metadata: { path: sharedFile, ranged: true },
      });
      if (response.status !== 'success') throw new Error(response.error);
      expect(response.content).toContain('第一行');
      expect(response.content).toContain(`Read offset=2`);
    },
  );

  it('Write 和目录穿越不能借 shared root 越界', async () => {
    const fixture = await workspaceFixture();
    const provider = new ServerLocalExecutionProvider();
    const writeResponse = await provider.execute({
      toolName: 'Write',
      input: { path: join(fixture.sharedRoot, '禁止.txt'), content: 'x' },
      context: { workspace: fixture.workspace },
    });
    expect(writeResponse).toMatchObject({
      status: 'error',
      error: expect.stringContaining('outside workspace'),
    });

    const traversalResponse = await provider.execute({
      toolName: 'Read',
      input: { path: join(fixture.sharedRoot, '..', 'outside.txt') },
      context: { workspace: fixture.workspace },
    });
    expect(traversalResponse).toMatchObject({
      status: 'error',
      error: expect.stringContaining('outside workspace'),
    });
  });

  it('shared root 内的符号链接不能跳到挂载外', async () => {
    const fixture = await workspaceFixture();
    const link = join(fixture.sharedRoot, '越界链接.txt');
    await symlink(fixture.outsideFile, link);
    const response = await new ServerLocalExecutionProvider().execute({
      toolName: 'Read',
      input: { path: link },
      context: { workspace: fixture.workspace },
    });
    expect(response).toMatchObject({ status: 'error' });
  });
});

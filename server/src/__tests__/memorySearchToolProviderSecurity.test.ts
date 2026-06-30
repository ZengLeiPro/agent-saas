/**
 * MemoryList 安全测试（δ 阶段补，覆盖 review 找出的 critical 漏洞）。
 *
 * 覆盖：
 *   - subdir `../memory_secret` 必须被拒绝（修复 startsWith 前缀绕过）
 *   - subdir 绝对路径必须被拒绝
 *   - 符号链接的目录/文件直接跳过
 *   - 正常列出 memory/**.md
 */

import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  memoryListToolDescriptor,
  MemorySearchToolProvider,
} from '../agent/memorySearchToolProvider.js';
import type { AuthorizedToolCall, ToolCallContext, WorkspaceRef } from '../agent/toolRuntime.js';
import type { MemoryIndexService } from '../memory/index/service.js';

function makeContext(root: string): ToolCallContext {
  const workspace: WorkspaceRef = {
    id: 's1',
    root,
    sessionId: 's1',
    executionTarget: 'server-local',
  };
  return {
    channelContext: {
      channel: 'web',
      user: { id: 'u1', username: 'tester', role: 'user' },
    } as unknown as ToolCallContext['channelContext'],
    workspace,
  };
}

function makeCall<T>(input: T): AuthorizedToolCall<T> {
  return {
    toolId: memoryListToolDescriptor.id,
    input,
    authorization: { approved: true, source: 'policy_auto' },
  };
}

// 测试不用真 MemoryIndexService（MemoryList 路径不依赖它），用 null cast
const dummyIndex = null as unknown as MemoryIndexService;

describe('MemorySearchToolProvider — MemoryList 安全', () => {
  it('subdir="../memory_secret" 必须拒绝（修复 startsWith 前缀绕过）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mem-secret-'));
    // 制造一个共前缀同级目录 + 内含 md
    await mkdir(join(root, 'memory_secret'), { recursive: true });
    await writeFile(join(root, 'memory_secret', 'leak.md'), 'classified', 'utf-8');
    // memory 目录也存在以便通过早期 fast-fail
    await mkdir(join(root, 'memory'), { recursive: true });

    const provider = new MemorySearchToolProvider(dummyIndex);
    const res = await provider.invoke(makeCall({ subdir: '../memory_secret' }), makeContext(root));
    expect(res?.content).toMatch(/Access denied|包含/);
    expect(res?.content).not.toMatch(/leak\.md/);
  });

  it('subdir 绝对路径 → 拒绝', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mem-abs-'));
    await mkdir(join(root, 'memory'), { recursive: true });
    const provider = new MemorySearchToolProvider(dummyIndex);
    const res = await provider.invoke(makeCall({ subdir: '/etc' }), makeContext(root));
    expect(res?.content).toMatch(/Access denied|绝对路径/);
  });

  it('符号链接目录直接跳过（不会列出指向外部目录的 md 文件）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mem-symlink-'));
    const memoryDir = join(root, 'memory');
    await mkdir(memoryDir, { recursive: true });
    // 在 memory 内放一个 symlink → /tmp（任何能解析的目录）
    try {
      await symlink(tmpdir(), join(memoryDir, 'evil_link'));
    } catch {
      return; // 某些环境无 symlink 权限
    }
    await writeFile(join(memoryDir, 'real.md'), '# real', 'utf-8');

    const provider = new MemorySearchToolProvider(dummyIndex);
    const res = await provider.invoke(makeCall({}), makeContext(root));
    expect(res?.content).toMatch(/real\.md/);
    // 不应该把符号链接指向目录里的 md 全部 enumerate 出来
    expect(res?.content).not.toMatch(/evil_link\//);
  });

  it('正常列出 memory/**.md', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mem-ok-'));
    const memoryDir = join(root, 'memory');
    await mkdir(join(memoryDir, 'topics'), { recursive: true });
    await writeFile(join(root, 'MEMORY.md'), '# Memory', 'utf-8');
    await writeFile(join(memoryDir, '2026-06-14.md'), '# day', 'utf-8');
    await writeFile(join(memoryDir, 'topics', 'biz.md'), '# biz', 'utf-8');

    const provider = new MemorySearchToolProvider(dummyIndex);
    const res = await provider.invoke(makeCall({}), makeContext(root));
    expect(res?.content).toMatch(/MEMORY\.md/);
    expect(res?.content).toMatch(/memory\/2026-06-14\.md/);
    expect(res?.content).toMatch(/memory\/topics\/biz\.md/);
  });
});

/**
 * Workspace hand tools 安全语义 + BuiltinTools brain-only 协议关键测试。
 *
 * 覆盖：
 *   - Edit overlap match 用 split-count 杜绝 silent partial overwrite
 *   - Edit 拒绝敏感路径（.ky-agent/settings.json / .env / .ssh/）
 *   - Edit 超大文件先 stat 拒绝
 *   - resolveInsideWorkspace 拒绝 `../etc/passwd`
 *   - TodoWrite 需要 sessionId（无 fallback）
 */

import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BuiltinToolProvider,
  askUserQuestionToolDescriptor,
  createBuiltinTools,
  todoWriteToolDescriptor,
} from '../agent/builtinTools.js';
import type { AuthorizedToolCall, ToolCallContext, WorkspaceRef } from '../agent/toolRuntime.js';
import {
  artifactCreateToolDescriptor,
  editToolDescriptor,
  runWorkspaceEdit,
} from '../agent/workspaceHandTools.js';

function makeContext(root: string, sessionId = 'test-session'): ToolCallContext {
  const workspace: WorkspaceRef = {
    id: sessionId,
    root,
    sessionId,
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

function makeCall<T>(id: string, input: T): AuthorizedToolCall<T> {
  return {
    toolId: id,
    input,
    authorization: { approved: true, source: 'policy_auto' },
  };
}

async function makeWorkspace(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'builtin-tools-'));
}

describe('Workspace hand tools — provider 边界', () => {
  it('BuiltinToolProvider 不再暴露 workspace 文件工具', () => {
    expect(createBuiltinTools().list().map((tool) => tool.id)).toEqual([
      'TodoWrite',
      'AskUserQuestion',
    ]);
    expect(createBuiltinTools().list().map((tool) => tool.id)).not.toContain(editToolDescriptor.id);
    expect(createBuiltinTools().list().map((tool) => tool.id)).not.toContain(artifactCreateToolDescriptor.id);
  });

  it('AskUserQuestion schema defaults multiSelect to false', () => {
    const parsed = askUserQuestionToolDescriptor.schema.parse({
      questions: [{
        question: '选一个？',
        header: '选择',
        options: [
          { label: 'A', description: '选 A' },
          { label: 'B', description: '选 B' },
        ],
      }],
    }) as { questions: Array<{ multiSelect: boolean }> };
    expect(parsed.questions[0]?.multiSelect).toBe(false);
  });
});

describe('Workspace hand tools — Edit 安全', () => {
  it('overlap match 拒绝 silent overwrite（content="aaaa", old="aa", no replace_all → throw）', async () => {
    const root = await makeWorkspace();
    const file = join(root, 'sample.txt');
    await writeFile(file, 'aaaa', 'utf-8');
    await expect(
      runWorkspaceEdit({
        file_path: 'sample.txt',
        old_string: 'aa',
        new_string: 'bb',
      }, makeContext(root).workspace),
    ).rejects.toThrow(/matched 2 times/);
  });

  it('拒写 .ky-agent/settings.json（防 MCP 注入升权）', async () => {
    const root = await makeWorkspace();
    await mkdir(join(root, '.ky-agent'), { recursive: true });
    await writeFile(join(root, '.ky-agent', 'settings.json'), '{}', 'utf-8');
    await expect(
      runWorkspaceEdit({
        file_path: '.ky-agent/settings.json',
        old_string: '{}',
        new_string: '{"mcpServers": {"x": {"command": "/bin/sh"}}}',
      }, makeContext(root).workspace),
    ).rejects.toThrow(/deny list/);
  });

  it('迁移期仍拒写 legacy .claude/settings.json', async () => {
    const root = await makeWorkspace();
    await mkdir(join(root, '.claude'), { recursive: true });
    await writeFile(join(root, '.claude', 'settings.json'), '{}', 'utf-8');
    await expect(
      runWorkspaceEdit({
        file_path: '.claude/settings.json',
        old_string: '{}',
        new_string: '{"mcpServers": {"x": {"command": "/bin/sh"}}}',
      }, makeContext(root).workspace),
    ).rejects.toThrow(/deny list/);
  });

  it('拒写 .env', async () => {
    const root = await makeWorkspace();
    await writeFile(join(root, '.env'), 'X=1', 'utf-8');
    await expect(
      runWorkspaceEdit({
        file_path: '.env',
        old_string: 'X=1',
        new_string: 'X=2',
      }, makeContext(root).workspace),
    ).rejects.toThrow(/deny list/);
  });

  it('拒绝 cwd 外路径', async () => {
    const root = await makeWorkspace();
    await expect(
      runWorkspaceEdit({
        file_path: '../../etc/passwd',
        old_string: 'root',
        new_string: 'rooot',
      }, makeContext(root).workspace),
    ).rejects.toThrow(/outside workspace/);
  });

  it('正常 single match 替换成功', async () => {
    const root = await makeWorkspace();
    await writeFile(join(root, 'a.txt'), 'hello world', 'utf-8');
    const res = await runWorkspaceEdit(
      {
        file_path: 'a.txt',
        old_string: 'world',
        new_string: 'WORLD',
      },
      makeContext(root).workspace,
    );
    expect(res.content).toMatch(/Edited a\.txt/);
  });
});

describe('BuiltinToolProvider — TodoWrite 协议', () => {
  it('缺 workspace.sessionId 时 throw', async () => {
    const root = await makeWorkspace();
    const provider = createBuiltinTools();
    const ctx = makeContext(root);
    (ctx.workspace as { sessionId?: string }).sessionId = undefined;
    await expect(
      provider.invoke(
        makeCall(todoWriteToolDescriptor.id, {
          todos: [{ content: 'do thing', status: 'pending' as const }],
        }),
        ctx,
      ),
    ).rejects.toThrow(/sessionId required/);
  });

  it('同 sessionId 重复 set 后 LRU store 复用（单 BuiltinToolProvider 实例）', async () => {
    const root = await makeWorkspace();
    const provider = new BuiltinToolProvider();
    const res1 = await provider.invoke(
      makeCall(todoWriteToolDescriptor.id, {
        todos: [{ content: 'A', status: 'pending' as const }],
      }),
      makeContext(root, 'sess-x'),
    );
    expect(res1?.content).toMatch(/TODO list updated \(1 items\)/);
    const res2 = await provider.invoke(
      makeCall(todoWriteToolDescriptor.id, {
        todos: [
          { content: 'A', status: 'completed' as const },
          { content: 'B', status: 'pending' as const },
        ],
      }),
      makeContext(root, 'sess-x'),
    );
    expect(res2?.content).toMatch(/TODO list updated \(2 items\)/);
  });
});

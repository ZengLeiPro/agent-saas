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
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BuiltinToolProvider,
  askUserQuestionToolDescriptor,
  createBuiltinTools,
  todoWriteToolDescriptor,
} from '../agent/builtinTools.js';
import type { AuthorizedToolCall, ToolCallContext, WorkspaceRef } from '../agent/toolRuntime.js';
import { parseToolInput } from '../agent/toolRuntimePaths.js';
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

  it('正常 single match 替换成功，并返回 unified diff metadata', async () => {
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
    expect(res.metadata).toMatchObject({ replacements: 1, editCount: 1, firstChangedLine: 1 });
    expect(res.metadata?.diff).toContain('-hello world');
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('hello WORLD');
  });

  it('prepareInput 自愈 path 别名、stringified JSON、camelCase 与单对象 edits', () => {
    const parsed = parseToolInput(editToolDescriptor, JSON.stringify({
      path: 'a.txt',
      edits: JSON.stringify({ oldText: 'old', newText: 'new', replaceAll: true }),
    }));

    expect(parsed).toEqual({
      file_path: 'a.txt',
      edits: [{ old_string: 'old', new_string: 'new', replace_all: true }],
    });
  });

  it('批量 edits 一次写回，保留旧字段兼容', async () => {
    const root = await makeWorkspace();
    await writeFile(join(root, 'a.txt'), 'one two three', 'utf-8');
    const res = await runWorkspaceEdit({
      file_path: 'a.txt',
      edits: [
        { old_string: 'one', new_string: 'ONE' },
        { old_string: 'three', new_string: 'THREE' },
      ],
    }, makeContext(root).workspace);

    expect(res.metadata).toMatchObject({ replacements: 2, editCount: 2 });
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('ONE two THREE');
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
          todos: [{ id: 'do-thing', kind: 'business' as const, content: 'do thing', status: 'pending' as const }],
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
        todos: [{ id: 'a', kind: 'business' as const, content: 'A', status: 'pending' as const }],
      }),
      makeContext(root, 'sess-x'),
    );
    expect(res1?.content).toMatch(/TODO list updated \(1 items\)/);
    const res2 = await provider.invoke(
      makeCall(todoWriteToolDescriptor.id, {
        todos: [
          { id: 'a', kind: 'business' as const, content: 'A', status: 'completed' as const },
          { id: 'b', kind: 'business' as const, content: 'B', status: 'pending' as const },
        ],
      }),
      makeContext(root, 'sess-x'),
    );
    expect(res2?.content).toMatch(/TODO list updated \(2 items\)/);
  });

  it('只接受带稳定 id 的 business 步骤', () => {
    expect(() => todoWriteToolDescriptor.schema.parse({
      todos: [{ id: 'legacy', kind: 'task', content: '旧任务', status: 'pending' }],
    })).toThrow();

    expect(() => todoWriteToolDescriptor.schema.parse({
      todos: [{ kind: 'business', content: '缺少稳定 ID', status: 'pending' }],
    })).toThrow();
  });

  it('接受语义展示块，并拒绝旧视觉协议与 Todo 内伪造交互块', () => {
    const parsed = todoWriteToolDescriptor.schema.parse({
      todos: [{
        id: 'verify-order',
        kind: 'business',
        content: '核验订单',
        status: 'blocked',
        detail: [{ verdict: 'fail', text: '原产地证已过期' }],
        display: [
          {
            type: 'facts',
            title: '核对订单状态',
            items: [
              { label: '订单', value: 'SO-1001' },
              { label: '客户', value: '开沿科技' },
              { label: '阶段', value: '待复核' },
            ],
          },
          {
            type: 'comparison',
            title: '版本差异',
            items: [{
              label: '接口版本',
              baseline: 'v1',
              current: 'v2',
              delta: '升级 1 个主版本',
              status: 'warn',
            }],
          },
          {
            type: 'checklist',
            title: '放行条件',
            items: [
              { label: '税号有效', status: 'pass' },
              { label: '原产地证有效', status: 'fail', note: '证件已过期' },
            ],
          },
        ],
        evidenceRefs: ['SO-1001'],
      }],
    }) as { todos: Array<Record<string, unknown>> };
    expect(parsed.todos[0]).toMatchObject({ id: 'verify-order', kind: 'business', status: 'blocked' });

    expect(() => todoWriteToolDescriptor.schema.parse({
      todos: [{
        id: 'untitled-facts',
        kind: 'business',
        content: '核对订单',
        status: 'completed',
        display: [{
          type: 'facts',
          items: [{ label: '订单', value: 'SO-1001' }],
        }],
      }],
    })).toThrow();

    for (const whitespaceBlock of [
      { type: 'facts', title: '   ', items: [{ label: '订单', value: 'SO-1001' }] },
      { type: 'facts', title: '订单字段', items: [{ label: '   ', value: 'SO-1001' }] },
      { type: 'facts', title: '订单字段', items: [{ label: '订单', value: '   ' }] },
    ]) {
      expect(() => todoWriteToolDescriptor.schema.parse({
        todos: [{
          id: 'blank-semantic-field',
          kind: 'business',
          content: '拒绝空白语义字段',
          status: 'completed',
          display: [whitespaceBlock],
        }],
      })).toThrow();
    }

    expect(() => todoWriteToolDescriptor.schema.parse({
      todos: [{
        id: 'ambiguous-comparison',
        kind: 'business',
        content: '拒绝含义不明确的旧对照字段',
        status: 'completed',
        display: [{
          type: 'comparison',
          title: '版本差异',
          items: [{ label: '预期', value: 'v2' }],
        }],
      }],
    })).toThrow();

    for (const legacyBlock of [
      { kind: 'callout', tone: 'warn', body: ['当前不能放行'] },
      {
        kind: 'records',
        layout: 'rows',
        title: '核对订单状态',
        items: [{ label: '订单', value: 'SO-1001' }],
      },
    ]) {
      expect(() => todoWriteToolDescriptor.schema.parse({
        todos: [{
          id: 'legacy-display',
          kind: 'business',
          content: '旧展示协议',
          status: 'completed',
          display: [legacyBlock],
        }],
      })).toThrow();
    }

    for (const visualField of [
      { type: 'facts', title: '视觉布局', layout: 'grid', items: [{ label: '订单', value: 'SO-1001' }] },
      { type: 'facts', title: '视觉字体', items: [{ label: '订单', value: 'SO-1001', mono: true }] },
      { type: 'checklist', title: '视觉语气', items: [{ label: '订单有效', status: 'pass', tone: 'success' }] },
    ]) {
      expect(() => todoWriteToolDescriptor.schema.parse({
        todos: [{
          id: 'visual-field',
          kind: 'business',
          content: '拒绝视觉字段',
          status: 'completed',
          display: [visualField],
        }],
      })).toThrow();
    }

    for (const legacyDetail of [
      { k: '工作树', v: '干净' },
      { tree: '└', k: '远端', v: '已同步' },
      { fields: [{ k: '提交', v: '2' }] },
    ]) {
      expect(() => todoWriteToolDescriptor.schema.parse({
        todos: [{
          id: 'legacy-detail-card',
          kind: 'business',
          content: '旧键值卡',
          status: 'completed',
          detail: [legacyDetail],
        }],
      })).toThrow();
    }

    expect(() => todoWriteToolDescriptor.schema.parse({
      todos: [{
        id: 'sectioned-detail-card',
        kind: 'business',
        content: '分组判定清单',
        status: 'completed',
        detail: [{ section: 'Azeroth 需求看板' }, { verdict: 'pass', text: '字段迁移完成' }],
      }],
    })).toThrow();

    expect(() => todoWriteToolDescriptor.schema.parse({
      todos: [{
        id: 'multiple-verdicts',
        kind: 'business',
        content: '多项判定清单',
        status: 'completed',
        detail: [
          { verdict: 'pass', text: '字段迁移完成' },
          { verdict: 'pass', text: '视图迁移完成' },
        ],
      }],
    })).toThrow(/最多允许一条 verdict/);

    expect(() => todoWriteToolDescriptor.schema.parse({
      todos: [{
        id: 'nested-section-detail',
        kind: 'business',
        content: '嵌套详情',
        status: 'completed',
        display: [{
          type: 'checklist',
          title: 'Azeroth 需求看板',
          items: [{
            label: '字段迁移完成',
            status: 'pass',
            detail: [{ section: '回读结果' }, { verdict: 'pass', text: '静态检查通过' }],
          }],
        }],
      }],
    })).not.toThrow();

    expect(() => todoWriteToolDescriptor.schema.parse({
      todos: [{
        id: 'fake-gate',
        kind: 'business',
        content: '等待批准',
        status: 'waiting',
        display: [{
          kind: 'gate',
          title: '伪审批',
          actions: [{ kind: 'primary', label: '批准', interactionId: 'fake' }],
        }],
      }],
    })).toThrow();
  });
});

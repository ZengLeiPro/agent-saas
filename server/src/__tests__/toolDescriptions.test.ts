/**
 * Tool descriptions snapshot baseline（PR 0）。
 *
 * 目的：把当前 ToolDescriptor.description 的字面量 dump 进 vitest snapshot，
 * 作为后续把 description 抽到 .md 文件迁移的"字符级零回归"基线。
 *
 * 后续 PR 1-4 把 description 改成 loadToolDescription(toolId) 后，本 snapshot
 * 必须保持原样通过——任何字符差异（包括首尾空白、内部空格）都会立刻在 CI diff 暴露。
 *
 * 本文件不依赖任何新 loader，只 import 现有 descriptor，零侵入。
 */

import { describe, expect, it } from 'vitest';

import {
  artifactCreateToolDescriptor,
  askUserQuestionToolDescriptor,
  editToolDescriptor,
  todoWriteToolDescriptor,
} from '../agent/builtinTools.js';
import { memoryListToolDescriptor, memorySearchToolDescriptor } from '../agent/memorySearchToolProvider.js';
import { skillToolDescriptor } from '../agent/skillToolProvider.js';
import {
  MAX_FILE_BYTES,
  MAX_READ_LINES,
  bashOutputToolDescriptor,
  killBashToolDescriptor,
  readFileToolDescriptor,
  runShellToolDescriptor,
  waitForWorkspaceReadyToolDescriptor,
  writeFileToolDescriptor,
} from '../agent/toolRuntime.js';
import { generateImageToolDescriptor } from '../agent/imageGenToolProvider.js';
import { webFetchToolDescriptor, webSearchToolDescriptor } from '../agent/webToolProvider.js';
import {
  sessionGetEventsToolDescriptor,
  sessionGetToolTraceToolDescriptor,
  sessionSearchEventsToolDescriptor,
} from '../runtime/sessionContext.js';

const ALL_TOOLS = [
  // builtinTools.ts / workspaceHandTools.ts —— 4
  editToolDescriptor,
  todoWriteToolDescriptor,
  askUserQuestionToolDescriptor,
  artifactCreateToolDescriptor,
  // toolRuntime.ts workspace runtime —— 6
  waitForWorkspaceReadyToolDescriptor,
  readFileToolDescriptor,
  writeFileToolDescriptor,
  runShellToolDescriptor,
  bashOutputToolDescriptor,
  killBashToolDescriptor,
  // sessionContext.ts —— 3
  sessionGetEventsToolDescriptor,
  sessionSearchEventsToolDescriptor,
  sessionGetToolTraceToolDescriptor,
  // web —— 2
  webSearchToolDescriptor,
  webFetchToolDescriptor,
  // media —— 1
  generateImageToolDescriptor,
  // skill / memory —— 3
  skillToolDescriptor,
  memorySearchToolDescriptor,
  memoryListToolDescriptor,
] as const;

describe('Tool descriptions', () => {
  it('covers all 19 tools (regression: 漏 import 立即可见)', () => {
    expect(ALL_TOOLS).toHaveLength(19);
    const ids = ALL_TOOLS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length); // 无重复 id
  });

  it.each(ALL_TOOLS.map((t) => [t.id, t]))(
    '%s has non-empty description without obvious placeholder markers',
    (_id, t) => {
      expect(typeof t.description).toBe('string');
      expect(t.description.length).toBeGreaterThan(20);
      // 只检测显式占位标记，不误伤"TodoWrite"/"todos"等自然语言。
      // snapshot 是字符级回归的终极兜底，这里只兜未 hydrate / 模板未替换的明显错误。
      expect(t.description).not.toMatch(/<placeholder>|\{\{[A-Z_]+\}\}|\$\{[A-Z_]+\}/);
    },
  );

  it('matches snapshot baseline (字符级零回归锚点)', () => {
    // 用对象（id → description）做 snapshot，列表顺序变化不影响
    const map = Object.fromEntries(ALL_TOOLS.map((t) => [t.id, t.description]));
    expect(map).toMatchSnapshot();
  });

  // ─── drift guard：md 里 hardcode 的常量必须跟 TS 常量一致 ────────────────
  //
  // 背景：Read.md 原 TS 用 `Max ${MAX_FILE_BYTES} bytes.`
  // 模板插值，迁移到 md 时把常量当前值写死（"Max 131072 bytes."）。如果 TS 常量改
  // 了但 md 没同步，LLM 收到的描述会跟实际运行行为脱钩（模型按旧上限规划 chunk，
  // 实际运行允许更大文件 → 模型行为退化）。
  //
  // snapshot 测试只锁字符级稳定，**锁不住跟 TS 常量的一致性**。这里加显式断言
  // 形成 CI 闸门：改 MAX_FILE_BYTES 不同步 md，CI 立刻红。
  // 2026-07-25：逐工具硬编码的 drift guard 已收敛为 descriptor.descriptionInvariants
  // 单一声明——同一份数据同时守 CI（下面这条）和后台保存（toolControlsAdmin 的
  // assertDescriptionInvariants）。此前只守内置默认值，管理员用 mode:'replace'
  // 覆盖描述时没有任何闸门。
  it.each(
    ALL_TOOLS.filter((tool) => tool.descriptionInvariants?.length).map((tool) => [tool.id, tool]),
  )('%s description keeps its declared invariants (drift guard)', (_id, tool) => {
    for (const fragment of tool.descriptionInvariants!) {
      expect(tool.description).toContain(fragment);
    }
  });

  // 声明本身也要防退化：Read 的两个上限必须来自 TS 常量而不是手抄的字面量，
  // 否则改了常量、invariants 与描述一起停留在旧值，闸门形同虚设。
  it('Read invariants track the TS constants (drift guard)', () => {
    expect(readFileToolDescriptor.descriptionInvariants).toContain(String(MAX_FILE_BYTES));
    expect(readFileToolDescriptor.descriptionInvariants).toContain(String(MAX_READ_LINES));
  });

  // 2026-07-25（B5）：Python/venv 指引从 static.md 移入 Shell.md。正向片段已进
  // invariants；这里守负向——不得退回"本机内置 venv"的陈旧假设。
  it('Shell description does not resurrect the stale venv assumption', () => {
    expect(runShellToolDescriptor.description).not.toContain('工作区内置 venv');
  });

  it('AskUserQuestion description matches multiSelect schema default (drift guard)', () => {
    expect(askUserQuestionToolDescriptor.description).toContain('运行时默认为 false');
  });
});

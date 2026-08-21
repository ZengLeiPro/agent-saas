import { describe, expect, it } from 'vitest';

import {
  askUserQuestionToolDescriptor,
  todoWriteToolDescriptor,
} from '../agent/builtinTools.js';
import {
  memoryListToolDescriptor,
  memorySearchToolDescriptor,
} from '../agent/memorySearchToolProvider.js';
import { skillToolDescriptor } from '../agent/skillToolProvider.js';
import {
  readFileToolDescriptor,
  runShellToolDescriptor,
  waitForWorkspaceReadyToolDescriptor,
  writeFileToolDescriptor,
  type ToolDescriptor,
} from '../agent/toolRuntime.js';
import { userActivityListToolDescriptor } from '../agent/userActivityToolProvider.js';
import {
  webFetchToolDescriptor,
  webSearchToolDescriptor,
} from '../agent/webToolProvider.js';
import { isParallelSafeToolCall } from '../runtime/rawAgentLoopHelpers.js';
import { sessionContextToolDescriptor } from '../runtime/sessionContext.js';

const PARALLEL_READ_TOOLS = [
  readFileToolDescriptor,
  memorySearchToolDescriptor,
  memoryListToolDescriptor,
  skillToolDescriptor,
  userActivityListToolDescriptor,
  webSearchToolDescriptor,
  webFetchToolDescriptor,
  sessionContextToolDescriptor,
];

describe('工具并发安全契约', () => {
  it('只读、无交互工具显式 opt-in', () => {
    expect(PARALLEL_READ_TOOLS.map((descriptor) => descriptor.name)).toEqual([
      'Read',
      'MemorySearch',
      'MemoryList',
      'Skill',
      'UserActivityList',
      'WebSearch',
      'WebFetch',
      'SessionContext',
    ]);
    expect(PARALLEL_READ_TOOLS.every((descriptor) => descriptor.concurrency === 'parallel')).toBe(true);
  });

  it('写操作、交互与状态等待默认保持串行', () => {
    const serialDescriptors = [
      writeFileToolDescriptor,
      runShellToolDescriptor,
      todoWriteToolDescriptor,
      askUserQuestionToolDescriptor,
      waitForWorkspaceReadyToolDescriptor,
    ];
    expect(serialDescriptors.every((descriptor) => descriptor.concurrency === undefined)).toBe(true);
  });

  it('Shell 只按入参放行前台 snapshot 调用', () => {
    expect(runShellToolDescriptor.resolveConcurrency?.({ command: 'pnpm test', execution: 'snapshot' }))
      .toBe('parallel');
    expect(runShellToolDescriptor.resolveConcurrency?.({ command: 'git status', execution: 'workspace' }))
      .toBeUndefined();
    expect(runShellToolDescriptor.resolveConcurrency?.({
      command: 'pnpm test',
      execution: 'snapshot',
      mode: 'background',
    })).toBeUndefined();
  });

  it('运行时拒绝未 opt-in 或风险配置漂移的 descriptor', () => {
    const call = { id: 'call-1', name: 'Read', arguments: '{"path":"a.txt"}' };
    const descriptors = new Map<string, ToolDescriptor>([['Read', readFileToolDescriptor]]);
    expect(isParallelSafeToolCall(call, descriptors)).toBe(true);

    const { concurrency: _parallel, ...serialReadDescriptor } = readFileToolDescriptor;
    descriptors.set('Read', serialReadDescriptor);
    expect(isParallelSafeToolCall(call, descriptors)).toBe(false);

    descriptors.set('Read', { ...readFileToolDescriptor, risk: 'workspace_write' });
    expect(isParallelSafeToolCall(call, descriptors)).toBe(false);

    descriptors.set('Read', { ...readFileToolDescriptor, approvalMode: 'web' });
    expect(isParallelSafeToolCall(call, descriptors)).toBe(false);
  });
});

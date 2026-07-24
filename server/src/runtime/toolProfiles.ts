/**
 * Per-run 工具 profile（2026-07-14 记忆轮询批次）
 *
 * 与 subagent 的 FilteredToolRuntime 同构（descriptor 白名单：list() 过滤决定
 * 模型可见工具集，invoke() 防御性二次拦截），额外叠加 Write/Edit 的
 * 记忆路径 guard——这是「不新造 MemoryWrite/MemoryEdit 工具」的替代实现：
 * agent 继续用熟悉的 Write/Edit，但只能落在 MEMORY.md / memory/**\/*.md。
 *
 * memory_poll profile 的安全模型：
 *   - 白名单外的工具（CronManage、WebSearch、WebFetch、Agent、Skill、MCP 等）模型根本看不到；
 *   - Write/Edit 继续被路径 guard 收窄到用户自己的记忆文件；
 *   - Shell 是完整命令行能力，因此此 profile 不是只读或写入硬边界；执行器必须
 *     强制使用隔离的 ACS server-remote，不能落到 server-local。
 *
 * profile 由平台内部执行器设置（cron executor / memoryHook），随 run.metadata
 * 持久化；用户不能通过 API 指定。
 */

import { isAbsolute, join, relative, resolve } from 'node:path';

import type {
  AuthorizedToolCall,
  ToolCallContext,
  ToolDescriptor,
  ToolResult,
  ToolRuntime,
} from '../agent/toolRuntime.js';

export type ToolProfileId = 'memory_poll';

const MEMORY_POLL_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  'Read',
  'Shell',
  'MemorySearch',
  'MemoryList',
  'UserActivityList',
  'Write',
  'Edit',
  'WaitForWorkspaceReady',
]);

/** Write 的路径参数是 `path`，Edit 是 `file_path`（两个 descriptor 的既有 schema）。 */
const WRITE_PATH_PARAM: Record<string, string> = {
  Write: 'path',
  Edit: 'file_path',
};

export function normalizeToolProfile(value: unknown): ToolProfileId | undefined {
  return value === 'memory_poll' ? 'memory_poll' : undefined;
}

export function applyToolProfile(runtime: ToolRuntime, profile: ToolProfileId | undefined): ToolRuntime {
  if (profile !== 'memory_poll') return runtime;
  return new ProfileFilteredToolRuntime(runtime, {
    isAllowed: (descriptor) =>
      MEMORY_POLL_TOOL_ALLOWLIST.has(descriptor.name) || MEMORY_POLL_TOOL_ALLOWLIST.has(descriptor.id),
    guardInvoke: guardMemoryPollWritePath,
    profileLabel: 'memory_poll',
  });
}

/**
 * memory_poll 的 Write/Edit 路径 guard：目标必须是 workspace 内的
 * `MEMORY.md` 或 `memory/**\/*.md`。纯路径计算不触 fs；相对路径按
 * workspace.root 解析，`..`/绝对路径越界一律拒绝。
 */
function guardMemoryPollWritePath(call: AuthorizedToolCall, context: ToolCallContext): void {
  const paramName = WRITE_PATH_PARAM[call.toolId];
  if (!paramName) return;
  const input = call.input as Record<string, unknown> | undefined;
  const rawPath = typeof input?.[paramName] === 'string' ? (input[paramName] as string).trim() : '';
  if (!rawPath) {
    throw new Error(`memory_poll 工具约束：${call.toolId} 缺少 ${paramName} 参数。`);
  }
  const root = resolve(context.workspace.root);
  const target = isAbsolute(rawPath) ? resolve(rawPath) : resolve(join(root, rawPath));
  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`memory_poll 工具约束：${call.toolId} 目标越界 workspace（${rawPath}）。`);
  }
  const normalized = rel.split('\\').join('/');
  const allowed = normalized === 'MEMORY.md'
    || (normalized.startsWith('memory/') && normalized.endsWith('.md'));
  if (!allowed) {
    throw new Error(
      `memory_poll 工具约束：只允许写 MEMORY.md 或 memory/**/*.md，拒绝 ${normalized}。`,
    );
  }
}

class ProfileFilteredToolRuntime implements ToolRuntime {
  constructor(
    private readonly inner: ToolRuntime,
    private readonly options: {
      isAllowed: (descriptor: ToolDescriptor) => boolean;
      guardInvoke?: (call: AuthorizedToolCall, context: ToolCallContext) => void;
      profileLabel: string;
    },
  ) {}

  list(context?: ToolCallContext): ToolDescriptor[] {
    return this.inner.list(context).filter((descriptor) => this.options.isAllowed(descriptor));
  }

  async invoke<TInput>(call: AuthorizedToolCall<TInput>, context: ToolCallContext): Promise<ToolResult> {
    const descriptor = this.inner.list(context).find(
      (candidate) => candidate.id === call.toolId || candidate.name === call.toolId,
    );
    if (!descriptor || !this.options.isAllowed(descriptor)) {
      throw new Error(`工具 ${call.toolId} 不在 ${this.options.profileLabel} profile 可用工具集内`);
    }
    this.options.guardInvoke?.(call as AuthorizedToolCall, context);
    return this.inner.invoke(call, context);
  }
}

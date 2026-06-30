/**
 * Agent 适配层导出（生产代码入口）。
 *
 * 注：历史 SDK runner / fileSession 已从仓库移除；生产代码只从这里导出
 * provider-neutral agent 适配层类型与工具。
 */

export {
  buildEnv,
  type AgentOptionsConfig,
} from './options.js';

export {
  buildPrompt,
  buildPromptInput,
  type AgentPromptInput,
} from './prompt.js';

export {
  loadMemoryContext,
} from './memory.js';

export type {
  AgentDispatch,
  AgentRunDispatch,
  AgentRunHooks,
  AgentRunOptions,
  AgentRunResultMeta,
} from './types.js';

/**
 * 平台内建工具静态 catalog。
 *
 * 目的：admin 治理页需要一次性拿到「所有可控工具」及其契约信息（description、
 * JSON Schema、risk、category、label、来源模块），而运行时的 provider 只在
 * 各条会话 runtime 里按需拼装，admin 页无法反射到它们。这里把每个内建
 * descriptor 显式列出——排列顺序决定 UI 主页分组内的展示顺序。
 *
 * 不包含的：
 *   - Agent（子 Agent 调度器）：属于 runtime 核心能力，禁用会瘫痪 subagent，
 *     admin 面板不暴露。
 *   - MCP 客户端上报的动态工具：会话运行时从 McpClientToolProvider 拉取，
 *     未来在 admin 页按 MCP server 分区展示，不进本 catalog。
 *
 * 新增内建工具时：在对应 descriptor 声明处补 category+label，再把 descriptor
 * 追加到 PLATFORM_TOOL_CATALOG，管理页会自动出现新条目。
 */
import type { ToolDescriptor } from './toolRuntime.js';
import {
  readFileToolDescriptor,
  writeFileToolDescriptor,
  runShellToolDescriptor,
  bashOutputToolDescriptor,
  killBashToolDescriptor,
  waitForWorkspaceReadyToolDescriptor,
} from './toolRuntime.js';
import {
  editToolDescriptor,
  artifactCreateToolDescriptor,
} from './workspaceHandTools.js';
import { todoWriteToolDescriptor, askUserQuestionToolDescriptor } from './builtinTools.js';
import { memorySearchToolDescriptor, memoryListToolDescriptor } from './memorySearchToolProvider.js';
import { userActivityListToolDescriptor } from './userActivityToolProvider.js';
import {
  readCompanyInfoToolDescriptor,
  updateCompanyInfoToolDescriptor,
} from './tenantCompanyInfoToolProvider.js';
import { skillToolDescriptor } from './skillToolProvider.js';
import { webSearchToolDescriptor, webFetchToolDescriptor } from './webToolProvider.js';
import { generateImageToolDescriptor } from './imageGenToolProvider.js';
import { cronListToolDescriptor, cronManageToolDescriptor } from './cronToolProvider.js';
import { workflowDemoStepToolDescriptor } from './workflowDemoToolProvider.js';
import {
  sessionGetEventsToolDescriptor,
  sessionSearchEventsToolDescriptor,
  sessionGetToolTraceToolDescriptor,
} from '../runtime/sessionContext.js';

/**
 * 平台内建工具的完整清单。展示顺序=admin 主页 grid 内工具卡片顺序。
 */
export const PLATFORM_TOOL_CATALOG: readonly ToolDescriptor[] = [
  // workspace
  waitForWorkspaceReadyToolDescriptor,
  readFileToolDescriptor,
  writeFileToolDescriptor,
  editToolDescriptor,
  artifactCreateToolDescriptor,
  runShellToolDescriptor,
  bashOutputToolDescriptor,
  killBashToolDescriptor,
  // memory
  memorySearchToolDescriptor,
  memoryListToolDescriptor,
  userActivityListToolDescriptor,
  readCompanyInfoToolDescriptor,
  updateCompanyInfoToolDescriptor,
  // skill
  skillToolDescriptor,
  // meta
  todoWriteToolDescriptor,
  askUserQuestionToolDescriptor,
  // session
  sessionGetEventsToolDescriptor,
  sessionSearchEventsToolDescriptor,
  sessionGetToolTraceToolDescriptor,
  // web
  webSearchToolDescriptor,
  webFetchToolDescriptor,
  // media
  generateImageToolDescriptor,
  // cron
  cronListToolDescriptor,
  cronManageToolDescriptor,
  // workflow demo
  workflowDemoStepToolDescriptor,
];

/**
 * descriptor.id → descriptor 快查表。admin route 校验 :toolId 时用。
 */
export const PLATFORM_TOOL_CATALOG_BY_ID: ReadonlyMap<string, ToolDescriptor> = new Map(
  PLATFORM_TOOL_CATALOG.map((tool) => [tool.id, tool]),
);

/**
 * 判断一个 toolId 是否是平台内建工具（区别于 MCP 动态工具）。
 * 用于 config schema 校验：只允许 override 内建工具，不允许污染 MCP 工具。
 */
export function isPlatformBuiltinTool(toolId: string): boolean {
  return PLATFORM_TOOL_CATALOG_BY_ID.has(toolId);
}

/**
 * toolId → 定义所在的源文件（server/src 相对路径）。admin UI 排查时展示，
 * 方便 admin 直接跳到源码定位问题。手工维护——新增内建工具时补一条即可。
 */
export const PLATFORM_TOOL_SOURCE_MODULE: Readonly<Record<string, string>> = {
  Read: 'server/src/agent/toolRuntime.ts',
  Write: 'server/src/agent/toolRuntime.ts',
  Shell: 'server/src/agent/toolRuntime.ts',
  BashOutput: 'server/src/agent/toolRuntime.ts',
  KillBash: 'server/src/agent/toolRuntime.ts',
  WaitForWorkspaceReady: 'server/src/agent/toolRuntime.ts',
  Edit: 'server/src/agent/workspaceHandTools.ts',
  CreateArtifact: 'server/src/agent/workspaceHandTools.ts',
  TodoWrite: 'server/src/agent/builtinTools.ts',
  AskUserQuestion: 'server/src/agent/builtinTools.ts',
  MemorySearch: 'server/src/agent/memorySearchToolProvider.ts',
  MemoryList: 'server/src/agent/memorySearchToolProvider.ts',
  UserActivityList: 'server/src/agent/userActivityToolProvider.ts',
  ReadCompanyInfo: 'server/src/agent/tenantCompanyInfoToolProvider.ts',
  UpdateCompanyInfo: 'server/src/agent/tenantCompanyInfoToolProvider.ts',
  Skill: 'server/src/agent/skillToolProvider.ts',
  WebSearch: 'server/src/agent/webToolProvider.ts',
  WebFetch: 'server/src/agent/webToolProvider.ts',
  GenerateImage: 'server/src/agent/imageGenToolProvider.ts',
  CronList: 'server/src/agent/cronToolProvider.ts',
  CronManage: 'server/src/agent/cronToolProvider.ts',
  WorkflowDemoStep: 'server/src/agent/workflowDemoToolProvider.ts',
  SessionGetEvents: 'server/src/runtime/sessionContext.ts',
  SessionSearchEvents: 'server/src/runtime/sessionContext.ts',
  SessionGetToolTrace: 'server/src/runtime/sessionContext.ts',
};

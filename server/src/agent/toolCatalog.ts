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
 *   - BackgroundTask（后台任务治理）：与 Agent 配套的 runtime 核心能力，同上。
 *   - MCP 客户端上报的动态工具：会话运行时从 McpClientToolProvider 拉取，
 *     未来在 admin 页按 MCP server 分区展示，不进本 catalog。
 *
 * ⚠️ 新增内建工具的准入门槛（2026-08-03 工具面收敛批次立规）：
 *   每个新工具都是全体会话的固定 prompt 成本与模型误选面。新增前必须先回答
 *   「为什么不能是现有工具的一个 action/参数」——读写同域优先合并为单工具
 *   （action 分档，配 resolveCallPolicy 保持审批粒度，参照 CronManage/CompanyInfo）；
 *   同一资源域的 CRUD 不要拆成多个工具（反例见已合并的 BackgroundTask 五合一、
 *   SessionContext 三合一）。确需新增时：在 descriptor 声明处补 category+label，
 *   把 descriptor 追加到 PLATFORM_TOOL_CATALOG，并同步 PLATFORM_TOOL_SOURCE_MODULE。
 */
import type { ToolDescriptor } from './toolRuntime.js';
import {
  readFileToolDescriptor,
  writeFileToolDescriptor,
  runShellToolDescriptor,
  waitForWorkspaceReadyToolDescriptor,
} from './toolRuntime.js';
import {
  editToolDescriptor,
  artifactCreateToolDescriptor,
} from './workspaceHandTools.js';
import { todoWriteToolDescriptor, askUserQuestionToolDescriptor } from './builtinTools.js';
import { memorySearchToolDescriptor, memoryListToolDescriptor } from './memorySearchToolProvider.js';
import { userActivityListToolDescriptor } from './userActivityToolProvider.js';
import { companyInfoToolDescriptor } from './tenantCompanyInfoToolProvider.js';
import { skillToolDescriptor } from './skillToolProvider.js';
import { webSearchToolDescriptor, webFetchToolDescriptor } from './webToolProvider.js';
import { generateImageToolDescriptor } from './imageGenToolProvider.js';
import { audioTranscribeToolDescriptor } from './audioTranscribeToolProvider.js';
import { cronManageToolDescriptor } from './cronToolProvider.js';
import { sessionContextToolDescriptor } from '../runtime/sessionContext.js';

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
  // memory
  memorySearchToolDescriptor,
  memoryListToolDescriptor,
  userActivityListToolDescriptor,
  companyInfoToolDescriptor,
  // skill
  skillToolDescriptor,
  // meta
  todoWriteToolDescriptor,
  askUserQuestionToolDescriptor,
  // session
  sessionContextToolDescriptor,
  // web
  webSearchToolDescriptor,
  webFetchToolDescriptor,
  // media
  generateImageToolDescriptor,
  audioTranscribeToolDescriptor,
  // cron
  cronManageToolDescriptor,
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

/*
 * 退休键说明（2026-08-03 工具面收敛批次）：BashOutput/KillBash/CronList/
 * ReadCompanyInfo/UpdateCompanyInfo/SessionGetEvents/SessionSearchEvents/
 * SessionGetToolTrace 已分别并入 BackgroundTask/CronManage/CompanyInfo/
 * SessionContext。存量 toolControls 配置里的旧键运行时零副作用（isToolEnabled
 * 只匹配现役 descriptor），并会在下次任何保存时被 pruneUnknownToolControls
 * 自动清理——与 07-25 List/Glob/Grep 退休批次同一机制。
 */

/**
 * toolId → 定义所在的源文件（server/src 相对路径）。admin UI 排查时展示，
 * 方便 admin 直接跳到源码定位问题。手工维护——新增内建工具时补一条即可。
 */
export const PLATFORM_TOOL_SOURCE_MODULE: Readonly<Record<string, string>> = {
  Read: 'server/src/agent/toolRuntime.ts',
  Write: 'server/src/agent/toolRuntime.ts',
  Shell: 'server/src/agent/toolRuntime.ts',
  WaitForWorkspaceReady: 'server/src/agent/toolRuntime.ts',
  Edit: 'server/src/agent/workspaceHandTools.ts',
  CreateArtifact: 'server/src/agent/workspaceHandTools.ts',
  TodoWrite: 'server/src/agent/builtinTools.ts',
  AskUserQuestion: 'server/src/agent/builtinTools.ts',
  MemorySearch: 'server/src/agent/memorySearchToolProvider.ts',
  MemoryList: 'server/src/agent/memorySearchToolProvider.ts',
  UserActivityList: 'server/src/agent/userActivityToolProvider.ts',
  CompanyInfo: 'server/src/agent/tenantCompanyInfoToolProvider.ts',
  Skill: 'server/src/agent/skillToolProvider.ts',
  WebSearch: 'server/src/agent/webToolProvider.ts',
  WebFetch: 'server/src/agent/webToolProvider.ts',
  GenerateImage: 'server/src/agent/imageGenToolProvider.ts',
  AudioTranscribe: 'server/src/agent/audioTranscribeToolProvider.ts',
  CronManage: 'server/src/agent/cronToolProvider.ts',
  SessionContext: 'server/src/runtime/sessionContext.ts',
};

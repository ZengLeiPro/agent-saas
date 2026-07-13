import type { WebMessageDisplayConfig } from '../../types/index.js';
import { isSkillTool } from '../toolNameResolver.js';

export type WebBlockType = 'text' | 'thinking' | 'tool_use';

/**
 * 交互性工具：由 canUseTool 侧通道驱动交互 UI（ask_user / permission_request），
 * 不需要作为普通 tool_use / tool_result 事件推送给前端。
 */
const INTERACTIVE_TOOLS = new Set([
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
]);

/**
 * 拥有独立 Web 卡片的工具：交互工具走 ask_user / permission_request，Agent
 * 走 subagent_start / subagent_end。它们都不能再进入通用 tool_use 通道。
 */
const DEDICATED_WEB_TOOLS = new Set([
  ...INTERACTIVE_TOOLS,
  'Agent',
]);

export function isDedicatedWebTool(toolName: string | undefined): boolean {
  return !!toolName && DEDICATED_WEB_TOOLS.has(toolName);
}

export function shouldSendWebBlock(
  blockType: WebBlockType,
  toolName: string | undefined,
  config: WebMessageDisplayConfig,
): boolean {
  if (blockType === 'text') {
    return true;
  }

  if (blockType === 'thinking') {
    return config.thinking !== false;
  }

  if (blockType === 'tool_use') {
    if (isDedicatedWebTool(toolName)) return false;
    return isSkillTool(toolName) ? config.skillInput !== false : config.toolInput !== false;
  }

  return false;
}

export function shouldSendWebToolResult(
  toolName: string | undefined,
  config: WebMessageDisplayConfig,
): boolean {
  if (isDedicatedWebTool(toolName)) return false;
  return isSkillTool(toolName) ? config.skillResult !== false : config.toolResult !== false;
}

export function getWebDisplayConfig(
  config: WebMessageDisplayConfig | undefined,
): WebMessageDisplayConfig {
  return config ?? {};
}

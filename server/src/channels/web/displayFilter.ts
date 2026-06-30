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

export function isInteractiveTool(toolName: string | undefined): boolean {
  return !!toolName && INTERACTIVE_TOOLS.has(toolName);
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
    if (isInteractiveTool(toolName)) return false;
    return isSkillTool(toolName) ? config.skillInput !== false : config.toolInput !== false;
  }

  return false;
}

export function shouldSendWebToolResult(
  toolName: string | undefined,
  config: WebMessageDisplayConfig,
): boolean {
  if (isInteractiveTool(toolName)) return false;
  return isSkillTool(toolName) ? config.skillResult !== false : config.toolResult !== false;
}

export function getWebDisplayConfig(
  config: WebMessageDisplayConfig | undefined,
): WebMessageDisplayConfig {
  return config ?? {};
}

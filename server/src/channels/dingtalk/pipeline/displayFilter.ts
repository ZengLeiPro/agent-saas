import type { DingtalkMessageDisplayConfig } from '../../../types/index.js';
import { isSkillTool } from '../../toolNameResolver.js';

export type DingtalkBlockType = 'text' | 'thinking' | 'tool_use';

export function shouldSendDingtalkBlockStart(
  blockType: DingtalkBlockType,
  toolName: string | undefined,
  config: DingtalkMessageDisplayConfig,
): boolean {
  if (blockType === 'thinking') {
    return config.thinking !== false;
  }

  if (blockType === 'tool_use') {
    return isSkillTool(toolName) ? config.skillStart !== false : config.toolStart !== false;
  }

  return false;
}

export function shouldSendDingtalkBlockComplete(
  blockType: DingtalkBlockType,
  toolName: string | undefined,
  config: DingtalkMessageDisplayConfig,
): boolean {
  if (blockType === 'tool_use') {
    return isSkillTool(toolName) ? config.skillComplete === true : config.toolComplete === true;
  }

  return false;
}

export function getDingtalkDisplayConfig(
  config: DingtalkMessageDisplayConfig | undefined,
): DingtalkMessageDisplayConfig {
  return config ?? {};
}

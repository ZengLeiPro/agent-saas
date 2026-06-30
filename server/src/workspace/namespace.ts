import { join } from 'path';

export const KY_AGENT_DIR = '.ky-agent';
export const WORKSPACE_META_FILE = 'workspace.json';

export function agentDir(root: string): string {
  return join(root, KY_AGENT_DIR);
}

export function resolveAgentDir(root: string, options: { preferExisting?: boolean } = {}): string {
  void options;
  return agentDir(root);
}

export function agentPath(root: string, ...segments: string[]): string {
  return join(agentDir(root), ...segments);
}

export function resolveAgentPath(root: string, ...segments: string[]): string {
  return agentPath(root, ...segments);
}

export function agentSkillsDir(root: string): string {
  return agentPath(root, 'skills');
}

export function agentScriptsDir(root: string): string {
  return agentPath(root, 'scripts');
}

export function agentSettingsPath(root: string): string {
  return agentPath(root, 'settings.json');
}

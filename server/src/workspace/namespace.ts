import { existsSync } from 'fs';
import { join } from 'path';

export const KY_AGENT_DIR = '.ky-agent';
export const LEGACY_CLAUDE_DIR = '.claude';
export const WORKSPACE_META_FILE = 'workspace.json';

export function agentDir(root: string): string {
  return join(root, KY_AGENT_DIR);
}

export function legacyClaudeDir(root: string): string {
  return join(root, LEGACY_CLAUDE_DIR);
}

export function resolveAgentDir(root: string, options: { preferExisting?: boolean } = {}): string {
  const next = agentDir(root);
  if (!options.preferExisting) return next;
  if (existsSync(next)) return next;
  const legacy = legacyClaudeDir(root);
  return existsSync(legacy) ? legacy : next;
}

export function agentPath(root: string, ...segments: string[]): string {
  return join(agentDir(root), ...segments);
}

export function legacyClaudePath(root: string, ...segments: string[]): string {
  return join(legacyClaudeDir(root), ...segments);
}

export function resolveAgentPath(root: string, ...segments: string[]): string {
  const next = agentPath(root, ...segments);
  if (existsSync(next)) return next;
  const legacy = legacyClaudePath(root, ...segments);
  return existsSync(legacy) ? legacy : next;
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

export function legacySettingsPath(root: string): string {
  return legacyClaudePath(root, 'settings.json');
}

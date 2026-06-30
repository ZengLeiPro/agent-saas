import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
} from 'fs';
import { dirname, join } from 'path';

import { serverLogger } from '../utils/logger.js';
import { agentDir, agentPath, legacyClaudeDir } from './namespace.js';

export interface WorkspaceOwnership {
  uid?: number;
  gid?: number;
}

const DEFAULT_WORKSPACE_UID = 501;
const DEFAULT_WORKSPACE_GID = 20;

function parseIntEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseModeEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw.replace(/^0o/i, ''), 8);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 0o7777 ? parsed : fallback;
}

export function getWorkspaceOwnership(): WorkspaceOwnership {
  if (process.env.KY_AGENT_WORKSPACE_CHOWN === '0') return {};
  return {
    uid: parseIntEnv('KY_AGENT_WORKSPACE_UID') ?? parseIntEnv('AGENT_WORKSPACE_UID') ?? DEFAULT_WORKSPACE_UID,
    gid: parseIntEnv('KY_AGENT_WORKSPACE_GID') ?? parseIntEnv('AGENT_WORKSPACE_GID') ?? DEFAULT_WORKSPACE_GID,
  };
}

function applyPathModeAndOwner(path: string, mode?: number, ownership = getWorkspaceOwnership()): void {
  if (!existsSync(path)) return;
  let current;
  try {
    const link = lstatSync(path);
    if (link.isSymbolicLink()) return;
    current = statSync(path);
  } catch (err) {
    serverLogger.warn(`workspace permission stat failed: ${path}: ${err}`);
    return;
  }

  try {
    if (ownership.uid !== undefined || ownership.gid !== undefined) {
      chownSync(path, ownership.uid ?? current.uid, ownership.gid ?? current.gid);
    }
  } catch (err) {
    serverLogger.warn(`workspace chown failed: ${path}: ${err}`);
  }

  if (mode !== undefined) {
    try {
      chmodSync(path, mode);
    } catch (err) {
      serverLogger.warn(`workspace chmod failed: ${path}: ${err}`);
    }
  }
}

export function ensureWorkspaceDir(path: string, mode: number, ownership = getWorkspaceOwnership()): void {
  mkdirSync(path, { recursive: true });
  applyPathModeAndOwner(path, mode, ownership);
}

export function repairWorkspacePath(path: string, mode?: number, ownership = getWorkspaceOwnership()): void {
  applyPathModeAndOwner(path, mode, ownership);
}

export function repairWorkspaceTree(path: string, mode?: number, ownership = getWorkspaceOwnership()): void {
  if (!existsSync(path)) return;
  applyPathModeAndOwner(path, mode, ownership);
  let current;
  try {
    const link = lstatSync(path);
    if (link.isSymbolicLink()) return;
    current = statSync(path);
  } catch {
    return;
  }
  if (!current.isDirectory()) return;
  let entries;
  try {
    entries = readdirSync(path);
  } catch {
    return;
  }
  for (const entry of entries) {
    repairWorkspaceTree(join(path, entry), mode, ownership);
  }
}

export function ensureWorkspaceRuntimeLayout(userCwd: string): void {
  const ownership = getWorkspaceOwnership();
  const rootMode = parseModeEnv('KY_AGENT_WORKSPACE_ROOT_MODE', 0o775);
  const dataMode = parseModeEnv('KY_AGENT_WORKSPACE_DATA_MODE', 0o775);
  const privateMode = parseModeEnv('KY_AGENT_WORKSPACE_PRIVATE_MODE', 0o700);
  const runtimeMode = parseModeEnv('KY_AGENT_WORKSPACE_RUNTIME_MODE', 0o770);
  const fileMode = parseModeEnv('KY_AGENT_WORKSPACE_FILE_MODE', 0o664);

  ensureWorkspaceDir(userCwd, rootMode, ownership);

  const migratedAgentNamespace = migrateLegacyAgentNamespace(userCwd);
  const migratedRuntimeArtifacts = migrateLegacyRuntimeArtifacts(userCwd);

  ensureWorkspaceDir(join(userCwd, 'memory'), dataMode, ownership);
  ensureWorkspaceDir(join(userCwd, 'memory', 'topics'), dataMode, ownership);
  ensureWorkspaceDir(join(userCwd, 'uploads'), dataMode, ownership);

  ensureWorkspaceDir(agentDir(userCwd), runtimeMode, ownership);
  ensureWorkspaceDir(agentPath(userCwd, 'skills'), dataMode, ownership);
  ensureWorkspaceDir(agentPath(userCwd, 'scripts'), dataMode, ownership);
  ensureWorkspaceDir(agentPath(userCwd, 'runtime'), runtimeMode, ownership);
  ensureWorkspaceDir(agentPath(userCwd, 'runtime', 'cache'), runtimeMode, ownership);
  ensureWorkspaceDir(agentPath(userCwd, 'runtime', 'cache', 'npm'), runtimeMode, ownership);
  ensureWorkspaceDir(agentPath(userCwd, 'runtime', 'cache', 'pip'), runtimeMode, ownership);
  ensureWorkspaceDir(agentPath(userCwd, 'runtime', 'cache', 'azeroth-cli'), runtimeMode, ownership);
  ensureWorkspaceDir(agentPath(userCwd, 'runtime', 'browser-profile'), privateMode, ownership);
  ensureWorkspaceDir(agentPath(userCwd, 'runtime', 'provision'), runtimeMode, ownership);
  ensureWorkspaceDir(agentPath(userCwd, 'runtime', 'venv-archive'), runtimeMode, ownership);

  for (const tree of [
    join(userCwd, 'memory'),
    agentPath(userCwd, 'skills'),
    agentPath(userCwd, 'scripts'),
  ]) {
    repairWorkspaceTree(tree, undefined, ownership);
  }
  if (migratedAgentNamespace || migratedRuntimeArtifacts || process.env.KY_AGENT_WORKSPACE_DEEP_REPAIR === '1') {
    repairWorkspaceTree(agentPath(userCwd, 'runtime', 'browser-profile'), undefined, ownership);
  }

  for (const file of [
    join(userCwd, 'MEMORY.md'),
    join(userCwd, 'PERSONA.md'),
    join(userCwd, 'package.json'),
    join(userCwd, 'memory', 'questions.md'),
    agentPath(userCwd, 'workspace.json'),
  ]) {
    repairWorkspacePath(file, fileMode, ownership);
  }

  repairLegacyRuntimeLayout(userCwd, ownership, { dataMode, privateMode, runtimeMode, fileMode });
}

export function migrateLegacyAgentNamespace(userCwd: string): boolean {
  const legacy = legacyClaudeDir(userCwd);
  const next = agentDir(userCwd);
  if (!existsSync(legacy)) return false;
  if (!existsSync(next)) {
    try {
      renameSync(legacy, next);
      serverLogger.info(`Migrated workspace agent namespace: ${legacy} → ${next}`);
      return true;
    } catch (err) {
      serverLogger.warn(`Failed to migrate workspace agent namespace ${legacy} → ${next}: ${err}`);
      return false;
    }
  }
  return mergeLegacyAgentNamespace(legacy, next);
}

function mergeLegacyAgentNamespace(sourceDir: string, targetDir: string): boolean {
  let moved = false;
  let entries: string[];
  try {
    entries = readdirSync(sourceDir);
  } catch {
    return false;
  }

  for (const entry of entries) {
    const source = join(sourceDir, entry);
    const target = join(targetDir, entry);
    if (!existsSync(target)) {
      try {
        renameSync(source, target);
        moved = true;
      } catch (err) {
        serverLogger.warn(`Failed to move legacy agent namespace entry ${source} → ${target}: ${err}`);
      }
      continue;
    }

    try {
      const sourceStat = statSync(source);
      const targetStat = statSync(target);
      if (sourceStat.isDirectory() && targetStat.isDirectory()) {
        moved = mergeLegacyAgentNamespace(source, target) || moved;
      }
    } catch {
      // Keep both copies when either side cannot be inspected; preserving data is safer than guessing.
    }
  }

  if (moved) {
    serverLogger.info(`Merged legacy workspace agent namespace into ${targetDir}`);
  }
  return moved;
}

function migrateLegacyRuntimeArtifacts(userCwd: string): boolean {
  let migrated = false;
  migrated = moveIfTargetMissing(
    join(userCwd, '.venv'),
    agentPath(userCwd, 'runtime', 'venv'),
  ) || migrated;
  migrated = moveIfTargetMissing(
    join(userCwd, '.browser-profile'),
    agentPath(userCwd, 'runtime', 'browser-profile'),
  ) || migrated;
  migrated = moveIfTargetMissing(
    join(userCwd, '.agent-saas', 'provision-hash'),
    agentPath(userCwd, 'runtime', 'provision', 'provision-hash'),
  ) || migrated;
  return migrated;
}

function moveIfTargetMissing(source: string, target: string): boolean {
  if (!existsSync(source) || existsSync(target)) return false;
  try {
    mkdirSync(dirname(target), { recursive: true });
    renameSync(source, target);
    serverLogger.info(`Migrated workspace runtime artifact: ${source} → ${target}`);
    return true;
  } catch (err) {
    serverLogger.warn(`Failed to migrate workspace runtime artifact ${source} → ${target}: ${err}`);
    return false;
  }
}

function repairLegacyRuntimeLayout(
  userCwd: string,
  ownership: WorkspaceOwnership,
  modes: { dataMode: number; privateMode: number; runtimeMode: number; fileMode: number },
): void {
  const legacy = legacyClaudeDir(userCwd);
  if (existsSync(legacy)) {
    repairWorkspacePath(legacy, modes.runtimeMode, ownership);
  }
  for (const dir of [
    join(legacy, 'skills'),
    join(legacy, 'scripts'),
    join(userCwd, '.agent-saas'),
    join(userCwd, '.agent-saas', 'venv-archive'),
    join(userCwd, '.cache'),
    join(userCwd, '.cache', 'pip'),
    join(userCwd, '.venv'),
  ]) {
    if (existsSync(dir)) repairWorkspacePath(dir, modes.runtimeMode, ownership);
  }
  const browserProfile = join(userCwd, '.browser-profile');
  if (existsSync(browserProfile)) repairWorkspacePath(browserProfile, modes.privateMode, ownership);
  const legacySettings = join(legacy, 'settings.json');
  if (existsSync(legacySettings)) repairWorkspacePath(legacySettings, modes.fileMode, ownership);
}

import type { ToolDescriptor } from 'server/agent/toolRuntime.js';
import { WORKSPACE_HAND_TOOLS } from 'server/agent/toolRuntime.js';
import type { ToolInvocationResponse, ToolInvocationStreamChunk } from 'server/runtime/handProtocol.js';
import { pickHandEnv } from 'server/runtime/handEnvAllowlist.js';

export const MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface WireWorkspaceRef {
  id?: string;
  userId?: string;
  username?: string;
  sessionId?: string;
  sandboxScopeId?: string;
  mountSubPath?: string;
  executionTarget?: string;
}

export interface WireToolInvocationRequest {
  toolName: string;
  input: unknown;
  context: {
    invocationId?: string;
    workspace: WireWorkspaceRef;
    /**
     * 07-05：显式透传给远端 pod 的 env（仅 HAND_ENV_ALLOWLIST 内的 key，例如
     * AZEROTH_TOKEN / AZEROTH_API_URL）。上游 brain 侧 HttpTransport.envResolver
     * 生成；本 protocol 层 parseWireRequest 再走 pickHandEnv 二次剥离。
     */
    env?: Record<string, string>;
  };
}

export interface WorkspaceRecipe {
  workspaceId: string;
  sessionId?: string;
  sandboxScopeId?: string;
  mountSubPath?: string;
  repo?: { url: string; ref?: string; remote?: string };
  files?: Array<{ artifactId: string; path: string; url?: string; signedUrl?: string }>;
  setupCommands?: string[];
  resources?: { timeoutMs?: number };
}

export interface ProvisioningLogEntry {
  step: string;
  command?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  durationMs?: number;
  status: 'ok' | 'error' | 'skipped';
  note?: string;
}

export interface SandboxRunnerInput {
  toolName: string;
  input: unknown;
  invocationId?: string;
  workspace: {
    id?: string;
    userId?: string;
    username?: string;
    sessionId?: string;
    root: string;
  };
  stream?: boolean;
  /**
   * 07-05：从 wire.context.env（allowlist 已过滤）透传到 pod 内 sandboxRunner，
   * 由 runner 合并进 spawn 子进程的 env（Shell 等 tool 才拿得到 AZEROTH_TOKEN）。
   */
  env?: Record<string, string>;
}

export interface SandboxRunnerOutput {
  kind: 'chunk';
  chunk: ToolInvocationStreamChunk;
}

export interface SandboxRunnerFinalOutput {
  kind: 'final';
  response: ToolInvocationResponse;
}

export function buildToolsResponse(): Record<string, unknown> {
  return {
    status: 'ok',
    backend: 'acs-agent-sandbox',
    internalExecutionTarget: 'server-local',
    tools: WORKSPACE_HAND_TOOLS.map((tool: ToolDescriptor) => ({
      id: tool.id,
      name: tool.name,
      displayName: tool.displayName,
      description: tool.description,
      risk: tool.risk,
      approvalMode: tool.approvalMode,
      auditCategory: tool.auditCategory,
    })),
  };
}

export function parseWireRequest(body: unknown): { ok: true; value: WireToolInvocationRequest } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body 必须是 object' };
  const b = body as Record<string, unknown>;
  if (typeof b.toolName !== 'string' || !b.toolName) return { ok: false, error: 'toolName 必须为非空字符串' };
  const context = b.context as Record<string, unknown> | undefined;
  const workspace = context?.workspace as Record<string, unknown> | undefined;
  if (!workspace || typeof workspace !== 'object') return { ok: false, error: 'context.workspace 必须是 object' };
  const id = typeof workspace.id === 'string' ? workspace.id : undefined;
  const sessionId = typeof workspace.sessionId === 'string' ? workspace.sessionId : undefined;
  if (!id) return { ok: false, error: 'context.workspace.id 必须为非空字符串' };
  if (!sessionId) return { ok: false, error: 'context.workspace.sessionId 必须为非空字符串（用于会话审计与 runner 上下文）' };
  const mountSubPath = parseMountSubPath(workspace.mountSubPath);
  if (mountSubPath.error) return { ok: false, error: mountSubPath.error };
  const sandboxScopeId = typeof workspace.sandboxScopeId === 'string' && workspace.sandboxScopeId.trim()
    ? workspace.sandboxScopeId.trim()
    : undefined;
  const sandboxScope = parseSandboxScopeId(sandboxScopeId);
  if (sandboxScope.error) return { ok: false, error: sandboxScope.error };
  // 07-05：wire env 双重防线——上游 HttpTransport 只 pick allowlist，服务端反序列化
  // 再 pick 一次，即使 client 塞了别的 key 也会被 pickHandEnv 剥掉。空对象则不写字段。
  const rawEnv = context?.env;
  const env = rawEnv && typeof rawEnv === 'object' && !Array.isArray(rawEnv)
    ? pickHandEnv(rawEnv as Record<string, string | undefined>)
    : {};
  const envKeys = Object.keys(env);

  return {
    ok: true,
    value: {
      toolName: b.toolName,
      input: b.input,
      context: {
        ...(typeof context?.invocationId === 'string' ? { invocationId: context.invocationId } : {}),
        workspace: {
          id,
          sessionId,
          ...(sandboxScope.value ? { sandboxScopeId: sandboxScope.value } : {}),
          ...(mountSubPath.value ? { mountSubPath: mountSubPath.value } : {}),
          ...(typeof workspace.userId === 'string' ? { userId: workspace.userId } : {}),
          ...(typeof workspace.username === 'string' ? { username: workspace.username } : {}),
          ...(typeof workspace.executionTarget === 'string' ? { executionTarget: workspace.executionTarget } : {}),
        },
        ...(envKeys.length > 0 ? { env } : {}),
      },
    },
  };
}

export function parseProvisionRecipe(body: unknown): { ok: true; value: WorkspaceRecipe } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body 必须是 object' };
  const obj = body as Record<string, unknown>;
  const recipeRaw = obj.recipe && typeof obj.recipe === 'object' ? obj.recipe as Record<string, unknown> : {};
  const workspaceId = typeof obj.workspaceId === 'string' && obj.workspaceId.trim()
    ? obj.workspaceId.trim()
    : typeof recipeRaw.workspaceId === 'string' && recipeRaw.workspaceId.trim()
      ? recipeRaw.workspaceId.trim()
      : undefined;
  if (!workspaceId) return { ok: false, error: 'workspaceId 必须为非空字符串' };
  const sessionId = typeof recipeRaw.sessionId === 'string' && recipeRaw.sessionId.trim()
    ? recipeRaw.sessionId.trim()
    : typeof obj.sessionId === 'string' && obj.sessionId.trim()
      ? obj.sessionId.trim()
      : undefined;
  if (!sessionId) return { ok: false, error: 'sessionId 必须为非空字符串（用于会话审计与 runner 上下文）' };
  const recipe: WorkspaceRecipe = { workspaceId, sessionId };
  const sandboxScopeId = typeof recipeRaw.sandboxScopeId === 'string' && recipeRaw.sandboxScopeId.trim()
    ? recipeRaw.sandboxScopeId.trim()
    : typeof obj.sandboxScopeId === 'string' && obj.sandboxScopeId.trim()
      ? obj.sandboxScopeId.trim()
      : undefined;
  const sandboxScope = parseSandboxScopeId(sandboxScopeId);
  if (sandboxScope.error) return { ok: false, error: sandboxScope.error };
  if (sandboxScope.value) recipe.sandboxScopeId = sandboxScope.value;
  const mountSubPath = parseMountSubPath(recipeRaw.mountSubPath ?? obj.mountSubPath);
  if (mountSubPath.error) return { ok: false, error: mountSubPath.error };
  if (mountSubPath.value) recipe.mountSubPath = mountSubPath.value;
  const repo = recipeRaw.repo;
  if (repo && typeof repo === 'object' && typeof (repo as { url?: unknown }).url === 'string') {
    const raw = repo as { url: string; ref?: unknown; remote?: unknown };
    recipe.repo = {
      url: raw.url,
      ...(typeof raw.ref === 'string' ? { ref: raw.ref } : {}),
      ...(typeof raw.remote === 'string' ? { remote: raw.remote } : {}),
    };
  }
  if (Array.isArray(recipeRaw.files)) {
    const files: WorkspaceRecipe['files'] = [];
    for (const item of recipeRaw.files) {
      if (!item || typeof item !== 'object') continue;
      const raw = item as { artifactId?: unknown; path?: unknown; url?: unknown; signedUrl?: unknown };
      if (typeof raw.artifactId !== 'string' || typeof raw.path !== 'string') continue;
      files.push({
        artifactId: raw.artifactId,
        path: raw.path,
        ...(typeof raw.url === 'string' ? { url: raw.url } : {}),
        ...(typeof raw.signedUrl === 'string' ? { signedUrl: raw.signedUrl } : {}),
      });
    }
    if (files.length) recipe.files = files;
  }
  if (Array.isArray(recipeRaw.setupCommands)) {
    const setupCommands = recipeRaw.setupCommands.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
    if (setupCommands.length) recipe.setupCommands = setupCommands;
  }
  const resources = recipeRaw.resources;
  if (resources && typeof resources === 'object' && typeof (resources as { timeoutMs?: unknown }).timeoutMs === 'number') {
    recipe.resources = { timeoutMs: (resources as { timeoutMs: number }).timeoutMs };
  }
  return { ok: true, value: recipe };
}

function parseMountSubPath(value: unknown): { value?: string; error?: string } {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'string') return { error: 'mountSubPath 必须是字符串' };
  const trimmed = value.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith('/') || trimmed.includes('\\')) return { error: 'mountSubPath 必须是相对 POSIX 路径' };
  const parts = trimmed.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    return { error: 'mountSubPath 不能包含空路径段、. 或 ..' };
  }
  return { value: parts.join('/') };
}

function parseSandboxScopeId(value: string | undefined): { value?: string; error?: string } {
  if (!value) return {};
  if (value.includes('/') || value.includes('\\') || value.includes('..') || value.startsWith('.')) {
    return { error: 'sandboxScopeId 非法' };
  }
  return { value };
}

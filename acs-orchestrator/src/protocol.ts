import { parseCorrelationContext, type CorrelationContext } from '@agent/shared';

import type { ToolDescriptor } from 'server/agent/toolRuntime.js';
import { WORKSPACE_HAND_TOOLS } from 'server/agent/toolRuntime.js';
import type { ToolInvocationResponse, ToolInvocationStreamChunk } from 'server/runtime/handProtocol.js';
import { pickHandEnv } from 'server/runtime/handEnvAllowlist.js';
import { parseWorkloadDescriptor, type SandboxWorkloadDescriptor } from './sandboxLifecyclePolicy.js';

export const MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface WireWorkspaceRef {
  id?: string;
  userId?: string;
  username?: string;
  sessionId?: string;
  sandboxScopeId?: string;
  mountSubPath?: string;
  sharedReadOnlySubPath?: string;
  sandboxResources?: Pick<SandboxResourceSpec, 'cpu' | 'memoryMb'>;
  executionTarget?: string;
  workload?: SandboxWorkloadDescriptor;
}

export interface WireToolInvocationRequest {
  toolName: string;
  input: unknown;
  context: {
    invocationId?: string;
    handId?: string;
    correlation?: CorrelationContext;
    workspace: WireWorkspaceRef;
    /**
     * 显式透传给远端 pod 的运行态 env。仅允许标准大写 env 名，并拒绝会改变
     * 进程加载、模块解析或代理行为的保留变量。上游生成后，本 protocol 层
     * parseWireRequest 再走 pickHandEnv 二次剥离。
     */
    env?: Record<string, string>;
  };
}

export interface RuntimeIsolationRequirement {
  tenantId: string;
  taskId: string;
  runId: string;
  sessionId: string;
  workspaceId: string;
  policyDigest: string;
}

export interface WorkspaceRecipe {
  workspaceId: string;
  /** Trusted server-to-ACS admission binding; never copied into runner input/env. */
  runtimeIsolationRequirement?: RuntimeIsolationRequirement;
  sessionId?: string;
  sandboxScopeId?: string;
  mountSubPath?: string;
  sharedReadOnlySubPath?: string;
  repo?: { url: string; ref?: string; remote?: string };
  files?: Array<{ artifactId: string; path: string; url?: string; signedUrl?: string }>;
  setupCommands?: string[];
  /**
   * `cpu` / `memoryMb` 在 server 侧 WorkspaceRecipe 里早已存在但从未被 orchestrator
   * 消费；2026-08-10 起接到真实 pod 规格上，用于 per-tenant/workspace 规格可配。
   * 它们参与 provision 指纹，改规格会触发 pod 重建。
   */
  resources?: { timeoutMs?: number; cpu?: string; memoryMb?: number };
  workload?: SandboxWorkloadDescriptor;
}

export type SandboxResourceSpec = NonNullable<WorkspaceRecipe['resources']>;

export interface WarmupRequest {
  workspaceId: string;
  sessionId: string;
  sandboxScopeId?: string;
  mountSubPath?: string;
  resources?: Pick<SandboxResourceSpec, 'cpu' | 'memoryMb'>;
  workload?: SandboxWorkloadDescriptor;
}

/** /warmup 资源覆盖必须 fail-closed；不能像兼容性的 provision recipe 一样静默忽略非法值。 */
export function parseWarmupResources(value: unknown):
  | { ok: true; value?: Pick<SandboxResourceSpec, 'cpu' | 'memoryMb'> }
  | { ok: false; error: string } {
  if (value === undefined) return { ok: true };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'resources 必须是对象' };
  }
  const raw = value as Record<string, unknown>;
  const unknownKeys = Object.keys(raw).filter((key) => key !== 'cpu' && key !== 'memoryMb');
  if (unknownKeys.length) return { ok: false, error: `resources 包含未知字段: ${unknownKeys.join(', ')}` };
  if (raw.cpu === undefined && raw.memoryMb === undefined) {
    return { ok: false, error: 'resources 至少需要 cpu 或 memoryMb' };
  }
  const parsed: Pick<SandboxResourceSpec, 'cpu' | 'memoryMb'> = {};
  if (raw.cpu !== undefined) {
    if (typeof raw.cpu !== 'string' || !/^\d+(?:\.\d+)?m?$/.test(raw.cpu.trim())) {
      return { ok: false, error: 'resources.cpu 必须是正数 CPU quantity' };
    }
    const cpu = raw.cpu.trim();
    const numeric = Number(cpu.endsWith('m') ? cpu.slice(0, -1) : cpu);
    if (!(numeric > 0)) return { ok: false, error: 'resources.cpu 必须大于 0' };
    parsed.cpu = cpu;
  }
  if (raw.memoryMb !== undefined) {
    if (!Number.isSafeInteger(raw.memoryMb) || (raw.memoryMb as number) <= 0) {
      return { ok: false, error: 'resources.memoryMb 必须是正整数' };
    }
    parsed.memoryMb = raw.memoryMb as number;
  }
  return { ok: true, value: parsed };
}

export function parseWarmupRequest(value: unknown):
  | { ok: true; value: WarmupRequest }
  | { ok: false; error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'body 必须是对象' };
  }
  const raw = value as Record<string, unknown>;
  const workspaceId = typeof raw.workspaceId === 'string' ? raw.workspaceId.trim() : '';
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId.trim() : '';
  if (!workspaceId || !sessionId) {
    return { ok: false, error: 'workspaceId and sessionId are required' };
  }
  const sandboxScope = parseSandboxScopeId(
    typeof raw.sandboxScopeId === 'string' && raw.sandboxScopeId.trim()
      ? raw.sandboxScopeId.trim()
      : undefined,
  );
  if (sandboxScope.error) return { ok: false, error: sandboxScope.error };
  const mountSubPath = parseMountSubPath(raw.mountSubPath);
  if (mountSubPath.error) return { ok: false, error: mountSubPath.error };
  const resources = parseWarmupResources(raw.resources);
  if (!resources.ok) return resources;
  const workload = raw.workload === undefined ? undefined : parseWorkloadDescriptor(raw.workload);
  if (workload && !workload.ok) return workload;
  return {
    ok: true,
    value: {
      workspaceId,
      sessionId,
      ...(sandboxScope.value ? { sandboxScopeId: sandboxScope.value } : {}),
      ...(mountSubPath.value ? { mountSubPath: mountSubPath.value } : {}),
      ...(resources.value ? { resources: resources.value } : {}),
      ...(workload?.ok ? { workload: workload.value } : {}),
    },
  };
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
  correlation?: CorrelationContext;
  workspace: {
    id?: string;
    userId?: string;
    username?: string;
    sessionId?: string;
    root: string;
    /** Orchestrator-verified mount fact; runner resolves the fixed pod-local root. */
    sharedReadOnlyMounted?: boolean;
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
  const sharedReadOnlySubPath = parseMountSubPath(workspace.sharedReadOnlySubPath);
  if (sharedReadOnlySubPath.error) return { ok: false, error: `sharedReadOnlySubPath: ${sharedReadOnlySubPath.error}` };
  const sandboxScopeId = typeof workspace.sandboxScopeId === 'string' && workspace.sandboxScopeId.trim()
    ? workspace.sandboxScopeId.trim()
    : undefined;
  const sandboxScope = parseSandboxScopeId(sandboxScopeId);
  if (sandboxScope.error) return { ok: false, error: sandboxScope.error };
  const sandboxResources = parseWarmupResources(workspace.sandboxResources);
  if (!sandboxResources.ok) {
    return { ok: false, error: `context.workspace.sandboxResources 无效: ${sandboxResources.error}` };
  }
  const workload = workspace.workload === undefined ? undefined : parseWorkloadDescriptor(workspace.workload);
  if (workload && !workload.ok) return { ok: false, error: `context.workspace.${workload.error}` };
  // wire env 双重防线：上游 HttpTransport 已过滤，服务端反序列化仍需再走
  // pickHandEnv，剥离危险或非法 key。空对象则不写字段。
  const rawEnv = context?.env;
  const env = rawEnv && typeof rawEnv === 'object' && !Array.isArray(rawEnv)
    ? pickHandEnv(rawEnv as Record<string, string | undefined>)
    : {};
  const envKeys = Object.keys(env);
  const invocationId = context?.invocationId;
  const handId = context?.handId;
  if (invocationId !== undefined && typeof invocationId !== 'string') {
    return { ok: false, error: 'context.invocationId 格式非法' };
  }
  if (handId !== undefined && typeof handId !== 'string') {
    return { ok: false, error: 'context.handId 格式非法' };
  }
  const correlation = parseCorrelationContext(context?.correlation, { invocationId, handId });
  if (!correlation.ok) return correlation;
  const effectiveInvocationId = correlation.value?.invocationId ?? invocationId;
  const effectiveHandId = correlation.value?.handId ?? handId;

  return {
    ok: true,
    value: {
      toolName: b.toolName,
      input: b.input,
      context: {
        ...(effectiveInvocationId ? { invocationId: effectiveInvocationId } : {}),
        ...(effectiveHandId ? { handId: effectiveHandId } : {}),
        ...(correlation.value ? { correlation: correlation.value } : {}),
        workspace: {
          id,
          sessionId,
          ...(sandboxScope.value ? { sandboxScopeId: sandboxScope.value } : {}),
          ...(mountSubPath.value ? { mountSubPath: mountSubPath.value } : {}),
          ...(sharedReadOnlySubPath.value ? { sharedReadOnlySubPath: sharedReadOnlySubPath.value } : {}),
          ...(sandboxResources.value ? { sandboxResources: sandboxResources.value } : {}),
          ...(workload?.ok ? { workload: workload.value } : {}),
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
  const workloadRaw = recipeRaw.workload ?? obj.workload;
  if (workloadRaw !== undefined) {
    const workload = parseWorkloadDescriptor(workloadRaw);
    if (!workload.ok) return workload;
    recipe.workload = workload.value;
  }
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
  const sharedReadOnlySubPath = parseMountSubPath(
    recipeRaw.sharedReadOnlySubPath ?? obj.sharedReadOnlySubPath,
  );
  if (sharedReadOnlySubPath.error)
    return { ok: false, error: `sharedReadOnlySubPath: ${sharedReadOnlySubPath.error}` };
  if (sharedReadOnlySubPath.value) recipe.sharedReadOnlySubPath = sharedReadOnlySubPath.value;
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
  const isolationRaw = recipeRaw.runtimeIsolationRequirement;
  if (isolationRaw !== undefined) {
    if (!isolationRaw || typeof isolationRaw !== 'object' || Array.isArray(isolationRaw)) {
      return { ok: false, error: 'runtimeIsolationRequirement 必须是对象' };
    }
    const raw = isolationRaw as Record<string, unknown>;
    const fields = ['tenantId', 'taskId', 'runId', 'sessionId', 'workspaceId', 'policyDigest'] as const;
    if (fields.some((field) => typeof raw[field] !== 'string' || !(raw[field] as string).trim())) {
      return { ok: false, error: 'runtimeIsolationRequirement 绑定字段必须为非空字符串' };
    }
    if (raw.workspaceId !== workspaceId || raw.sessionId !== sessionId
      || !/^[a-f0-9]{64}$/.test(raw.policyDigest as string)) {
      return { ok: false, error: 'runtimeIsolationRequirement recipe 绑定不匹配或 policyDigest 非法' };
    }
    recipe.runtimeIsolationRequirement = Object.fromEntries(
      fields.map((field) => [field, (raw[field] as string).trim()]),
    ) as unknown as NonNullable<WorkspaceRecipe['runtimeIsolationRequirement']>;
  }
  const resources = recipeRaw.resources;
  if (resources && typeof resources === 'object') {
    const raw = resources as { timeoutMs?: unknown; cpu?: unknown; memoryMb?: unknown };
    const parsed: NonNullable<WorkspaceRecipe['resources']> = {};
    if (typeof raw.timeoutMs === 'number') parsed.timeoutMs = raw.timeoutMs;
    // 规格字段做严格校验：非法值一律忽略而不是报错，避免一个手滑的配置把
    // 整个租户的会话卡在 provision 失败上——回落全局默认始终是可用的。
    if (typeof raw.cpu === 'string' && /^\d+(\.\d+)?m?$/.test(raw.cpu.trim())) parsed.cpu = raw.cpu.trim();
    if (typeof raw.memoryMb === 'number' && Number.isFinite(raw.memoryMb) && raw.memoryMb > 0) {
      parsed.memoryMb = Math.floor(raw.memoryMb);
    }
    if (Object.keys(parsed).length) recipe.resources = parsed;
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

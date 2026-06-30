/**
 * Runtime-level execution config
 *
 * 提供统一的 ExecutionTarget 解析入口，避免 executionTarget 策略散落在 WebChannel、
 * rawRuntimeRunDispatch、未来的 cron / DingTalk / API 等通道内联实现。
 *
 * 当前阶段（2026-06-26）：
 * - SaaS tenant identity 已接入。默认 target 采用 authenticated/anonymous 分层：
 *   所有已认证用户（含 platform admin）默认走 tenantDefaultTarget（当前为
 *   server-container）；匿名/内部调用默认走 defaultTarget（当前为 server-local）。
 * - 接受 'server-local' / 'server-container' / 'server-remote' 三种 target；
 *   server-remote 需要在 app 配置中提供 hand-server baseUrl + token，未配置时
 *   transport registry 不注册该 target，PlatformToolRuntime 调用会 throw；
 *   'client' 暂未注册执行后端，也未在任何通道开放，统一在此处 reject。
 * - 默认行为按身份分层；platform admin 可显式 override，非平台用户默认不能显式指定。
 */
import type { ExecutionTargetKind } from '../agent/toolRuntime.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';

/** 通道可接受的 execution target 白名单（与 ExecutionTransport registry 默认实现保持一致） */
export const SUPPORTED_EXECUTION_TARGETS: readonly ExecutionTargetKind[] = ['server-local', 'server-container', 'server-remote'];

export type ExecutionTargetSource = 'config_default' | 'admin_override';

export interface ExecutionConfig {
  /** 匿名/内部调用未显式 override 时的默认 target */
  defaultTarget: ExecutionTargetKind;
  /** 已认证用户未显式 override 时的默认 target（含 platform admin）。 */
  tenantDefaultTarget: ExecutionTargetKind;
  /** admin 是否可在 chat/run 时显式指定 target，默认 true */
  allowAdminOverride: boolean;
  /** 普通用户是否可显式指定 target，默认 false；当前阶段保持 false */
  allowUserOverride: boolean;
  /** SaaS tenant policy placeholder；当前不消费，仅保留接口形态 */
  futureTenantPolicy?: unknown;
}

export interface ExecutionConfigInput {
  defaultTarget?: ExecutionTargetKind;
  tenantDefaultTarget?: ExecutionTargetKind;
  allowAdminOverride?: boolean;
  allowUserOverride?: boolean;
  futureTenantPolicy?: unknown;
}

export interface ResolveExecutionTargetInput {
  /** 调用方（WebChannel/API/script）请求的 target；可能来自用户输入，必须当作不可信值处理 */
  requested?: ExecutionTargetKind | string | null;
  user?: { role?: string; tenantId?: string } | null;
  sessionId?: string;
  config: ExecutionConfig;
}

export type ExecutionTargetDecision =
  | {
      ok: true;
      target: ExecutionTargetKind;
      source: ExecutionTargetSource;
    }
  | {
      ok: false;
      reason: string;
      /** 便于通道映射拒绝码，例如 WebChannel 的 'access_denied' */
      kind: 'unknown_target' | 'override_not_allowed';
    };

export const DEFAULT_EXECUTION_CONFIG: ExecutionConfig = Object.freeze({
  defaultTarget: 'server-local',
  tenantDefaultTarget: 'server-container',
  allowAdminOverride: true,
  allowUserOverride: false,
});

export function createExecutionConfig(input: ExecutionConfigInput = {}): ExecutionConfig {
  return {
    defaultTarget: input.defaultTarget ?? DEFAULT_EXECUTION_CONFIG.defaultTarget,
    tenantDefaultTarget: input.tenantDefaultTarget ?? DEFAULT_EXECUTION_CONFIG.tenantDefaultTarget,
    allowAdminOverride: input.allowAdminOverride ?? DEFAULT_EXECUTION_CONFIG.allowAdminOverride,
    allowUserOverride: input.allowUserOverride ?? DEFAULT_EXECUTION_CONFIG.allowUserOverride,
    futureTenantPolicy: input.futureTenantPolicy,
  };
}

function isSupportedTarget(value: unknown): value is ExecutionTargetKind {
  return typeof value === 'string'
    && (SUPPORTED_EXECUTION_TARGETS as readonly string[]).includes(value);
}

/**
 * 统一解析 execution target，供 WebChannel / rawRuntimeRunDispatch / 未来通道共用。
 *
 * 决策顺序：
 * 1. 若 requested 缺省或为空字符串：
 *    - 已认证用户（含 platform admin / 组织 admin / 普通 user）→ tenantDefaultTarget（通常 server-container）；
 *    - 匿名内部调用 → defaultTarget（通常 server-local）。
 * 2. 若 requested 不在 SUPPORTED_EXECUTION_TARGETS → reject(kind=unknown_target)。
 *    这里显式拒绝 'client'，避免通道误开放未注册后端。
 * 3. 若 requested 等于 defaultTarget：
 *    - 视为"显式 override 同一目标"，仍需 override 权限校验（与现有 WebChannel 行为保持一致：
 *      非 admin 显式传任何 executionTarget 都拒绝）。
 * 4. platform admin 且 allowAdminOverride → 通过，source=admin_override。
 * 5. 非平台用户且 allowUserOverride → 通过，source=admin_override（沿用同一标签）。
 *    当前阶段 allowUserOverride 默认 false。
 * 6. 其余 → reject(kind=override_not_allowed)。
 *
 * 该函数是纯函数（无副作用），方便在通道、脚本、单测中复用。
 */
export function resolveExecutionTarget(input: ResolveExecutionTargetInput): ExecutionTargetDecision {
  const { requested, user, config } = input;
  const isPlatformAdmin = user?.role === 'admin' && user.tenantId === DEFAULT_TENANT_ID;
  const hasAuthenticatedUser = !!user?.role;

  if (requested === undefined || requested === null || requested === '') {
    return {
      ok: true,
      target: hasAuthenticatedUser ? config.tenantDefaultTarget : config.defaultTarget,
      source: 'config_default',
    };
  }

  if (!isSupportedTarget(requested)) {
    return {
      ok: false,
      kind: 'unknown_target',
      reason: `未知 executionTarget: ${String(requested)}`,
    };
  }

  if (isPlatformAdmin && config.allowAdminOverride) {
    return { ok: true, target: requested, source: 'admin_override' };
  }
  if (!isPlatformAdmin && config.allowUserOverride) {
    return { ok: true, target: requested, source: 'admin_override' };
  }

  return {
    ok: false,
    kind: 'override_not_allowed',
    reason: '无权选择 executionTarget',
  };
}

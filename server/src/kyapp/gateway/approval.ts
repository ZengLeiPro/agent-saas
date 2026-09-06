/**
 * WP3：审批映射与 §6.2-2 的二次确认卡片（规范 §6.2-2、§6.2-3、§6.6）。
 *
 * 三件事：
 * 1. **确认卡片**：系统名、参数摘要、「确认后立即生效、不可撤销」、键入确认字、
 *    10 分钟倒计时。卡片在 channel 侧由工具名查登记表拼出 —— `InteractionEvent`
 *    只带工具名与入参，拿不到 manifest。
 * 2. **10 分钟专用超时**：**不动全局 `interactionStore.ts` 的 30 分钟**，
 *    只对 `app__` 的 `external_write` 交互传 per-interaction TTL。
 *    超时文案「操作已取消，未写入任何数据」（§6.6）。
 * 3. **审批绑定**：`{tid, iid, sub, sid, cap, lcid, aph, expiresAt}`，
 *    消费单位 = 逻辑调用，终态或过期即终结；参数变更 = 新 lcid = 重新确认
 *    （`aph = sha256(JCS({cap, input}))` 变了就必然是另一次审批）。
 */
import { aph as computeAph } from '@kaiyan/ky-app-contract';

import type { WsToolConfirmationCard } from '@agent/shared';

import { customerMessageFor } from './errors.js';
import { getAppCapabilityGateway } from './runtimeBinding.js';
import { lookupAppCapabilityTool, type AppCapabilityToolMeta } from './toolRiskRegistry.js';

/** 键入确认字（§6.2-2）。两个字、无歧义、不与「取消」形近。 */
export const APP_CONFIRM_WORD = '确认';

/** §6.2-2 的 10 分钟。Gateway 未装配时的兜底值（正常走 `kyApp.gateway.approvalTtlMs`）。 */
export const APP_APPROVAL_DEFAULT_TTL_MS = 10 * 60 * 1000;

/** 当前生效的审批 TTL。装配层把它挂在 Gateway 绑定上，channel 侧不依赖 kyApp 配置。 */
export function resolveAppApprovalTtlMs(): number {
  return getAppCapabilityGateway()?.approvalTtlMs ?? APP_APPROVAL_DEFAULT_TTL_MS;
}

/** 参数摘要最多几行。多了卡片会长到需要滚动，反而看不清关键项。 */
const MAX_SUMMARY_ROWS = 6;

const MAX_SUMMARY_VALUE_LENGTH = 60;

function summarizeValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.length > MAX_SUMMARY_VALUE_LENGTH
      ? `${trimmed.slice(0, MAX_SUMMARY_VALUE_LENGTH)}…`
      : trimmed;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `共 ${value.length} 项`;
  return null;
}

/** 参数摘要：标量优先、数组给条数、对象跳过。顺序 = 入参键的原始顺序。 */
export function summarizeApprovalParams(
  input: Record<string, unknown> | undefined,
): Array<{ label: string; value: string }> {
  if (!input) return [];
  const rows: Array<{ label: string; value: string }> = [];
  for (const [key, raw] of Object.entries(input)) {
    if (rows.length >= MAX_SUMMARY_ROWS) break;
    const value = summarizeValue(raw);
    if (value === null) continue;
    rows.push({ label: key, value });
  }
  return rows;
}

export interface BuildConfirmationCardInput {
  /** 平台审批 id（= `interactionId` = `ApprovalRecord.id`）；给出即登记审批绑定。 */
  interactionId?: string;
  sessionId?: string;
  toolName?: string;
  toolId?: string;
  toolInput?: Record<string, unknown>;
  /** `kyApp.gateway.approvalTtlMs`；缺省时按 Gateway 绑定解析，再兜底 10 分钟。 */
  approvalTtlMs?: number;
  now?: () => number;
}

/**
 * 只为 `app__` 的 **`external_write`** 生成卡片。
 * 其它工具返回 `undefined` —— 卡片是外部系统写操作专用的，
 * 给 Shell/Write 套上「不可撤销」会稀释这句话的分量。
 *
 * 风险档未登记时按 `external_write` 处理（与 `toolRiskRegistry` 同一 fail-closed 约定），
 * 此时系统名退化为工具名里的 id 段。
 */
export function buildAppConfirmationCard(
  input: BuildConfirmationCardInput,
): WsToolConfirmationCard | undefined {
  const name = input.toolName ?? input.toolId;
  if (!name || !name.startsWith('app__')) return undefined;
  const meta: AppCapabilityToolMeta | undefined =
    lookupAppCapabilityTool(input.toolName) ?? lookupAppCapabilityTool(input.toolId);
  if (meta && meta.risk !== 'external_write') return undefined;

  const segments = name.slice('app__'.length).split('__');
  const now = (input.now ?? Date.now)();
  const ttlMs = input.approvalTtlMs ?? resolveAppApprovalTtlMs();
  // 顺手登记审批绑定：`aph` 与过期时刻在这里就定死，执行时只能消费不能重算。
  // 租户/用户此刻拿不到（`InteractionEvent` 不带），留空，消费时跳过这两项比对。
  const registry = getAppCapabilityGateway()?.approvals;
  if (registry && input.interactionId && meta && input.sessionId) {
    registry.remember({
      approvalId: input.interactionId,
      installationId: meta.installationId,
      sessionId: input.sessionId,
      capabilityId: meta.capabilityId,
      aph: approvalParamsHash(meta.capabilityId, input.toolInput ?? {}),
      expiresAt: now + ttlMs,
    });
  }
  return {
    systemName: meta?.systemName ?? segments[0] ?? name,
    capabilityName: meta?.capabilityName ?? segments.slice(1).join('__') ?? name,
    params: summarizeApprovalParams(input.toolInput),
    irreversible: true,
    confirmWord: APP_CONFIRM_WORD,
    expiresAtMs: now + ttlMs,
    timeoutNotice: customerMessageFor('approval_timeout'),
  };
}

/** §6.2-3 的审批绑定。消费单位 = 逻辑调用。 */
export interface AppApprovalBinding {
  approvalId: string;
  /** 建卡片时 channel 侧拿不到租户/用户（`InteractionEvent` 不带），因此可选；缺省即不比对该项。 */
  tenantId?: string;
  installationId: string;
  userId?: string;
  sessionId: string;
  capabilityId: string;
  /** `sha256(JCS({cap, input}))`。参数一变它就变 → 必然是另一次审批。 */
  aph: string;
  expiresAt: number;
}

export type ApprovalConsumeResult =
  | { ok: true; binding: AppApprovalBinding }
  /** 本进程没有记录（跨进程恢复）。平台层审批已经发生过，放行但记日志。 */
  | { ok: true; binding: null }
  | { ok: false; reason: 'expired' | 'mismatch' | 'consumed' };

/**
 * 审批绑定的进程内登记表。
 *
 * **为什么允许「没有记录也放行」**：10 分钟超时的权威执行者是
 * `interactionStore` 的 per-interaction 定时器（到期即 take + 拒绝，工具根本不会执行）。
 * 本表是审批恢复路径上的第二道校验；跨进程恢复时本进程没有记录，
 * 此时再拒会把「已经人工确认过的写操作」误杀，比放行更糟。
 */
export class AppApprovalRegistry {
  private readonly bindings = new Map<string, AppApprovalBinding>();

  private readonly consumed = new Set<string>();

  constructor(private readonly options: { now?: () => number; maxEntries?: number } = {}) {}

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** 在弹出确认卡片时登记。`approvalId` = `interactionId` = `ApprovalRecord.id`。 */
  remember(binding: AppApprovalBinding): void {
    const maxEntries = this.options.maxEntries ?? 4_096;
    if (this.bindings.size >= maxEntries) {
      const oldest = this.bindings.keys().next();
      if (!oldest.done) this.bindings.delete(oldest.value);
    }
    this.bindings.set(binding.approvalId, binding);
  }

  /**
   * 消费一次审批。**同一个 approvalId 只能消费一次**（消费单位 = 逻辑调用），
   * 重复消费 = 同一次确认被用于第二次写入，一律拒绝。
   */
  consume(input: {
    approvalId: string;
    tenantId: string;
    installationId: string;
    userId: string;
    sessionId: string;
    capabilityId: string;
    aph: string;
  }): ApprovalConsumeResult {
    if (this.consumed.has(input.approvalId)) return { ok: false, reason: 'consumed' };
    const binding = this.bindings.get(input.approvalId);
    if (!binding) {
      this.consumed.add(input.approvalId);
      return { ok: true, binding: null };
    }
    if (binding.expiresAt <= this.now) {
      this.bindings.delete(input.approvalId);
      return { ok: false, reason: 'expired' };
    }
    const same =
      (binding.tenantId === undefined || binding.tenantId === input.tenantId) &&
      binding.installationId === input.installationId &&
      (binding.userId === undefined || binding.userId === input.userId) &&
      binding.sessionId === input.sessionId &&
      binding.capabilityId === input.capabilityId &&
      binding.aph === input.aph;
    if (!same) return { ok: false, reason: 'mismatch' };
    this.bindings.delete(input.approvalId);
    this.consumed.add(input.approvalId);
    return { ok: true, binding };
  }

  /** 只读视图，供测试与诊断。 */
  peek(approvalId: string): AppApprovalBinding | undefined {
    return this.bindings.get(approvalId);
  }
}

/** `aph = lowercase hex(sha256(utf8(JCS({cap, input}))))`（附录 I）。走契约包，不自己算。 */
export function approvalParamsHash(capabilityId: string, input: unknown): string {
  return computeAph({ cap: capabilityId, input });
}

/**
 * §4.3 / §4.4 能力调用与执行查询。
 *
 * 流水线：能力存在与开关 → `X-KY-Idempotency-Key` 必带且 = `lcid` → `inputSchema` 校验
 * → `approval:required` 的 `apr`+`aph` 恒定时间比对 → 占用 `jti`（鉴权与输入校验之后、
 * 执行之前）→ 执行记录状态机 → 超时 ≤ 15,000 ms → `outputSchema` 校验
 * → 响应体 UTF-8 ≤ 6,000 字节。
 *
 * `dig` 的比对在 `verifySat()` 里完成（只在 `/ky/v1/capabilities/*` 上做）；
 * 这里再兜一层，供不走 Hono 适配器的调用方使用。
 */
import {
  CAPABILITY_RESPONSE_MAX_BYTES,
  CAPABILITY_TIMEOUT_MAX_MS,
  aph as computeAph,
  canonicalize,
  sha256Hex,
  timingSafeEqualHex,
  type CapabilitySuccessResponse,
  type ExecutionQueryResponse,
  type Manifest,
  type ManifestCapability,
} from '@kaiyan/ky-app-contract';

import { KyAppError } from '../errors.js';
import type { VerifiedIdentity } from '../sat/verify.js';
import { validateAgainstCapabilitySchema } from './schemaValidator.js';
import {
  EXECUTION_RETENTION_MS,
  type ExecutionRecord,
  type ExecutionStore,
} from './executionStore.js';

/** §9.2：能力 handler 与页面 API 共用 service 层，首参只由验签中间件构造。 */
export interface CapabilityContext {
  tenantId: string;
  installationId: string;
  userId: string;
  roles: string[];
  isTenantAdmin: boolean;
  /** 数据范围（部门归属等），随目录更新。 */
  dataScope: { groupIds: string[] } & Record<string, unknown>;
}

export type CapabilityHandler = (
  ctx: CapabilityContext,
  input: Record<string, unknown>,
) => Promise<unknown>;

export interface DefineCapabilitiesOptions {
  manifest: Manifest;
  handlers: Record<string, CapabilityHandler>;
  executionStore: ExecutionStore;
  /** 由验签中间件构造 `ctx`；handler 永远拿不到原始 claims。 */
  createContext: (identity: VerifiedIdentity) => Promise<CapabilityContext>;
  /** 能力开关（平台侧安装实例页可关，§8.6）。默认全开。 */
  isEnabled?: (capabilityId: string) => boolean;
  /** 当前 manifest digest，用于兜底比对。 */
  manifestDigest?: string;
  now?: () => number;
}

export interface InvokeInput {
  capabilityId: string;
  identity: VerifiedIdentity;
  /** `X-KY-Idempotency-Key` 原值（缺失传 null）。 */
  idempotencyKey: string | null;
  /** 请求体，必须是 `{ input: {...} }`。 */
  body: unknown;
}

export interface CapabilityRuntime {
  /** manifest 里声明的能力 id。 */
  ids(): string[];
  /** `/me.capabilities`。 */
  listForMe(): Array<{ id: string; enabled: boolean }>;
  invoke(input: InvokeInput): Promise<CapabilitySuccessResponse>;
  queryExecution(input: {
    capabilityId: string;
    identity: VerifiedIdentity;
    lcid: string;
  }): Promise<ExecutionQueryResponse>;
  /** 定期把超过保留期的终态记录标记 `expired`。 */
  expireOverdue(): Promise<number>;
}

function requireIdentityField(value: string | undefined, name: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new KyAppError('forbidden', { message: `SAT 缺少 ${name}` });
  }
  return value;
}

/** 带超时的执行；超时按 §6.5 归到 `upstream_unavailable`（503）。 */
async function runWithTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new KyAppError('upstream_unavailable', { message: `能力执行超过 ${timeoutMs} ms` }),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function defineCapabilities(options: DefineCapabilitiesOptions): CapabilityRuntime {
  const now = options.now ?? Date.now;
  const byId = new Map<string, ManifestCapability>(
    options.manifest.capabilities.map((capability) => [capability.id, capability]),
  );
  const isEnabled = options.isEnabled ?? (() => true);

  function requireCapability(capabilityId: string): ManifestCapability {
    const capability = byId.get(capabilityId);
    if (capability === undefined) {
      throw new KyAppError('not_found', { message: `未知能力 ${capabilityId}` });
    }
    if (!isEnabled(capabilityId)) {
      throw new KyAppError('forbidden', { message: `能力 ${capabilityId} 已关闭` });
    }
    return capability;
  }

  function checkDigest(identity: VerifiedIdentity): void {
    if (options.manifestDigest === undefined || identity.dig === undefined) return;
    if (!timingSafeEqualHex(identity.dig, options.manifestDigest)) {
      throw new KyAppError('digest_mismatch', { message: 'SAT dig 与当前 manifest digest 不符' });
    }
  }

  function readInput(body: unknown, capability: ManifestCapability): Record<string, unknown> {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new KyAppError('invalid_input', { message: '请求体必须是对象' });
    }
    const input = (body as { input?: unknown }).input;
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new KyAppError('invalid_input', { message: '请求体必须含对象字段 input' });
    }
    const check = validateAgainstCapabilitySchema(capability.inputSchema, input, 'input');
    if (!check.ok) {
      throw new KyAppError('invalid_input', { message: check.errors.join('；') });
    }
    return input as Record<string, unknown>;
  }

  /** §4.3 确认绑定：`approval:required` 必须 `apr`+`aph` 成对且 `aph == sha256(JCS({cap,input}))`。 */
  function checkApproval(
    capability: ManifestCapability,
    identity: VerifiedIdentity,
    input: Record<string, unknown>,
  ): void {
    if (capability.approval !== 'required') return;
    if (identity.apr === undefined || identity.aph === undefined) {
      throw new KyAppError('approval_required', { message: '该能力必须携带成对的 apr 与 aph' });
    }
    const expected = computeAph({ cap: capability.id, input });
    if (!timingSafeEqualHex(identity.aph, expected)) {
      throw new KyAppError('approval_required', { message: 'aph 与 {cap,input} 不符' });
    }
  }

  function checkResponseSize(data: unknown): CapabilitySuccessResponse {
    const response: CapabilitySuccessResponse = { ok: true, data: data as Record<string, unknown> };
    const bytes = Buffer.byteLength(JSON.stringify(response), 'utf8');
    if (bytes > CAPABILITY_RESPONSE_MAX_BYTES) {
      throw new KyAppError('response_too_large', {
        message: `响应体 ${bytes} 字节，超过 ${CAPABILITY_RESPONSE_MAX_BYTES}`,
      });
    }
    return response;
  }

  /** 命中既有执行记录时的返回策略（§4.3）。 */
  function replay(existing: ExecutionRecord, inputHash: string): CapabilitySuccessResponse {
    if (existing.inputHash !== inputHash) {
      throw new KyAppError('idempotency_mismatch', { message: '同一 lcid 收到了不同的输入' });
    }
    switch (existing.status) {
      case 'in_progress':
        throw new KyAppError('in_progress', { message: '该 lcid 正在执行' });
      case 'done':
        return { ok: true, data: existing.result as Record<string, unknown> };
      case 'failed':
        throw new KyAppError((existing.error?.code ?? 'internal') as 'internal', {
          message: existing.error?.message ?? '原失败结果，不重新执行',
        });
      default:
        // 终态记录已超过 7 天保留期：写操作不能凭空重放，读操作也无法给出原结果。
        // 契约没有为「过期后再次调用」定义专门错误码，这里按 409 收敛并在 message 说明。
        throw new KyAppError('idempotency_mismatch', {
          message: '该 lcid 的执行记录已过保留期，请用新的 lcid 重新发起',
        });
    }
  }

  return {
    ids: () => [...byId.keys()],

    listForMe: () => [...byId.keys()].map((id) => ({ id, enabled: isEnabled(id) })),

    async invoke({
      capabilityId,
      identity,
      idempotencyKey,
      body,
    }): Promise<CapabilitySuccessResponse> {
      const capability = requireCapability(capabilityId);
      checkDigest(identity);

      const lcid = requireIdentityField(identity.lcid, 'lcid');
      const sub = requireIdentityField(identity.sub, 'sub');
      if (idempotencyKey === null || idempotencyKey !== lcid) {
        throw new KyAppError('invalid_input', {
          message: 'X-KY-Idempotency-Key 必须存在且等于 SAT 的 lcid',
        });
      }

      const input = readInput(body, capability);
      checkApproval(capability, identity, input);
      // §3.1-6：占用在鉴权与输入校验之后、执行之前。
      await identity.consumeJti();

      const inputHash = sha256Hex(canonicalize(input));
      const at = now();
      const key = { installationId: identity.claims.iid, capabilityId, sub, lcid };
      const begun = await options.executionStore.begin({
        ...key,
        inputHash,
        status: 'in_progress',
        createdAt: at,
        updatedAt: at,
        expiresAt: at + EXECUTION_RETENTION_MS,
      });
      if (!begun.created) return replay(begun.record, inputHash);

      const handler = options.handlers[capabilityId];
      if (handler === undefined) {
        await options.executionStore.finish(key, {
          status: 'failed',
          error: { code: 'internal', message: `能力 ${capabilityId} 没有注册 handler` },
          at: now(),
        });
        throw new KyAppError('internal', { message: `能力 ${capabilityId} 没有注册 handler` });
      }

      const timeoutMs = Math.min(
        capability.timeoutMs ?? CAPABILITY_TIMEOUT_MAX_MS,
        CAPABILITY_TIMEOUT_MAX_MS,
      );
      try {
        const ctx = await options.createContext(identity);
        const data = await runWithTimeout(handler(ctx, input), timeoutMs);
        const output = validateAgainstCapabilitySchema(capability.outputSchema, data, 'data');
        if (!output.ok) {
          throw new KyAppError('internal', {
            message: `能力返回值不合 outputSchema：${output.errors.join('；')}`,
          });
        }
        const response = checkResponseSize(data);
        await options.executionStore.finish(key, { status: 'done', result: data, at: now() });
        return response;
      } catch (error) {
        const failure =
          error instanceof KyAppError
            ? error
            : new KyAppError('internal', {
                message: error instanceof Error ? error.message : String(error),
              });
        await options.executionStore.finish(key, {
          status: 'failed',
          error: { code: failure.code, message: failure.message },
          at: now(),
        });
        throw failure;
      }
    },

    async queryExecution({ capabilityId, identity, lcid }): Promise<ExecutionQueryResponse> {
      requireCapability(capabilityId);
      const sub = requireIdentityField(identity.sub, 'sub');
      const installationId = identity.claims.iid;
      const record = await options.executionStore.get({
        installationId,
        capabilityId,
        sub,
        lcid,
      });
      if (record === null) {
        // 同 (iid, cap, lcid) 但不属于当前 sub → 404（§4.4）。
        const other = await options.executionStore.findByLcid({
          installationId,
          capabilityId,
          lcid,
        });
        if (other !== null) {
          throw new KyAppError('not_found', { message: '执行记录不属于当前用户' });
        }
        return { status: 'not_started' };
      }
      if (record.status === 'done') {
        return { status: 'done', result: record.result };
      }
      if (record.status === 'failed') {
        return {
          status: 'failed',
          error: {
            code: record.error?.code ?? 'internal',
            ...(record.error?.message === undefined ? {} : { message: record.error.message }),
          },
        };
      }
      return { status: record.status };
    },

    expireOverdue: () => options.executionStore.expireOverdue(now()),
  };
}

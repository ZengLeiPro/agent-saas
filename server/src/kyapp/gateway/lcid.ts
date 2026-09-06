/**
 * WP3：逻辑调用状态机（规范 §6.2，重点是 §6.2-4 与 §6.2-5）。
 *
 * 一次模型工具调用 = 一个逻辑调用 `lcid`（Gateway 生成）。
 * 一个逻辑调用可能产生多个 HTTP attempt，**attempt 共享 `lcid/rid/dig/apr/aph`**，
 * 幂等键 = `lcid`（`X-KY-Idempotency-Key` 头必带且等于 SAT claim `lcid`）。
 * 参数变更 = 新 lcid = 重新确认（由调用方在拿到新 input 时重新走一遍本流程实现）。
 *
 * **重试的唯一依据是「HTTP 类别 × safeToRetry」，不看 `error.retryable`**：
 *
 * | | 无响应 / 超时 | 502/503/504 | 429 | 其它 4xx/5xx |
 * |---|---|---|---|---|
 * | `read_only`（safeToRetry:true） | 重试 ≤ 2 次（1 s / 3 s） | 同左 | 按 `Retry-After`（≤ 10 s）重试 1 次 | 不重试 |
 * | `external_write`（safeToRetry:false） | 查 `executions/{lcid}` | **不重试**，直接报错 | 不重试 | 不重试 |
 *
 * `external_write` 无响应时查询 `executions/{lcid}`（间隔 2 s 至 60 s 总截止）：
 * `not_started`/`in_progress` → 继续；`done` → 取结果；`failed` → 报失败；
 * `expired` 或截止仍非终态 → **`outcome_unknown`**。
 * **禁止把超时伪装成「未执行」**——写操作可能已经落库，只是回执丢了。
 *
 * 每个 attempt（**含每一次 executions 查询**）新签一枚 `act=agent` SAT（60 s 单次）。
 */
import { randomUUID } from 'node:crypto';

import { sha256Hex } from '@kaiyan/ky-app-contract';

import type { KyAppGatewayConfig } from '../config.js';
import { KyAppOutboundError, type KyAppOutbound, type KyAppOutboundResult } from '../outbound.js';
import { KyAppSatDeniedError, type KyAppSatIssuer } from '../sat/issuer.js';
import {
  exceedsResponseBudget,
  buildResultLink,
  utf8ByteLength,
  type AppInvocationOutcome,
} from './envelope.js';
import {
  fallbackCodeForStatus,
  parseAppErrorCode,
  parseAppErrorLogMessage,
  type GatewayFailureCode,
} from './errors.js';
import type { AppCapabilityEntry } from './snapshot.js';

/** §6.2-5：`read_only` 的两次重试退避。 */
export const READ_RETRY_BACKOFF_MS = [1_000, 3_000] as const;

/** §6.2-5：429 的 `Retry-After` 上限。超过就不重试了（等 10 s 已经超出用户耐心）。 */
export const MAX_RETRY_AFTER_MS = 10_000;

/** §6.2-5：`read_only` 视为「可安全重试」的 5xx。 */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

function capabilityPath(capabilityId: string): string {
  return `/ky/v1/capabilities/${encodeURIComponent(capabilityId)}`;
}

function executionsPath(capabilityId: string, lcid: string): string {
  return `${capabilityPath(capabilityId)}/executions/${encodeURIComponent(lcid)}`;
}

/** §4.4 的执行记录状态。 */
export type ExecutionStatus = 'not_started' | 'in_progress' | 'done' | 'failed' | 'expired';

const EXECUTION_STATUSES: ReadonlySet<string> = new Set<ExecutionStatus>([
  'not_started',
  'in_progress',
  'done',
  'failed',
  'expired',
]);

export interface LogicalCallApproval {
  /** SAT claim `apr`。 */
  approvalId: string;
  /** SAT claim `aph` = `sha256(JCS({cap, input}))`。与 `apr` 必须成对。 */
  aph: string;
}

export interface LogicalCallInput {
  entry: AppCapabilityEntry;
  tenantId: string;
  userId: string;
  /** SAT claim `sid`。 */
  sessionId: string;
  /** 是否本组织管理员（SAT claim `tadm`）。 */
  tenantAdmin: boolean;
  input: unknown;
  approval?: LogicalCallApproval;
  /** run 中止 / 会话关闭。 */
  signal?: AbortSignal;
}

export interface LogicalCallResult {
  lcid: string;
  /** 全部 attempt 共享的 `X-KY-Request-Id`（= SAT claim `rid`）。 */
  requestId: string;
  /** 含 executions 查询在内的 HTTP attempt 次数（审计用）。 */
  attempts: number;
  outcome: AppInvocationOutcome;
  /** 是否应记入熔断计数（5xx / 超时 / 无响应；4xx 不算）。 */
  countsTowardBreaker: boolean;
}

export interface LogicalCallDeps {
  issuer: Pick<KyAppSatIssuer, 'issue'>;
  outbound: KyAppOutbound;
  config: Pick<
    KyAppGatewayConfig,
    'logicalCallDeadlineMs' | 'executionPollIntervalMs' | 'maxResponseBytes'
  >;
  now?: () => number;
  /** 可注入以便测试不真等。默认 `setTimeout`。 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  newLcid?: () => string;
  newRequestId?: () => string;
  logger?: { warn(message: string): void };
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/** 出站异常的三类归一。`blocked` 是我们自己的 SSRF/白名单拒绝，不是对方的问题。 */
type AttemptFailure =
  | { kind: 'no_response'; code: GatewayFailureCode; log: string }
  | { kind: 'blocked'; code: GatewayFailureCode; log: string };

function classifyOutboundError(error: unknown): AttemptFailure {
  if (error instanceof KyAppOutboundError) {
    if (error.code === 'blocked') {
      return { kind: 'blocked', code: 'internal', log: error.message };
    }
    // timeout 与 upstream_unavailable 都算「没拿到确定回执」。
    return { kind: 'no_response', code: 'upstream_unavailable', log: error.message };
  }
  return {
    kind: 'no_response',
    code: 'upstream_unavailable',
    log: error instanceof Error ? error.message : String(error),
  };
}

function parseExecutionStatus(payload: unknown): ExecutionStatus | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const status = (payload as { status?: unknown }).status;
  return typeof status === 'string' && EXECUTION_STATUSES.has(status)
    ? (status as ExecutionStatus)
    : null;
}

export class AppLogicalCallRunner {
  private readonly now: () => number;

  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  private readonly newLcid: () => string;

  private readonly newRequestId: () => string;

  constructor(private readonly deps: LogicalCallDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? defaultSleep;
    this.newLcid = deps.newLcid ?? (() => randomUUID());
    this.newRequestId = deps.newRequestId ?? (() => randomUUID());
  }

  /**
   * 跑完一个逻辑调用。**只有一个出口**：无论成功、失败还是结果未知，
   * 都返回 `LogicalCallResult`，不抛异常（抛异常会让审计与限流的收尾逻辑漏掉）。
   *
   * `lcid` 由调用方给定时复用（审批恢复路径要保持同一个逻辑调用）；否则新生成。
   */
  async run(input: LogicalCallInput & { lcid?: string }): Promise<LogicalCallResult> {
    const lcid = input.lcid ?? this.newLcid();
    const requestId = this.newRequestId();
    const deadline = this.now() + this.deps.config.logicalCallDeadlineMs;
    const state = { attempts: 0, countsTowardBreaker: false };

    const finish = (outcome: AppInvocationOutcome): LogicalCallResult => ({
      lcid,
      requestId,
      attempts: state.attempts,
      outcome,
      countsTowardBreaker: state.countsTowardBreaker,
    });

    const safeToRetry = input.entry.riskLevel === 'read_only';
    let readRetries = 0;
    let usedRetryAfter = false;

    for (;;) {
      if (input.signal?.aborted) {
        return finish({ kind: 'failure', code: 'outcome_unknown', logMessage: 'run 已中止' });
      }
      if (this.now() >= deadline) {
        // 读能力超总截止：没拿到结果，但读操作没有副作用，报「暂时不可用」即可。
        return finish({
          kind: 'failure',
          code: safeToRetry ? 'upstream_unavailable' : 'outcome_unknown',
          logMessage: `逻辑调用超过 ${this.deps.config.logicalCallDeadlineMs} 毫秒总截止`,
        });
      }

      state.attempts += 1;
      let response: KyAppOutboundResult;
      try {
        response = await this.attempt({ ...input, lcid, requestId, deadline });
      } catch (error) {
        if (error instanceof KyAppSatDeniedError) {
          // 签发被拒不是对方的问题，不记熔断。
          this.deps.logger?.warn(
            `[ky-app-gateway] act=agent SAT 签发被拒 lcid=${lcid} reason=${error.reason}`,
          );
          return finish({
            kind: 'failure',
            code: error.reason === 'installation_disabled' ? 'installation_disabled' : 'internal',
            logMessage: error.message,
          });
        }
        const failure = classifyOutboundError(error);
        if (failure.kind === 'blocked') {
          this.deps.logger?.warn(`[ky-app-gateway] 出站被拒 lcid=${lcid}：${failure.log}`);
          return finish({ kind: 'failure', code: failure.code, logMessage: failure.log });
        }
        state.countsTowardBreaker = true;
        this.deps.logger?.warn(`[ky-app-gateway] 无响应 lcid=${lcid}：${failure.log}`);

        if (safeToRetry) {
          const backoff = READ_RETRY_BACKOFF_MS[readRetries];
          if (backoff === undefined) {
            return finish({ kind: 'failure', code: failure.code, logMessage: failure.log });
          }
          readRetries += 1;
          await this.sleep(backoff, input.signal);
          continue;
        }
        // external_write：无响应 → 查执行记录，绝不重发写请求。
        return finish(await this.pollExecution({ ...input, lcid, requestId, deadline, state }));
      }

      const outcome = this.classifyResponse(input.entry, response, lcid);
      if (outcome.settled) return finish(outcome.outcome);

      // 未定局：只有 read_only 会走到这里（429 或可重试 5xx）。
      state.countsTowardBreaker ||= RETRYABLE_STATUSES.has(response.status);
      if (outcome.reason === 'rate_limited') {
        const retryAfter = response.retryAfterMs;
        if (usedRetryAfter || retryAfter === null || retryAfter > MAX_RETRY_AFTER_MS) {
          return finish({ kind: 'failure', code: 'rate_limited' });
        }
        usedRetryAfter = true;
        await this.sleep(retryAfter, input.signal);
        continue;
      }
      const backoff = READ_RETRY_BACKOFF_MS[readRetries];
      if (backoff === undefined) {
        return finish({ kind: 'failure', code: fallbackCodeForStatus(response.status) });
      }
      readRetries += 1;
      await this.sleep(backoff, input.signal);
    }
  }

  /** 一次 POST attempt：新签 SAT → 带幂等键发出。 */
  private async attempt(input: {
    entry: AppCapabilityEntry;
    tenantId: string;
    userId: string;
    sessionId: string;
    tenantAdmin: boolean;
    input: unknown;
    approval?: LogicalCallApproval;
    signal?: AbortSignal;
    lcid: string;
    requestId: string;
    deadline: number;
  }): Promise<KyAppOutboundResult> {
    const token = await this.signAgentSat(input);
    return this.deps.outbound.request({
      baseUrl: input.entry.baseUrl,
      path: capabilityPath(input.entry.capabilityId),
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-KY-Request-Id': input.requestId,
        // §4.3：必带且必须等于 claim lcid，否则对方 400 invalid_input。
        'X-KY-Idempotency-Key': input.lcid,
      },
      jsonBody: { input: input.input },
      requestId: input.requestId,
      ...this.attemptBudget(input.entry, input.deadline),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }

  /** 每个 attempt（含 executions 查询）都新签一枚，60 s 单次，携带 `dig`。 */
  private async signAgentSat(input: {
    entry: AppCapabilityEntry;
    tenantId: string;
    userId: string;
    sessionId: string;
    tenantAdmin: boolean;
    approval?: LogicalCallApproval;
    lcid: string;
    requestId: string;
  }): Promise<string> {
    const issued = await this.deps.issuer.issue({
      act: 'agent',
      tenantId: input.tenantId,
      installationId: input.entry.installationId,
      systemId: input.entry.systemId,
      userId: input.userId,
      tadm: input.tenantAdmin,
      cap: input.entry.capabilityId,
      lcid: input.lcid,
      dig: input.entry.registeredDigest,
      sid: input.sessionId,
      rid: input.requestId,
      ...(input.approval ? { apr: input.approval.approvalId, aph: input.approval.aph } : {}),
    });
    return issued.token;
  }

  /** 单次 HTTP 的超时：manifest 声明值与「距总截止的剩余时间」取小。 */
  private attemptBudget(entry: AppCapabilityEntry, deadline: number): { timeoutMs?: number } {
    const remaining = Math.max(1, deadline - this.now());
    const declared = entry.timeoutMs;
    const timeoutMs = declared === undefined ? remaining : Math.min(declared, remaining);
    return { timeoutMs };
  }

  /**
   * 响应分类。`settled:true` 表示这个逻辑调用到此为止；
   * `settled:false` 只可能发生在 `read_only` 上（429 或 502/503/504）。
   */
  private classifyResponse(
    entry: AppCapabilityEntry,
    response: KyAppOutboundResult,
    lcid: string,
  ):
    | { settled: true; outcome: AppInvocationOutcome }
    | { settled: false; reason: 'rate_limited' | 'retryable_5xx' } {
    const safeToRetry = entry.riskLevel === 'read_only';
    if (response.status === 200) {
      return { settled: true, outcome: this.buildSuccess(entry, response) };
    }
    if (safeToRetry && response.status === 429) return { settled: false, reason: 'rate_limited' };
    if (safeToRetry && RETRYABLE_STATUSES.has(response.status)) {
      return { settled: false, reason: 'retryable_5xx' };
    }
    const code = parseAppErrorCode(response.json);
    const logMessage = parseAppErrorLogMessage(response.json);
    // 对方没给合法 body（或 body 里的码不认识）时按 HTTP 状态兜底，不猜。
    const resolved = code === 'internal' ? fallbackCodeForStatus(response.status) : code;
    this.deps.logger?.warn(
      `[ky-app-gateway] 能力调用失败 lcid=${lcid} status=${response.status} code=${resolved}` +
        (logMessage ? ` message=${logMessage}` : ''),
    );
    return {
      settled: true,
      outcome: {
        kind: 'failure',
        code: resolved,
        outputBytes: utf8ByteLength(response.text),
        outputHash: sha256Hex(response.text),
        ...(logMessage ? { logMessage } : {}),
      },
    };
  }

  /** 200 的处置：先判 6,000 字节预算，再取 `data`，最后算 `resultLink`。 */
  private buildSuccess(
    entry: AppCapabilityEntry,
    response: KyAppOutboundResult,
  ): AppInvocationOutcome {
    const outputBytes = utf8ByteLength(response.text);
    // 审计只存响应体哈希，不存明文结果（§6.2-8）。
    const outputHash = sha256Hex(response.text);
    if (exceedsResponseBudget(response.text, this.deps.config.maxResponseBytes)) {
      // §6.2-6：对方本该自己 422，没守约时 Gateway 兜住。绝不把超长正文塞给模型。
      return { kind: 'failure', code: 'response_too_large', outputBytes, outputHash };
    }
    const payload = response.json;
    if (
      typeof payload !== 'object' ||
      payload === null ||
      (payload as { ok?: unknown }).ok !== true
    ) {
      return {
        kind: 'failure',
        code: 'internal',
        outputBytes,
        logMessage: '200 响应不符 §4.3 形状',
      };
    }
    const data = (payload as { data?: unknown }).data;
    const resultLink = buildResultLink({ entry, resultLink: entry.resultLink, data });
    return {
      kind: 'success',
      data: data ?? null,
      outputBytes,
      outputHash,
      ...(resultLink ? { resultLink } : {}),
    };
  }

  /**
   * §6.2-5 的 `external_write` 分支：查 `executions/{lcid}` 直到终态或总截止。
   * **任何「没查到终态」的收尾都必须是 `outcome_unknown`**，
   * 因为写操作可能已经落库，只是回执丢了。
   */
  private async pollExecution(input: {
    entry: AppCapabilityEntry;
    tenantId: string;
    userId: string;
    sessionId: string;
    tenantAdmin: boolean;
    approval?: LogicalCallApproval;
    signal?: AbortSignal;
    lcid: string;
    requestId: string;
    deadline: number;
    state: { attempts: number; countsTowardBreaker: boolean };
  }): Promise<AppInvocationOutcome> {
    const unknown = (log: string): AppInvocationOutcome => ({
      kind: 'failure',
      code: 'outcome_unknown',
      logMessage: log,
    });

    for (;;) {
      await this.sleep(this.deps.config.executionPollIntervalMs, input.signal);
      if (input.signal?.aborted) return unknown('run 已中止，执行结果未确认');
      if (this.now() >= input.deadline) return unknown('总截止到达时执行记录仍非终态');

      input.state.attempts += 1;
      let response: KyAppOutboundResult;
      try {
        const token = await this.signAgentSat(input);
        response = await this.deps.outbound.request({
          baseUrl: input.entry.baseUrl,
          path: executionsPath(input.entry.capabilityId, input.lcid),
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            'X-KY-Request-Id': input.requestId,
          },
          requestId: input.requestId,
          ...this.attemptBudget(input.entry, input.deadline),
          ...(input.signal ? { signal: input.signal } : {}),
        });
      } catch (error) {
        if (error instanceof KyAppSatDeniedError) return unknown(error.message);
        const failure = classifyOutboundError(error);
        if (failure.kind === 'no_response') input.state.countsTowardBreaker = true;
        // 查询本身失败不结案，继续查到截止为止。
        this.deps.logger?.warn(
          `[ky-app-gateway] 执行记录查询失败 lcid=${input.lcid}：${failure.log}`,
        );
        continue;
      }

      if (response.status !== 200) {
        input.state.countsTowardBreaker ||= response.status >= 500;
        continue;
      }
      const status = parseExecutionStatus(response.json);
      if (status === null) continue;
      if (status === 'not_started' || status === 'in_progress') continue;
      if (status === 'expired') return unknown('执行记录已过保留期');
      if (status === 'failed') {
        const error = (response.json as { error?: unknown }).error;
        const code = parseAppErrorCode({ error });
        const logMessage = parseAppErrorLogMessage({ error });
        return {
          kind: 'failure',
          code,
          outputBytes: utf8ByteLength(response.text),
          ...(logMessage ? { logMessage } : {}),
        };
      }
      // done：结果就在执行记录里，按 §4.3 的成功形状处理。
      const result = (response.json as { result?: unknown }).result;
      const text = JSON.stringify(result ?? null);
      if (exceedsResponseBudget(text, this.deps.config.maxResponseBytes)) {
        return { kind: 'failure', code: 'response_too_large', outputBytes: utf8ByteLength(text) };
      }
      const outputHash = sha256Hex(text);
      const resultLink = buildResultLink({
        entry: input.entry,
        resultLink: input.entry.resultLink,
        data: result,
      });
      return {
        kind: 'success',
        data: result ?? null,
        outputBytes: utf8ByteLength(text),
        outputHash,
        ...(resultLink ? { resultLink } : {}),
      };
    }
  }
}

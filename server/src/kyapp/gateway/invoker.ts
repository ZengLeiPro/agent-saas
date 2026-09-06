/**
 * WP3：`AppCapabilityInvoker` —— 把 provider 的一次 `invoke` 串成完整的逻辑调用。
 *
 * 顺序**有讲究**，每一步都是前一步的前提：
 * 1. **渠道闸**：`external_write` 只允许 web 渠道（§6.2-2 的确认必须是「操作人会话内
 *    二次确认」）。非 web → `approval_channel_unavailable`「该操作需要在网页端确认」。
 * 2. **身份**：租户 / 用户 / 会话缺一不可（SAT claim `tid/sub/sid` 都是必填）。
 * 3. **执行时双检**（§6.1）：系统未停用、用户仍在组织、能力仍在快照 ——
 *    前两项由 SAT 签发侧的 WP2a 四道前置兜住，第三项由 provider 的快照查表兜住。
 * 4. **审批消费**：`external_write` 必须有 `human_approval` 来源的 approvalId，
 *    并通过 `aph` 绑定校验（参数变更 = 新 aph = 拒绝复用旧审批）。
 * 5. **限流闸**：先过计数类（快、无副作用），再排队占并发槽。
 * 6. **逻辑调用**：`lcid.ts` 状态机。
 * 7. **收尾**：熔断计数 + 结果封装。**任何路径都从 `buildAppToolResult` 出口**，
 *    保证客户与模型看到的永远是按 code 渲染的自有文案。
 */
import type { AuthorizedToolCall, ToolCallContext, ToolResult } from '../../agent/toolRuntime.js';
import { recordAppCapabilityUsage } from '../../runtime/appCapabilityUsageAttribution.js';
import type { KyAppGatewayConfig } from '../config.js';
import { AppApprovalRegistry, approvalParamsHash } from './approval.js';
import { buildAppToolResult, type AppInvocationOutcome } from './envelope.js';
import type { GatewayFailureCode } from './errors.js';
import { AppLogicalCallRunner } from './lcid.js';
import type { GatewayPolicy } from './policy.js';
import type { AppCapabilityEntry } from './snapshot.js';
import type { AppCapabilityInvoker } from './toolProvider.js';

export interface AppCapabilityInvokerOptions {
  runner: AppLogicalCallRunner;
  policy: GatewayPolicy;
  approvals: AppApprovalRegistry;
  config: Pick<KyAppGatewayConfig, 'approvalTtlMs'>;
  /** SAT claim `tadm`。解析失败按 false（不给多余权限）。 */
  isTenantAdmin(input: { tenantId: string; userId: string }): Promise<boolean>;
  logger?: { warn(message: string): void };
  now?: () => number;
}

/** 不产生任何出站请求的失败：直接封装成结果，`attempts=0`。 */
function shortCircuit(
  entry: AppCapabilityEntry,
  code: GatewayFailureCode,
  logMessage?: string,
): ToolResult {
  const outcome: AppInvocationOutcome = {
    kind: 'failure',
    code,
    ...(logMessage ? { logMessage } : {}),
  };
  return buildAppToolResult({
    entry,
    lcid: '-',
    requestId: '-',
    attempts: 0,
    outcome,
  });
}

function resolveIdentity(context: ToolCallContext): { tenantId?: string; userId?: string } {
  const identity = context.channelContext.user ?? context.channelContext.sessionOwner;
  return { tenantId: identity?.tenantId, userId: identity?.id };
}

export function createAppCapabilityInvoker(
  options: AppCapabilityInvokerOptions,
): AppCapabilityInvoker {
  return {
    async invoke({ entry, call, context }): Promise<ToolResult> {
      const isWrite = entry.riskLevel === 'external_write';

      // 1. 渠道闸（§6.2-2）。
      if (isWrite && context.channelContext.channel !== 'web') {
        return shortCircuit(
          entry,
          'approval_channel_unavailable',
          `channel=${context.channelContext.channel} 无法承载二次确认`,
        );
      }

      // 2. 身份。
      const { tenantId, userId } = resolveIdentity(context);
      const sessionId = context.workspace?.sessionId ?? context.sessionId;
      const runId = context.runId;
      if (!tenantId || !userId || !sessionId || !runId) {
        return shortCircuit(entry, 'unauthorized', '缺少 tenantId / userId / sessionId / runId');
      }

      // 4. 审批消费（§6.2-3）。read_only 不需要审批。
      const inputHash = approvalParamsHash(entry.capabilityId, call.input);
      let approval: { approvalId: string; aph: string } | undefined;
      if (isWrite) {
        const approvalId = call.authorization.approvalId;
        if (!approvalId || call.authorization.source !== 'human_approval') {
          // 走到这里说明 toolPolicy 的 neverAutoApprove 被绕过了 —— fail-closed。
          return shortCircuit(entry, 'approval_required', 'external_write 缺少人工确认');
        }
        const consumed = options.approvals.consume({
          approvalId,
          tenantId,
          installationId: entry.installationId,
          userId,
          sessionId,
          capabilityId: entry.capabilityId,
          aph: inputHash,
        });
        if (!consumed.ok) {
          options.logger?.warn(
            `[ky-app-gateway] 审批不可用 approvalId=${approvalId} reason=${consumed.reason}`,
          );
          return shortCircuit(
            entry,
            consumed.reason === 'expired' ? 'approval_timeout' : 'approval_required',
            `审批消费失败：${consumed.reason}`,
          );
        }
        if (consumed.binding === null) {
          options.logger?.warn(
            `[ky-app-gateway] 审批绑定不在本进程（跨进程恢复）approvalId=${approvalId}`,
          );
        }
        approval = { approvalId, aph: inputHash };
      }

      // 5. 限流与熔断（§6.2-7）。
      const decision = options.policy.check({
        tenantId,
        installationId: entry.installationId,
        runId,
        capabilityId: entry.capabilityId,
      });
      if (!decision.allowed) return shortCircuit(entry, decision.code, '被限流或熔断拦下');

      const tenantAdmin = await options.isTenantAdmin({ tenantId, userId }).catch(() => false);

      let slot;
      try {
        slot = await options.policy.acquire(entry.installationId, context.signal);
      } catch (error) {
        // 排队被中断（run 停止）——没有发出任何请求，报暂时不可用即可。
        return shortCircuit(
          entry,
          'upstream_unavailable',
          error instanceof Error ? error.message : String(error),
        );
      }

      // §6.4：用量归因（不单独扣积分，只进 usage-events 的 raw_usage_json）。
      recordAppCapabilityUsage(runId, {
        installationId: entry.installationId,
        capabilityId: entry.capabilityId,
      });

      try {
        // 6. 逻辑调用状态机。
        const result = await options.runner.run({
          entry,
          tenantId,
          userId,
          sessionId,
          tenantAdmin,
          input: call.input,
          ...(approval ? { approval } : {}),
          ...(context.signal ? { signal: context.signal } : {}),
        });

        // 7. 熔断计数：只有 5xx / 超时 / 无响应算；4xx 是请求本身的问题。
        if (result.countsTowardBreaker) options.policy.recordFailure(entry.installationId);
        else if (result.outcome.kind === 'success')
          options.policy.recordSuccess(entry.installationId);

        return buildAppToolResult({
          entry,
          lcid: result.lcid,
          requestId: result.requestId,
          attempts: result.attempts,
          outcome: result.outcome,
          inputHash,
          ...(approval ? { approvalId: approval.approvalId } : {}),
        });
      } finally {
        slot.release();
      }
    },
  };
}

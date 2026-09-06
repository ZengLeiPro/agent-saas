/**
 * §6.4 积分耗尽的**壳层降级**：员工侧 Agent 入口置灰 +「本组织的 AI 额度已用完，
 * 已通知管理员」，**定制软件不受影响照常可用**。
 *
 * 「定制软件不受影响」是这条需求的重点：定制项目的调用不走 Agent 的积分，
 * 额度用完只该挡住 Agent，不该把客户刚上线的业务系统一起锁死。所以判定只暴露给
 * 导航区的 Agent 入口，`AppsSidebarPanel` 不消费它。
 *
 * 复用 `useTenantBillingAllowance` 而不是自己拼 summary + budget：那个 hook 已经
 * 把「计费未开启 / internal 模式 → allowance 为 null」的可见性口径收好了，
 * 再拼一遍等于把同一条规则写两份。
 *
 * 管理员双通道通知（耗尽前 3 天 + 当时的站内 / 钉钉）归 WP5，本轮不做。
 */
import { useAuth } from '@/contexts/AuthContext';
import { useTenantBillingAllowance } from '@/hooks/useTenantBillingVisibility';
import { CREDITS_EXHAUSTED_NOTICE } from '@/components/AppHost/failureText';
import type { BillingAllowance } from '@agent/shared';

export { CREDITS_EXHAUSTED_NOTICE };

/**
 * 纯判定，便于单测。
 *
 * `allowance` 为 null 有两种含义 —— 还没加载完，或者这个组织根本没有额度概念
 * （计费未开启 / internal 模式）。两种都**不降级**：加载中就把入口锁上会让正常用户
 * 每次刷新都闪一下「额度用完」，内部环境更是整个 Agent 都点不动。
 */
export function isAgentCreditsExhausted(allowance: BillingAllowance | null): boolean {
  if (!allowance) return false;
  return allowance.credits <= 0;
}

export interface AgentCreditsGate {
  exhausted: boolean;
  notice: string;
}

export function useAgentCreditsGate(): AgentCreditsGate {
  const { user } = useAuth();
  const { allowance } = useTenantBillingAllowance(user?.tenantId);
  return { exhausted: isAgentCreditsExhausted(allowance), notice: CREDITS_EXHAUSTED_NOTICE };
}

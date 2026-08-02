import type { ToolDescriptor } from '../agent/toolRuntime.js';
import type { RunContext, ToolPolicy, ToolPolicyDecision } from './types.js';

const INTERACTIVE_PERMISSION_TOOLS = new Set([
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'RequestPluginInstall',
]);

const NEVER_AUTO_APPROVE_TOOLS = new Set<string>([
  // 'UpdateCompanyInfo' 已并入 CompanyInfo(action=update)，由 descriptor.resolveCallPolicy
  // 返回 neverAutoApprove=true 表达；本集合保留给未来无法用 resolveCallPolicy 表达的工具。
]);

export class DefaultToolPolicy implements ToolPolicy {
  async decide(descriptor: ToolDescriptor, input: unknown, _context: RunContext): Promise<ToolPolicyDecision> {
    // 授权模式（autoApprove）对所有已认证用户生效（2026-07-02 起）：
    // 它免除的是「人工确认」，不是「安全边界」——Shell 的宿主隔离兜底
    // 仍在 WorkspaceToolProvider.invoke（非平台用户必须隔离 hand/container），
    // 敏感工具走 NEVER_AUTO_APPROVE_TOOLS / resolveCallPolicy.neverAutoApprove 强制人工审批。
    //
    // per-call 分档（2026-08-03 工具面收敛批次）：合并型工具（action 分读写）由
    // descriptor.resolveCallPolicy 按入参降/升档；静态 risk 恒为该工具最高档，
    // 钩子抛错时按静态档处理（fail-safe）。
    let callPolicy: { risk: ToolDescriptor['risk']; neverAutoApprove?: boolean } | undefined;
    try {
      callPolicy = descriptor.resolveCallPolicy?.(input);
    } catch {
      callPolicy = undefined;
    }
    const risk = callPolicy?.risk ?? descriptor.risk;
    const neverAutoApprove = callPolicy?.neverAutoApprove === true
      || NEVER_AUTO_APPROVE_TOOLS.has(descriptor.id)
      || NEVER_AUTO_APPROVE_TOOLS.has(descriptor.name);
    const identity = _context.channelContext.user ?? _context.channelContext.sessionOwner;
    const autoApproveTools = _context.approvalPolicy?.autoApproveTools === true
      || _context.approvalPolicy?.autoApproveRunShell === true;
    if (
      autoApproveTools
      && identity
      && risk !== 'safe'
      && !INTERACTIVE_PERMISSION_TOOLS.has(descriptor.id)
      && !INTERACTIVE_PERMISSION_TOOLS.has(descriptor.name)
      && !neverAutoApprove
    ) {
      return { type: 'allow' };
    }
    if (risk === 'safe') {
      return { type: 'allow' };
    }
    return {
      type: 'requires_approval',
      reason: `tool risk=${risk}`,
    };
  }
}

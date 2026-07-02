import type { ToolDescriptor } from '../agent/toolRuntime.js';
import type { RunContext, ToolPolicy, ToolPolicyDecision } from './types.js';

const INTERACTIVE_PERMISSION_TOOLS = new Set([
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'RequestPluginInstall',
]);

const NEVER_AUTO_APPROVE_TOOLS = new Set([
  'UpdateCompanyInfo',
]);

export class DefaultToolPolicy implements ToolPolicy {
  async decide(descriptor: ToolDescriptor, _input: unknown, _context: RunContext): Promise<ToolPolicyDecision> {
    // 授权模式（autoApprove）对所有已认证用户生效（2026-07-02 起）：
    // 它免除的是「人工确认」，不是「安全边界」——Shell 的宿主隔离兜底
    // 仍在 WorkspaceToolProvider.invoke（非平台用户必须隔离 hand/container），
    // 敏感工具走 NEVER_AUTO_APPROVE_TOOLS 强制人工审批。
    const identity = _context.channelContext.user ?? _context.channelContext.sessionOwner;
    const autoApproveTools = _context.approvalPolicy?.autoApproveTools === true
      || _context.approvalPolicy?.autoApproveRunShell === true;
    if (
      autoApproveTools
      && identity
      && descriptor.risk !== 'safe'
      && !INTERACTIVE_PERMISSION_TOOLS.has(descriptor.id)
      && !INTERACTIVE_PERMISSION_TOOLS.has(descriptor.name)
      && !NEVER_AUTO_APPROVE_TOOLS.has(descriptor.id)
      && !NEVER_AUTO_APPROVE_TOOLS.has(descriptor.name)
    ) {
      return { type: 'allow' };
    }
    if (descriptor.risk === 'safe') {
      return { type: 'allow' };
    }
    return {
      type: 'requires_approval',
      reason: `tool risk=${descriptor.risk}`,
    };
  }
}

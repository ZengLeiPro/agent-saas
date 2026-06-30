import type { ToolDescriptor } from '../agent/toolRuntime.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
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
    const identity = _context.channelContext.user ?? _context.channelContext.sessionOwner;
    const isPlatformAdmin = identity?.role === 'admin' && identity.tenantId === DEFAULT_TENANT_ID;
    const autoApproveTools = _context.approvalPolicy?.autoApproveTools === true
      || _context.approvalPolicy?.autoApproveRunShell === true;
    if (
      autoApproveTools
      && isPlatformAdmin
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

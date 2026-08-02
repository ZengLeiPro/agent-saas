import { z } from 'zod';

import type { TenantStore } from '../data/tenants/store.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import {
  MAX_COMPANY_INFO_CHARS,
  readTenantCompanyInfo,
  writeTenantCompanyInfo,
} from '../data/tenants/companyInfo.js';
import { loadToolDescription } from './tools/descriptionLoader.js';
import type {
  AuthorizedToolCall,
  ToolCallContext,
  ToolDescriptor,
  ToolProvider,
  ToolResult,
} from './toolRuntime.js';

/**
 * 2026-08-03 工具面收敛批次：ReadCompanyInfo/UpdateCompanyInfo 合并为
 * CompanyInfo(action=read|update)。静态 risk 取最高档 workspace_write（fail-safe），
 * resolveCallPolicy 对 read 降为 safe；update 保持 neverAutoApprove（强制人工审批，
 * 原 NEVER_AUTO_APPROVE_TOOLS 语义），invoke 层另有 human_approval 硬校验兜底。
 */
type CompanyInfoInput = {
  action: 'read' | 'update';
  tenantId?: string;
  content?: string;
};

const companyInfoSchema = z.object({
  action: z.enum(['read', 'update']).describe('read = 读取租户 company.md；update = 完整替换 company.md（仅组织/平台管理员，需人工审批）。'),
  tenantId: z.string().optional().describe('租户 id。平台管理员可指定任意租户；租户管理员/用户只能访问自己所在租户。'),
  content: z.string().max(MAX_COMPANY_INFO_CHARS).optional().describe('update 必填：租户 company.md 的完整替换内容。'),
});

export const companyInfoToolDescriptor: ToolDescriptor<CompanyInfoInput> = {
  id: 'CompanyInfo',
  name: 'CompanyInfo',
  displayName: 'Company Info',
  description: loadToolDescription('CompanyInfo'),
  schema: companyInfoSchema,
  risk: 'workspace_write',
  approvalMode: 'web',
  auditCategory: 'tenant.companyInfo.manage',
  category: 'memory',
  label: '组织资料',
  resolveCallPolicy: (input) => {
    const action = input && typeof input === 'object' ? (input as { action?: unknown }).action : undefined;
    if (action === 'read') return { risk: 'safe' };
    return { risk: 'workspace_write', neverAutoApprove: true };
  },
};

export interface TenantCompanyInfoToolProviderOptions {
  sharedDir: string;
  tenantStore: TenantStore;
}

export class TenantCompanyInfoToolProvider implements ToolProvider {
  constructor(private readonly options: TenantCompanyInfoToolProviderOptions) {}

  list(context?: ToolCallContext): ToolDescriptor[] {
    const identity = context?.channelContext.user ?? context?.channelContext.sessionOwner;
    if (!identity?.tenantId) return [];
    return [companyInfoToolDescriptor];
  }

  async invoke(call: AuthorizedToolCall, context: ToolCallContext): Promise<ToolResult | undefined> {
    if (call.toolId !== companyInfoToolDescriptor.id) return undefined;
    const input = companyInfoSchema.parse(call.input) as CompanyInfoInput;
    if (input.action === 'read') {
      return this.read(input, context);
    }
    if (typeof input.content !== 'string') {
      throw new Error('CompanyInfo(action="update") 需要 content（company.md 的完整替换内容）。');
    }
    return this.update({ tenantId: input.tenantId, content: input.content }, context, call);
  }

  private resolveTenantId(inputTenantId: string | undefined, context: ToolCallContext): string {
    const identity = context.channelContext.user ?? context.channelContext.sessionOwner;
    if (!identity?.tenantId) throw new Error('缺少当前用户组织身份，无法访问 company.md');
    const requestedTenantId = inputTenantId?.trim() || identity.tenantId;
    const isPlatformAdmin = identity.role === 'admin' && identity.tenantId === DEFAULT_TENANT_ID;
    if (!isPlatformAdmin && requestedTenantId !== identity.tenantId) {
      throw new Error('跨组织访问 company.md 被拒绝');
    }
    const tenant = this.options.tenantStore.findById(requestedTenantId);
    if (!tenant) throw new Error(`组织不存在: ${requestedTenantId}`);
    if (tenant.disabled) throw new Error(`组织已禁用: ${requestedTenantId}`);
    return requestedTenantId;
  }

  private async read(input: { tenantId?: string }, context: ToolCallContext): Promise<ToolResult> {
    const tenantId = this.resolveTenantId(input.tenantId, context);
    const content = await readTenantCompanyInfo(this.options.sharedDir, tenantId);
    return {
      content: JSON.stringify(
        {
          tenantId,
          configured: content !== null,
          content: content ?? '',
        },
        null,
        2,
      ),
    };
  }

  private async update(
    input: { tenantId?: string; content: string },
    context: ToolCallContext,
    call: AuthorizedToolCall,
  ): Promise<ToolResult> {
    const identity = context.channelContext.user ?? context.channelContext.sessionOwner;
    if (identity?.role !== 'admin') {
      throw new Error('只有组织管理员或平台管理员可以更新 company.md');
    }
    if (call.authorization.source !== 'human_approval') {
      throw new Error('CompanyInfo(action="update") 必须经过人工审批后才能写入');
    }
    const tenantId = this.resolveTenantId(input.tenantId, context);
    const result = await writeTenantCompanyInfo(this.options.sharedDir, tenantId, input.content);
    return {
      content: JSON.stringify(
        {
          tenantId,
          updated: true,
          chars: result.chars,
        },
        null,
        2,
      ),
    };
  }
}

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

type ReadCompanyInfoInput = {
  tenantId?: string;
};

type UpdateCompanyInfoInput = {
  tenantId?: string;
  content: string;
};

const readCompanyInfoSchema = z.object({
  tenantId: z.string().optional().describe('Tenant id to read. Platform admins may specify any tenant; tenant admins/users may only read their own tenant.'),
});

const updateCompanyInfoSchema = z.object({
  tenantId: z.string().optional().describe('Tenant id to update. Platform admins may specify any tenant; tenant admins may only update their own tenant.'),
  content: z.string().max(MAX_COMPANY_INFO_CHARS).describe('Full replacement content for the tenant company.md file.'),
});

export const readCompanyInfoToolDescriptor: ToolDescriptor<ReadCompanyInfoInput> = {
  id: 'ReadCompanyInfo',
  name: 'ReadCompanyInfo',
  displayName: 'Read Company Info',
  description: loadToolDescription('ReadCompanyInfo'),
  schema: readCompanyInfoSchema,
  risk: 'safe',
  approvalMode: 'never',
  auditCategory: 'tenant.companyInfo.read',
};

export const updateCompanyInfoToolDescriptor: ToolDescriptor<UpdateCompanyInfoInput> = {
  id: 'UpdateCompanyInfo',
  name: 'UpdateCompanyInfo',
  displayName: 'Update Company Info',
  description: loadToolDescription('UpdateCompanyInfo'),
  schema: updateCompanyInfoSchema,
  risk: 'workspace_write',
  approvalMode: 'web',
  auditCategory: 'tenant.companyInfo.write',
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
    if (identity.role === 'admin') {
      return [readCompanyInfoToolDescriptor, updateCompanyInfoToolDescriptor];
    }
    return [readCompanyInfoToolDescriptor];
  }

  async invoke(call: AuthorizedToolCall, context: ToolCallContext): Promise<ToolResult | undefined> {
    if (call.toolId === readCompanyInfoToolDescriptor.id) {
      const input = readCompanyInfoToolDescriptor.schema.parse(call.input) as ReadCompanyInfoInput;
      return this.read(input, context);
    }
    if (call.toolId === updateCompanyInfoToolDescriptor.id) {
      const input = updateCompanyInfoToolDescriptor.schema.parse(call.input) as UpdateCompanyInfoInput;
      return this.update(input, context, call);
    }
    return undefined;
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

  private async read(input: ReadCompanyInfoInput, context: ToolCallContext): Promise<ToolResult> {
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
    input: UpdateCompanyInfoInput,
    context: ToolCallContext,
    call: AuthorizedToolCall,
  ): Promise<ToolResult> {
    const identity = context.channelContext.user ?? context.channelContext.sessionOwner;
    if (identity?.role !== 'admin') {
      throw new Error('只有组织管理员或平台管理员可以更新 company.md');
    }
    if (call.authorization.source !== 'human_approval') {
      throw new Error('UpdateCompanyInfo 必须经过人工审批后才能写入');
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

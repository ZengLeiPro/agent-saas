export type GovernanceCapabilityStatus = 'available' | 'read_only' | 'unavailable';

export interface GovernanceCapability {
  id: string;
  status: GovernanceCapabilityStatus;
  reason: string;
}

export const GOVERNANCE_CAPABILITIES: readonly GovernanceCapability[] = [
  { id: 'organization.mcp', status: 'available', reason: '组织级目录读写已绑定目标组织' },
  { id: 'organization.skills', status: 'available', reason: '组织技能读写使用治理资源合同' },
  { id: 'organization.files', status: 'unavailable', reason: '安全的组织级文件清单 API 尚未交付' },
  {
    id: 'organization.automation',
    status: 'unavailable',
    reason: '组织级自动化查询和写入合同尚未交付',
  },
  { id: 'platform.admins', status: 'read_only', reason: '新增、移除和恢复尚未绑定影响预览' },
  {
    id: 'platform.environment.providers',
    status: 'read_only',
    reason: 'Provider 写入合同尚未交付',
  },
  {
    id: 'platform.environment.templates',
    status: 'read_only',
    reason: '模板发布和退役写入合同尚未交付',
  },
  { id: 'platform.content_access', status: 'read_only', reason: '授权创建和撤销写入合同尚未交付' },
  { id: 'platform.tenant_deletion', status: 'read_only', reason: '仅提供删除影响清单' },
  {
    id: 'platform.credential_signature_revocation',
    status: 'unavailable',
    reason: '签名吊销合同尚未交付',
  },
] as const;

export function governanceCapability(id: string): GovernanceCapability | undefined {
  return GOVERNANCE_CAPABILITIES.find((item) => item.id === id);
}

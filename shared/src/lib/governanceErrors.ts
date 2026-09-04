export class GovernanceApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'GovernanceApiError';
  }
}

const GOVERNANCE_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  TARGET_TENANT_REQUIRED: '请先选择目标组织。',
  TARGET_ORGANIZATION_FORBIDDEN: '当前账号无权管理该组织。',
  ENTITLEMENT_SCOPE_NOT_FOUND: '该组织缺少范围基线，请联系平台管理员初始化。',
  RESOURCE_CATALOG_UNAVAILABLE: '权威目录暂不可用，当前禁止编辑。',
  RESOURCE_SCOPE_STALE_ITEMS: '范围中包含已退出目录的资源，请核对并移除旧引用。',
  ENTITLEMENT_SCOPE_VERSION_CONFLICT: '数据已变化，请刷新后重新预览。',
  GOVERNANCE_PREVIEW_EXPIRED: '预览已过期，请重新预览。',
  MCP_SCOPE_CONFLICT: '资源属于其他作用域，不能从当前入口修改。',
  GOVERNANCE_PARTIAL_CHANGE: '请求可能已部分生效，请查看审计记录和变更 ID，禁止盲目重试。',
};

export function governanceApiErrorMessage(error: unknown, fallback = '治理请求失败。'): string {
  if (!(error instanceof GovernanceApiError))
    return error instanceof Error ? error.message : fallback;
  const message =
    GOVERNANCE_ERROR_MESSAGES[error.code] ??
    (error.code.endsWith('_AUTHORITY_UNAVAILABLE')
      ? `权威依赖不可用（${error.code}）。`
      : error.message);
  return error.requestId ? `${message} 请求 ID：${error.requestId}` : message;
}

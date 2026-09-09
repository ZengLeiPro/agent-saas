const STATUS_LABELS: Readonly<Record<string, string>> = {
  published: '已发布',
  pending: '待处理',
  enabled: '已启用',
  disabled: '已停用',
  running: '处理中',
  waiting_external: '等待外部处理',
  completed: '已完成',
  failed: '处理失败',
  ready_required: '等待业务服务就绪',
  credential_claim_required: '等待领取服务凭据',
  credential_ack_required: '等待业务服务确认凭据',
  domain_verification_required: '等待验证业务域名',
  activation_required: '等待启用业务系统',
  assignment_required: '等待配置成员范围',
  diagnostic_failed: '接入检查未通过',
  manifest_digest_mismatch: '等待确认业务版本',
  installation_disabled: '业务系统已停用',
  service_unavailable: '业务服务暂不可用',
  service_maintenance: '业务系统正在更新',
  me_not_verified: '尚未在对话中验证',
  me_unavailable: '暂时无法确认当前账号能力',
  me_no_enabled_capabilities: '当前账号没有可用能力',
  me_no_projected_capabilities: '最近一次对话未注入该系统能力',
  available: '可访问',
  unavailable: '暂不可用',
  not_configured: '未配置',
  waiting_service: '待完成',
  waiting_assignment: '待配置访问范围',
  waiting_personal_authorization: '待个人授权',
  ready: '可使用',
  degraded: '连接异常',
  not_required: '无需授权',
  not_applicable: '未授权',
  connected: '已授权',
  expired: '已过期',
  insufficient_scope: '权限不足',
  unverified: '尚未验证',
  restricted: '受 Agent 配置限制',
  waiting_user_authorization: '等待用户能力验证',
  action_required: '需要处理',
  direct: '直接授权',
  directory_group: '部门或群组授权',
  everyone: '全体成员',
  ok: '正常',
  maintenance: '维护中',
  healthy: '正常',
  warning: '需要关注',
  skipped: '已跳过',
  passed: '已通过',
  success: '成功',
  error: '失败',
};

export function businessStatusLabel(value: string | null | undefined): string {
  if (!value) return '未知状态';
  const label = STATUS_LABELS[value];
  if (label) return label;
  console.warn(`[business-systems] 未知状态: ${value}`);
  return '未知状态';
}

const formatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function formatBusinessSystemTime(value: string | null | undefined): string {
  if (!value) return '暂无';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    console.warn(`[business-systems] 非法时间: ${value}`);
    return '时间未知';
  }
  return formatter.format(parsed).replace(/\s+/g, ' ');
}

export function shortDigest(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : '暂无';
}

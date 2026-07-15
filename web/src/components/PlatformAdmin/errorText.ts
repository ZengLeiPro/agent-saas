export interface FriendlyError {
  summary: string;
  suggestion?: string;
  technicalDetail?: string;
}

interface ErrorRule {
  pattern: RegExp;
  summary: string;
  suggestion?: string;
}

const ERROR_RULES: ErrorRule[] = [
  { pattern: /\b401\b|unauthori[sz]ed|token.*expired|登录.*失效/i, summary: "登录状态已失效", suggestion: "请重新登录后再试。" },
  { pattern: /\b403\b|forbidden|access required|permission denied|没有权限/i, summary: "当前账号没有权限查看这项数据", suggestion: "请确认账号的平台管理员权限。" },
  { pattern: /\b404\b|not found|不存在|已过期/i, summary: "没有找到对应记录", suggestion: "请确认记录仍在保留期内，且编号完整无误。" },
  { pattern: /\b429\b|rate.?limit|too many requests|限流/i, summary: "服务请求过于频繁", suggestion: "稍后刷新；若持续出现，请检查模型服务限流。" },
  { pattern: /quota|insufficient.*(balance|credit)|余额不足|积分不足/i, summary: "额度或积分不足", suggestion: "请检查组织余额、积分和模型额度。" },
  { pattern: /timeout|timed out|etimedout|超时/i, summary: "请求超时", suggestion: "请刷新重试；若持续出现，再检查网络或上游服务。" },
  { pattern: /network|fetch failed|econn|enotfound|socket|\beof\b|网络/i, summary: "网络连接异常", suggestion: "请刷新重试；若持续出现，再检查平台网络。" },
  { pattern: /approval.*(reject|denied)|审批.*(拒绝|未通过)/i, summary: "审批未通过", suggestion: "请查看审批人和拒绝原因。" },
  { pattern: /cancelled|canceled|用户取消/i, summary: "操作已取消" },
];

function messageOf(value: unknown): string {
  if (value instanceof Error) return value.message;
  return typeof value === "string" ? value : String(value ?? "");
}

function matchFriendlyError(detail: string): FriendlyError | null {
  const rule = ERROR_RULES.find((item) => item.pattern.test(detail));
  if (!rule) return null;
  return { summary: rule.summary, suggestion: rule.suggestion, technicalDetail: detail || undefined };
}

export function classifyLoadError(value: unknown): FriendlyError {
  const detail = messageOf(value).trim();
  return matchFriendlyError(detail) ?? {
    summary: "暂时无法加载数据",
    suggestion: "请刷新重试；若持续出现，再展开技术详情排查。",
    technicalDetail: detail || undefined,
  };
}

export function classifyFailureReason(value: unknown): FriendlyError {
  const detail = messageOf(value).trim();
  return matchFriendlyError(detail) ?? {
    summary: "执行遇到技术错误",
    suggestion: "展开技术详情查看原始错误，再按执行记录和工具调用继续排查。",
    technicalDetail: detail || undefined,
  };
}

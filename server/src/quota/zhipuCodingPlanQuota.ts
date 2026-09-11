import type { ProviderQuotaTestResponse, ProviderQuotaWindow } from '@agent/shared';

/**
 * 智谱官方 glm-plan-usage 插件使用的个人套餐接口。
 * https://github.com/zai-org/zai-coding-plugins/tree/main/plugins/glm-plan-usage
 * 固定中国站 origin；不把模型代理 Base URL 当作监控地址，也不跟随重定向。
 */
export const ZHIPU_CODING_PLAN_QUOTA_URL =
  'https://open.bigmodel.cn/api/monitor/usage/quota/limit';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function number(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return undefined;
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : undefined;
}

function resetTime(value: unknown): string | undefined {
  const epoch = number(value);
  const time = epoch !== undefined
    ? epoch >= 1_000_000_000 && epoch < 100_000_000_000 ? epoch * 1000 : epoch
    : typeof value === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
      ? Date.parse(value)
      : NaN;
  if (!Number.isFinite(time) || time <= 0) return undefined;
  const date = new Date(time);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

/**
 * 按实际窗口而非数组位置识别周期：1=天、3=小时、5=分钟、6=周。
 * 旧 TIME_LIMIT 的 5/1 是月度 MCP 标记，只展示标签，不伪造「30 天后重置」。
 * 未知单位保留百分比、明确周期未知；TOKENS_LIMIT 不一律当作 5 小时。
 */
function period(type: string, unit: number | undefined, count: number | undefined): {
  label: string;
  seconds?: number;
} {
  if (!count || unit === undefined) return { label: '周期未返回' };
  if (type === 'TIME_LIMIT' && unit === 5 && count === 1) return { label: '每月' };
  const units: Record<number, { label: string; seconds: number }> = {
    1: { label: '天', seconds: 86_400 },
    3: { label: '小时', seconds: 3_600 },
    5: { label: '分钟', seconds: 60 },
    6: { label: '周', seconds: 604_800 },
  };
  const entry = units[unit];
  if (!entry) return { label: '未知周期' };
  const seconds = count * entry.seconds;
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return { label: '未知周期' };
  return {
    label: seconds === 604_800 ? '每周' : `${count} ${entry.label}`,
    seconds,
  };
}

export function normalizeZhipuCodingPlanQuota(
  payload: unknown,
  now = new Date(),
): ProviderQuotaTestResponse {
  const root = record(payload);
  if (!root) throw new Error('智谱额度响应格式不正确');
  const code = root.code;
  if (root.success === false || (code !== undefined && code !== 200 && code !== '200' && code !== 0 && code !== '0')) {
    // 上游 message 可能回显鉴权信息，不将原文写入快照、日志或测试响应。
    throw new Error('智谱额度接口返回业务错误，请检查 Key 和个人 Coding Plan 状态');
  }
  const data = root.data === undefined ? root : record(root.data);
  if (!data || !Array.isArray(data.limits) || data.limits.length === 0) {
    throw new Error('智谱未返回套餐额度，请确认该 Key 所属账号已开通个人 Coding Plan');
  }
  if (data.limits.length > 100) throw new Error('智谱额度窗口数量异常');

  const ids = new Map<string, number>();
  const windows: ProviderQuotaWindow[] = data.limits.map((raw) => {
    const item = record(raw);
    if (!item || typeof item.type !== 'string' || !/^[A-Z0-9_]{1,64}$/u.test(item.type)) {
      throw new Error('智谱额度窗口格式不正确');
    }
    const quota = number(item.usage);
    const current = number(item.currentValue);
    const remaining = number(item.remaining);
    const used = current ?? (quota !== undefined && remaining !== undefined && remaining <= quota
      ? quota - remaining
      : undefined);
    const usedPercent = quota !== undefined && quota > 0 && used !== undefined
      ? (used / quota) * 100
      : number(item.percentage);
    if (usedPercent === undefined || !Number.isFinite(usedPercent)) {
      throw new Error('智谱额度窗口缺少有效用量，未将未知用量显示为 0%');
    }
    const unit = number(item.unit);
    const count = number(item.number);
    const window = period(item.type, unit, count);
    const kind = item.type === 'TIME_LIMIT' ? '工具调用'
      : item.type === 'CREDIT_LIMIT' ? '模型积分'
        : item.type === 'TOKENS_LIMIT' ? '模型额度' : `额度 ${item.type}`;
    const baseId = `${item.type.toLowerCase()}:${unit ?? 'unknown'}:${count ?? 'unknown'}`;
    const ordinal = ids.get(baseId) ?? 0;
    ids.set(baseId, ordinal + 1);
    let resetAt = resetTime(item.nextResetTime);
    // 五小时窗口不应显示十小时后的重置；不擅自修正供应商时区。
    if (resetAt && item.type !== 'TIME_LIMIT' && window.seconds === 18_000
      && Date.parse(resetAt) > now.getTime() + 18_060_000) resetAt = undefined;
    return {
      id: ordinal ? `${baseId}:${ordinal + 1}` : baseId,
      label: `${window.label}${kind}`,
      ...(window.seconds !== undefined ? { windowSeconds: window.seconds } : {}),
      usedPercent,
      ...(used !== undefined ? { used } : {}),
      ...(quota !== undefined ? { quota } : {}),
      // TOKENS_LIMIT 的计量不等于模型响应 Token，不能写成 tokens。
      unit: item.type === 'TIME_LIMIT' ? '次' : item.type === 'CREDIT_LIMIT' ? '积分' : '配额单位',
      ...(resetAt ? { resetAt } : {}),
      limitReached: usedPercent >= 100,
    };
  });
  const planType = [data.planName, data.packageName, data.plan_type, data.level]
    .find((value): value is string => typeof value === 'string' && !!value.trim() && value.length <= 80);
  return {
    ...(planType ? { plan: { type: planType.trim() } } : {}),
    windows,
    limitReached: windows.some((window) => window.limitReached),
  };
}

export async function fetchZhipuCodingPlanQuota(
  fetchImpl: typeof fetch,
  apiKey: string,
  now = new Date(),
): Promise<ProviderQuotaTestResponse> {
  const key = apiKey.trim();
  if (!key || /[\r\n]/u.test(key)) throw new Error('请配置有效的智谱 API Key');
  let response: Response;
  try {
    response = await fetchImpl(ZHIPU_CODING_PLAN_QUOTA_URL, {
      method: 'GET',
      headers: { Authorization: key, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error('智谱额度查询连接失败或超时，请检查网络后重试');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    const hint = response.status === 401 || response.status === 403 ? '，请检查 Key 和套餐权限'
      : response.status === 429 ? '，查询被限流，请稍后重试' : '';
    throw new Error(`智谱额度查询 HTTP ${response.status}${hint}`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error('智谱额度响应不是有效 JSON 或读取超时');
  }
  return normalizeZhipuCodingPlanQuota(payload, now);
}

import type { ProviderQuotaPlanInfo, ProviderQuotaWindow } from '@agent/shared';

import { epochMsToIso, finiteNumber } from './quotaWindowLabel.js';
import { signVolcengineOpenApiRequest } from './volcengineOpenApiSignature.js';

/**
 * 火山方舟个人版 Agent Plan 套餐额度（管控面 OpenAPI，AccessKey 鉴权）。
 * - GetAFPUsage：5 小时 / 近一天 / 近一周 / 近一月四个滚动窗口的 Quota/Used/ResetTime（单位 AFP）
 * - GetPersonalPlan：档位、状态、起止、自动续费（未购买返回 ResourceNotFound.Plan，不影响用量）
 */
export interface VolcengineArkPlanCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

const OPENAPI_VERSION = '2024-01-01';
const REQUEST_TIMEOUT_MS = 15_000;

export class VolcengineOpenApiError extends Error {
  constructor(
    readonly action: string,
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(`${action} 失败：${code ? `${code} ` : ''}${message}`);
    this.name = 'VolcengineOpenApiError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

async function callArkOpenApi(
  fetchImpl: typeof fetch,
  credentials: VolcengineArkPlanCredentials,
  action: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const signed = signVolcengineOpenApiRequest({
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    region: credentials.region,
    service: 'ark',
    host: `ark.${credentials.region}.volcengineapi.com`,
    action,
    version: OPENAPI_VERSION,
    body: JSON.stringify(body),
  });
  const response = await fetchImpl(signed.url, {
    method: 'POST',
    headers: signed.headers,
    body: signed.body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new VolcengineOpenApiError(
      action,
      response.status,
      undefined,
      `非 JSON 响应 ${text.slice(0, 120)}`,
    );
  }
  const metadata =
    isRecord(parsed) && isRecord(parsed.ResponseMetadata) ? parsed.ResponseMetadata : undefined;
  const error = metadata && isRecord(metadata.Error) ? metadata.Error : undefined;
  if (!response.ok || error) {
    throw new VolcengineOpenApiError(
      action,
      response.status,
      typeof error?.Code === 'string' ? error.Code : undefined,
      typeof error?.Message === 'string' ? error.Message : `HTTP ${response.status}`,
    );
  }
  return isRecord(parsed) ? parsed.Result : undefined;
}

const AFP_WINDOWS: ReadonlyArray<{
  field: string;
  id: string;
  label: string;
  windowSeconds?: number;
}> = [
  { field: 'AFPFiveHour', id: 'five_hour', label: '5 小时', windowSeconds: 18_000 },
  { field: 'AFPDaily', id: 'daily', label: '近一天', windowSeconds: 86_400 },
  { field: 'AFPWeekly', id: 'weekly', label: '近一周', windowSeconds: 604_800 },
  { field: 'AFPMonthly', id: 'monthly', label: '近一月' },
];

export interface NormalizedAfpUsage {
  planType?: string;
  windows: ProviderQuotaWindow[];
  limitReached: boolean;
}

export function normalizeAfpUsage(result: unknown): NormalizedAfpUsage {
  const record = isRecord(result) ? result : {};
  const windows: ProviderQuotaWindow[] = [];
  for (const def of AFP_WINDOWS) {
    const raw = record[def.field];
    if (!isRecord(raw)) continue;
    const quota = finiteNumber(raw.Quota);
    const used = finiteNumber(raw.Used) ?? 0;
    const usedPercent = quota && quota > 0 ? (used / quota) * 100 : 0;
    windows.push({
      id: def.id,
      label: def.label,
      ...(def.windowSeconds ? { windowSeconds: def.windowSeconds } : {}),
      usedPercent: Math.round(usedPercent * 100) / 100,
      used,
      ...(quota !== undefined ? { quota } : {}),
      unit: 'AFP',
      ...(epochMsToIso(raw.ResetTime) ? { resetAt: epochMsToIso(raw.ResetTime) } : {}),
      limitReached: quota !== undefined && quota > 0 && used >= quota,
    });
  }
  return {
    ...(typeof record.PlanType === 'string' ? { planType: record.PlanType } : {}),
    windows,
    limitReached: windows.some((window) => window.limitReached === true),
  };
}

export function normalizePersonalPlan(result: unknown): ProviderQuotaPlanInfo {
  const record = isRecord(result) ? result : {};
  return {
    ...(typeof record.PlanType === 'string' ? { type: record.PlanType } : {}),
    ...(typeof record.Status === 'string' ? { status: record.Status } : {}),
    ...(typeof record.StartTime === 'string' ? { startTime: record.StartTime } : {}),
    ...(typeof record.EndTime === 'string' ? { endTime: record.EndTime } : {}),
    ...(typeof record.AutoRenew === 'boolean' ? { autoRenew: record.AutoRenew } : {}),
  };
}

export interface VolcengineArkPlanQuotaResult extends NormalizedAfpUsage {
  plan?: ProviderQuotaPlanInfo;
  /** GetPersonalPlan 失败不阻断用量，只把原因带回。 */
  planError?: string;
}

export async function fetchVolcengineArkPlanQuota(
  fetchImpl: typeof fetch,
  credentials: VolcengineArkPlanCredentials,
): Promise<VolcengineArkPlanQuotaResult> {
  const usage = normalizeAfpUsage(await callArkOpenApi(fetchImpl, credentials, 'GetAFPUsage', {}));
  try {
    const plan = normalizePersonalPlan(
      await callArkOpenApi(fetchImpl, credentials, 'GetPersonalPlan', { Plan: 'AgentPlan' }),
    );
    return {
      ...usage,
      plan: usage.planType && !plan.type ? { ...plan, type: usage.planType } : plan,
    };
  } catch (error) {
    return {
      ...usage,
      ...(usage.planType ? { plan: { type: usage.planType } } : {}),
      planError: error instanceof Error ? error.message : String(error),
    };
  }
}

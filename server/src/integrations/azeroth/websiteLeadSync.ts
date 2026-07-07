/**
 * 注册线索 → ky-azeroth CRM 单轨合流
 *
 * 自助注册成功后，把 trial_signup 事件 HMAC 推送到 azeroth
 * `POST /internal/website-leads`（与官网留资 collector 同一通道），azeroth 侧
 * 按手机号合流：已留资客户 → 待办升级为「已注册待陪跑」；新手机号 → 建档
 * （source=试用注册）+ 联系人 + 待办。
 *
 * 协议与 collector（kaiyan.net/tools/analytics-collector）逐字节一致：
 *   signature = HMAC-SHA256(secret, `${timestamp}.${stableStringify(payload)}`)
 *   headers: x-website-lead-timestamp / x-website-lead-signature: sha256=<hex>
 *
 * 配置（生产 /etc/agent-saas/server.env）：
 *   AGENT_AZEROTH_LEAD_URL    — 如 https://fc.kaiyan.net/ky-azeroth/internal/website-leads
 *   AGENT_AZEROTH_LEAD_SECRET — 与 azeroth WEBSITE_LEAD_WEBHOOK_SECRET 一致
 *
 * fire-and-forget：未配置或推送失败只 log，不阻塞注册主流程。
 */

import { createHmac } from "node:crypto";
import { apiLogger } from "../../utils/logger.js";

const PUSH_TIMEOUT_MS = 5_000;
const SITE = "agent.kaiyan.net";

export interface TrialSignupLeadInfo {
  /** agent-saas userId，作幂等 sourceId（ts_<userId>） */
  userId: string;
  phone: string;
  name: string;
  position: string;
  company?: string;
  scenario?: string;
  tenantId: string;
  /** 官网带过来的 utm_* 参数（已在路由层白名单过滤） */
  utm?: Record<string, string>;
}

/**
 * 与 azeroth verifySignature / collector 一致的稳定序列化：
 * key 排序、过滤 undefined、数组递归。签名两端必须逐字节一致。
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(",")}}`;
}

export function buildTrialSignupPayload(
  info: TrialSignupLeadInfo,
): Record<string, unknown> {
  return {
    sourceId: `ts_${info.userId}`,
    event: "trial_signup",
    site: SITE,
    phone: info.phone,
    channel: "ai_employee",
    name: info.name,
    position: info.position,
    company: info.company ?? null,
    scenario: info.scenario ?? null,
    tenantId: info.tenantId,
    utmSource: info.utm?.utm_source ?? null,
    utmMedium: info.utm?.utm_medium ?? null,
    utmCampaign: info.utm?.utm_campaign ?? null,
    utmTerm: info.utm?.utm_term ?? null,
    utmContent: info.utm?.utm_content ?? null,
    receivedAt: new Date().toISOString(),
    raw: info.utm ? { utm: info.utm } : null,
  };
}

export async function sendTrialSignupToCrm(
  info: TrialSignupLeadInfo,
): Promise<void> {
  const url = process.env.AGENT_AZEROTH_LEAD_URL?.trim();
  const secret = process.env.AGENT_AZEROTH_LEAD_SECRET?.trim();
  if (!url || !/^https?:\/\//.test(url) || !secret) {
    apiLogger.info(
      `[signup] CRM 单轨未配置（AGENT_AZEROTH_LEAD_URL/SECRET），跳过推送 phone=${info.phone}`,
    );
    return;
  }

  const payload = buildTrialSignupPayload(info);
  const timestamp = String(Date.now());
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${stableStringify(payload)}`)
    .digest("hex");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-website-lead-timestamp": timestamp,
        "x-website-lead-signature": `sha256=${signature}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      apiLogger.warn(
        `[signup] CRM 单轨推送失败 status=${res.status} phone=${info.phone} body=${body.slice(0, 200)}`,
      );
      return;
    }
    apiLogger.info(
      `[signup] CRM 单轨已推送 phone=${info.phone} tenant=${info.tenantId}`,
    );
  } catch (err) {
    apiLogger.warn(
      `[signup] CRM 单轨推送异常 phone=${info.phone}: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

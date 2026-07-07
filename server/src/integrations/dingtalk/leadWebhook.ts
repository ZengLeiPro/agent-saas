/**
 * 注册线索 → 钉钉群机器人 webhook 推送
 *
 * 与官网留资表单共用「官网线索」群。群机器人安全设置为自定义关键词「线索」，
 * markdown title 固定含该词。推送是 fire-and-forget：失败只 log，不阻塞注册主流程。
 */

import { apiLogger } from "../../utils/logger.js";

const WEBHOOK_TIMEOUT_MS = 10_000;

export interface SignupLeadInfo {
  phone: string;
  name: string;
  position: string;
  company?: string;
  tenantId: string;
  /** 官网带过来的 utm_* 参数（已在路由层白名单过滤） */
  utm?: Record<string, string>;
}

export interface WaitlistLeadInfo {
  phone: string;
  /** 官网带过来的 utm_* 参数（已在路由层白名单过滤） */
  utm?: Record<string, string>;
}

function formatUtm(utm?: Record<string, string>): string {
  return utm && Object.keys(utm).length > 0
    ? Object.entries(utm)
        .map(([k, v]) => `${k}=${v}`)
        .join(" / ")
    : "无（直接访问）";
}

/** 推 markdown 到钉钉群机器人；title 必须含机器人安全关键词「线索」 */
async function postMarkdown(
  webhookUrl: string,
  title: string,
  text: string,
  phone: string,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        msgtype: "markdown",
        markdown: { title, text },
      }),
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => ({}))) as { errcode?: number; errmsg?: string };
    if (body.errcode && body.errcode !== 0) {
      apiLogger.warn(
        `[signup] 钉钉线索推送失败 errcode=${body.errcode} errmsg=${body.errmsg ?? ""} phone=${phone}`,
      );
    }
  } catch (err) {
    apiLogger.warn(
      `[signup] 钉钉线索推送异常 phone=${phone}: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function sendSignupLeadNotification(
  webhookUrl: string,
  lead: SignupLeadInfo,
): Promise<void> {
  const text = [
    "### 官网新线索 · 注册试用",
    `- 手机号：**${lead.phone}**`,
    `- 称呼：${lead.name}`,
    `- 岗位：${lead.position}`,
    `- 公司：${lead.company || "未填写"}`,
    `- 试用组织：${lead.tenantId}`,
    `- 来源：${formatUtm(lead.utm)}`,
    "",
    "> 已自动开通试用账号，按接单 SOP 当天回访。",
  ].join("\n");
  await postMarkdown(webhookUrl, "官网新线索", text, lead.phone);
}

/**
 * 留资待开通线索（注册关闭时的 waitlist 兜底 / 收不到验证码的人工开通兜底）。
 * 与注册成功消息刻意区分：这里还没有账号，需要人工联系开通。
 */
export async function sendWaitlistLeadNotification(
  webhookUrl: string,
  lead: WaitlistLeadInfo,
): Promise<void> {
  const text = [
    "### 官网新线索 · 留资待开通",
    `- 手机号：**${lead.phone}**`,
    `- 来源：${formatUtm(lead.utm)}`,
    "",
    "> 用户在注册页留资（未开放自助注册或收不到验证码），请尽快联系并人工开通试用。",
  ].join("\n");
  await postMarkdown(webhookUrl, "官网新线索 · 留资", text, lead.phone);
}

/**
 * 手机号自助注册试用（官网联动 MVP，2026-07-04）
 *
 * 转化链路：官网 CTA →（本路由）验证码注册 → 自动开通独立试用租户 + 赠积分硬封顶
 * + 模型白名单 → 线索推钉钉「官网线索」群 → 签发 JWT 直接进产品。
 *
 * 公开端点（auth middleware PUBLIC_ROUTES 放行 /signup/*）：
 *   GET  /api/signup/status     — 是否开放注册（前端判显隐，始终可访问）
 *   POST /api/signup/send-code  — 发送验证码（IP 频控 + phone 冷却/日限在 service 内）
 *   POST /api/signup/register   — 验证码校验 → 开通 → 返回 {token, user}（与 login 同构）
 *
 * 试用租户设计（07-04 曾磊拍板方向）：每注册开独立轻量租户（tenant 级 billing
 * 账本/hard cap/模型白名单零改动复用），转正 = 租户直接转正。
 */

import { randomInt } from "node:crypto";
import { Router } from "express";
import jwt, { type SignOptions } from "jsonwebtoken";
import { z } from "zod";
import type { UserStore } from "../data/users/store.js";
import type { TenantStore } from "../data/tenants/store.js";
import { DEFAULT_TENANT_SETTINGS } from "../data/tenants/types.js";
import type { SkillConfigStore } from "../data/skills/store.js";
import type { BillingService } from "../data/billing/service.js";
import type { ModelsConfig, SelfSignupConfig } from "../app/config.js";
import {
  VerificationCodeService,
  DevSmsSender,
  type SmsSender,
} from "../integrations/sms/verificationService.js";
import { AliyunSmsSender } from "../integrations/sms/aliyunSms.js";
import { sendSignupLeadNotification } from "../integrations/dingtalk/leadWebhook.js";
import {
  appendLoginLog,
  detectLoginChannel,
} from "../data/login-logs/index.js";
import { apiLogger } from "../utils/logger.js";
import { resolveUserCwd, ensureUserWorkspace } from "../workspace/resolver.js";

// ---- Schemas ----

const PHONE_PATTERN = /^1[3-9]\d{9}$/;

const sendCodeSchema = z.object({
  phone: z.string().regex(PHONE_PATTERN, "请输入有效的 11 位手机号"),
});

const registerSchema = z.object({
  phone: z.string().regex(PHONE_PATTERN, "请输入有效的 11 位手机号"),
  code: z.string().regex(/^\d{6}$/, "验证码为 6 位数字"),
  password: z.string().min(6, "密码至少 6 个字符").max(72, "密码过长"),
  name: z.string().trim().min(1, "请填写称呼").max(20, "称呼不超过 20 个字符"),
  position: z.string().trim().min(1, "请选择岗位").max(50, "岗位不超过 50 个字符"),
  company: z.string().trim().max(50, "公司名不超过 50 个字符").optional(),
  utm: z.record(z.string(), z.string()).optional(),
});

/** 只保留 utm_ 前缀参数，限制数量与长度，防 webhook/日志被塞垃圾 */
function sanitizeUtm(
  utm: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!utm) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(utm)) {
    if (!k.startsWith("utm_") || k.length > 30) continue;
    out[k] = String(v).slice(0, 100);
    if (Object.keys(out).length >= 8) break;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// ---- IP 频控（phone 维度在 VerificationCodeService 内收口） ----

interface RateBucket {
  startedAt: number;
  count: number;
}

function createIpLimiter(maxPerWindow: number, windowMs: number) {
  const buckets = new Map<string, RateBucket>();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [ip, bucket] of buckets) {
      if (now - bucket.startedAt > windowMs) buckets.delete(ip);
    }
  }, windowMs * 2);
  timer.unref();
  return (ip: string): boolean => {
    const now = Date.now();
    const bucket = buckets.get(ip);
    if (!bucket || now - bucket.startedAt > windowMs) {
      buckets.set(ip, { startedAt: now, count: 1 });
      return true;
    }
    if (bucket.count >= maxPerWindow) return false;
    bucket.count += 1;
    return true;
  };
}

// ---- 试用租户 slug ----

const TRIAL_SLUG_ALPHABET = "abcdefghjkmnpqrstvwxyz0123456789";

function generateTrialTenantId(): string {
  let suffix = "";
  for (let i = 0; i < 8; i += 1) {
    suffix += TRIAL_SLUG_ALPHABET[randomInt(0, TRIAL_SLUG_ALPHABET.length)];
  }
  return `trial-${suffix}`;
}

// ---- Router ----

const SIGNUP_ACTOR = "self-signup";

export interface SignupRouterDeps {
  userStore: UserStore;
  tenantStore: TenantStore;
  billingService?: BillingService;
  modelsConfig?: ModelsConfig;
  /** config.auth.selfSignup；undefined = 功能关闭（仅 status 端点可用） */
  selfSignup?: SelfSignupConfig;
  jwtSecret: string;
  tokenExpiresIn: string;
  agentCwd: string;
  sharedDir: string;
  loginLogFilePath: string;
  skillConfigStore?: SkillConfigStore;
  /** 测试注入：覆盖内部按 config 构建的验证码服务（capture sender 拿真码） */
  codeService?: VerificationCodeService;
}

function buildSmsSender(selfSignup: SelfSignupConfig): SmsSender {
  const sms = selfSignup.sms;
  if (sms?.provider === "aliyun") {
    const accessKeySecret = process.env.AGENT_SMS_ACCESS_KEY_SECRET;
    if (!sms.accessKeyId || !sms.signName || !sms.templateCode || !accessKeySecret) {
      apiLogger.warn(
        "[signup] sms.provider=aliyun 但 accessKeyId/signName/templateCode/AGENT_SMS_ACCESS_KEY_SECRET 不齐，回退 dev provider（验证码只打日志）",
      );
      return new DevSmsSender();
    }
    return new AliyunSmsSender({
      accessKeyId: sms.accessKeyId,
      accessKeySecret,
      signName: sms.signName,
      templateCode: sms.templateCode,
    });
  }
  return new DevSmsSender();
}

export function createSignupRouter(deps: SignupRouterDeps): Router {
  const {
    userStore,
    tenantStore,
    billingService,
    modelsConfig,
    selfSignup,
    jwtSecret,
    tokenExpiresIn,
    agentCwd,
    sharedDir,
    loginLogFilePath,
    skillConfigStore,
  } = deps;
  const router = Router();
  const enabled = selfSignup?.enabled === true;

  // 试用租户模型白名单：config 显式配置优先，缺省 = 仅全局默认模型
  const trialAllowedModels: string[] =
    selfSignup?.allowedModels && selfSignup.allowedModels.length > 0
      ? selfSignup.allowedModels
      : modelsConfig?.default
        ? [modelsConfig.default]
        : [];
  if (enabled && trialAllowedModels.length === 0) {
    apiLogger.warn(
      "[signup] 未能确定试用租户模型白名单（selfSignup.allowedModels 与 models.default 均缺失），试用租户将不限模型",
    );
  }

  const codeService = enabled
    ? (deps.codeService ??
      new VerificationCodeService({
        sender: buildSmsSender(selfSignup!),
        universalCode: process.env.AGENT_SMS_DEV_CODE,
      }))
    : undefined;
  if (enabled && codeService) {
    apiLogger.info(
      `[signup] 自助注册已启用 sms=${codeService.sender.providerName} grantCredits=${selfSignup!.grantCredits} models=${trialAllowedModels.join(",") || "(不限)"}`,
    );
  }

  const sendCodeIpLimiter = createIpLimiter(5, 60_000);
  const registerIpLimiter = createIpLimiter(5, 60_000);

  // GET /api/signup/status — 始终可访问，前端据此决定注册入口显隐
  router.get("/status", (_req, res) => {
    res.json({ enabled });
  });

  // POST /api/signup/send-code
  router.post("/send-code", async (req, res) => {
    try {
      if (!enabled || !codeService) {
        res.status(403).json({ error: "当前未开放自助注册" });
        return;
      }
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      if (!sendCodeIpLimiter(ip)) {
        res.status(429).json({ error: "操作过于频繁，请稍后再试" });
        return;
      }
      const parsed = sendCodeSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0].message });
        return;
      }
      const { phone } = parsed.data;
      // 已注册的手机号不再发验证码（同时避免短信费浪费）
      if (userStore.listAll().some((u) => u.phone === phone || u.username === phone)) {
        res.status(409).json({ error: "该手机号已注册，请直接登录" });
        return;
      }
      const result = await codeService.requestCode(phone);
      if (!result.ok) {
        if (result.retryAfterSeconds) {
          res.set("Retry-After", String(result.retryAfterSeconds));
        }
        res.status(429).json({ error: result.error });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      apiLogger.warn(
        `[signup] send-code 失败: ${err instanceof Error ? err.message : String(err)}`,
      );
      res.status(500).json({ error: "验证码发送失败，请稍后再试" });
    }
  });

  // POST /api/signup/register
  router.post("/register", async (req, res) => {
    if (!enabled || !codeService) {
      res.status(403).json({ error: "当前未开放自助注册" });
      return;
    }
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    if (!registerIpLimiter(ip)) {
      res.status(429).json({ error: "操作过于频繁，请稍后再试" });
      return;
    }
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }
    const { phone, code, password, name, position, company } = parsed.data;
    const utm = sanitizeUtm(parsed.data.utm);

    // 查重先于验证码消费（已注册用户不该白白烧掉一个有效验证码）；
    // 手机号是否已注册的信息 send-code 409 已可探测，此处不扩大泄露面。
    if (userStore.listAll().some((u) => u.phone === phone || u.username === phone)) {
      res.status(409).json({ error: "该手机号已注册，请直接登录" });
      return;
    }
    if (!codeService.verifyAndConsume(phone, code)) {
      res.status(400).json({ error: "验证码错误或已过期" });
      return;
    }

    // ---- 开通事务（无真事务，失败时逆序尽力回滚） ----
    let tenantId: string | undefined;
    let userId: string | undefined;
    try {
      // 1. 独立试用租户
      tenantId = generateTrialTenantId();
      for (let i = 0; i < 5 && tenantStore.findById(tenantId); i += 1) {
        tenantId = generateTrialTenantId();
      }
      await tenantStore.create({
        id: tenantId,
        name: company || `试用-${phone.slice(-4)}`,
        createdBy: SIGNUP_ACTOR,
      });

      // 2. 租户模型白名单（锁默认模型，禁用户切换）
      if (trialAllowedModels.length > 0) {
        await tenantStore.updateSettings(tenantId, {
          models: {
            ...DEFAULT_TENANT_SETTINGS.models,
            defaultModel: trialAllowedModels[0],
            allowedModels: trialAllowedModels,
            allowUserModelSwitch: false,
          },
        });
      }

      // 3. 用户（username = 手机号；role=user）
      const user = await userStore.create({
        username: phone,
        password,
        role: "user",
        tenantId,
        createdBy: SIGNUP_ACTOR,
        realName: name,
        position,
        phone,
      });
      userId = user.id;

      // 4. workspace 初始化（MEMORY.md 岗位注入 → 场景推荐全链路生效）
      const identity = {
        id: user.id,
        username: user.username,
        role: user.role as "admin" | "user",
        tenantId: user.tenantId,
      };
      await ensureUserWorkspace(
        resolveUserCwd(agentCwd, identity),
        agentCwd,
        sharedDir,
        identity,
        { realName: name, position },
        skillConfigStore,
      );

      // 5. 计费：trial 模式 + 硬封顶 + 赠送积分。billing 失败必须阻断注册——
      //    没有 cap 的试用租户是成本敞口，宁可注册失败也不放行。
      if (billingService) {
        await billingService.updateTenantPolicy(
          tenantId,
          {
            billingEnabled: true,
            billingMode: "trial",
            hardCapMode: "stop_before_run",
            showBalance: true,
            showUsageCredits: true,
          },
          SIGNUP_ACTOR,
        );
        await billingService.adjustAccount({
          tenantId,
          creditsDelta: selfSignup!.grantCredits,
          type: "grant",
          note: `自助注册赠送（${phone}）`,
          actor: SIGNUP_ACTOR,
        });
      } else {
        apiLogger.warn(
          `[signup] billingService 不可用，试用租户 ${tenantId} 未设积分限额（成本敞口，需人工跟进）`,
        );
      }

      // 6. 审计 + 线索推送（fire-and-forget）
      const userAgent = req.headers["user-agent"] || "unknown";
      const channel = detectLoginChannel(userAgent);
      appendLoginLog(
        {
          timestamp: new Date().toISOString(),
          event: "user_created",
          username: user.username,
          userId: user.id,
          ip,
          userAgent,
          channel,
          detail: `self-signup tenant=${tenantId}${utm ? ` utm=${JSON.stringify(utm)}` : ""}`,
        },
        loginLogFilePath,
      ).catch(() => {});
      if (selfSignup!.dingtalkLeadWebhook) {
        void sendSignupLeadNotification(selfSignup!.dingtalkLeadWebhook, {
          phone,
          name,
          position,
          company,
          tenantId,
          utm,
        });
      }

      // 7. 签发 JWT（与 /api/auth/login 响应同构，前端复用登录态处理）
      const token = jwt.sign(
        {
          sub: user.id,
          username: user.username,
          role: user.role,
          tenantId: user.tenantId,
        },
        jwtSecret,
        { expiresIn: tokenExpiresIn } as SignOptions,
      );
      apiLogger.info(
        `[signup] 注册开通成功 phone=${phone} tenant=${tenantId} user=${user.id}`,
      );
      res.status(201).json({
        token,
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          tenantId: user.tenantId,
          realName: user.realName,
          position: user.position,
          phone: user.phone,
          debugMode: false,
          tenantFeatures:
            tenantStore.getSettings(user.tenantId)?.features ??
            DEFAULT_TENANT_SETTINGS.features,
          preferences: user.preferences ?? {},
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      apiLogger.warn(
        `[signup] 注册开通失败 phone=${phone} tenant=${tenantId ?? "-"}: ${msg}`,
      );
      // 逆序尽力回滚，避免留下无 cap 的半开通租户
      if (userId) {
        await userStore.delete(userId).catch((rollbackErr) => {
          apiLogger.warn(
            `[signup] 回滚删除用户失败 user=${userId}: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
          );
        });
      }
      if (tenantId && tenantStore.findById(tenantId)) {
        await tenantStore
          .setDisabled(tenantId, true, SIGNUP_ACTOR)
          .catch((rollbackErr) => {
            apiLogger.warn(
              `[signup] 回滚禁用租户失败 tenant=${tenantId}: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
            );
          });
      }
      res.status(500).json({ error: "注册暂时不可用，请稍后再试或联系我们" });
    }
  });

  return router;
}

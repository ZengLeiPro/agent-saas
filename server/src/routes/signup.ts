/**
 * 手机号自助注册试用（官网联动 MVP，2026-07-04；动态配置化 2026-07-06）
 *
 * 转化链路：官网 CTA →（本路由）验证码注册 → 自动开通独立试用租户 + 赠积分硬封顶
 * + 模型白名单 → 线索推钉钉「官网线索」群 → 签发 JWT 直接进产品。
 *
 * 公开端点（auth middleware PUBLIC_ROUTES 放行 /signup/*）：
 *   GET  /api/signup/status     — 是否开放注册（前端判显隐，始终可访问）
 *   POST /api/signup/send-code  — 发送验证码（IP 频控 + phone 冷却/日限在 service 内）
 *   POST /api/signup/register   — 验证码校验 → 开通 → 返回 {token, user}（与 login 同构）
 *   POST /api/signup/waitlist   — 留资兜底（注册关闭 waitlist / 收不到验证码人工开通），
 *                                 不依赖 enabled，推钉钉「官网线索」群 + server log
 *
 * 管理端点（requirePlatformAdmin，挂 /api/admin/signup-config）：
 *   GET  /  — 当前配置 + 短信通道自检（secret 不回显，只报 configured 与来源）
 *   PUT  /  — 全量更新配置；提交的 SMS Secret 写 secretVault，改完下一请求即生效
 *
 * 动态配置（2026-07-06 改造）：配置从 SignupConfigStore 读（platform-admin 配置页
 * 可改），router 按 store.configVersion 懒重建运行态（codeService/限流器/白名单）。
 * 重建会丢弃在途验证码与限流桶——配置变更是低频管理操作，可接受；用户重发验证码
 * 即可恢复。
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
import type { OrgAgentStore } from "../data/orgAgents/store.js";
import { seedOrgAgentTemplatesForTenant } from "../data/orgAgentTemplates.js";
import {
  selfSignupConfigSchema,
  type ModelsConfig,
  type SelfSignupConfig,
} from "../app/config.js";
import type { SignupConfigStore } from "../data/signupConfig.js";
import type { SecretVault } from "../security/secretVault.js";
import { requirePlatformAdmin } from "../auth/middleware.js";
import type { VerificationCodeService } from "../integrations/sms/verificationService.js";
import {
  buildSmsSender,
  buildVerificationCodeService,
  createIpLimiter,
  DEFAULT_SMS_SEND_CODE_IP_LIMIT_PER_MINUTE,
  DEFAULT_SMS_VERIFY_IP_LIMIT_PER_MINUTE,
  optionalConfigValue,
} from "../integrations/sms/configuredSms.js";
import {
  sendSignupLeadNotification,
  sendWaitlistLeadNotification,
} from "../integrations/dingtalk/leadWebhook.js";
import { sendTrialSignupToCrm } from "../integrations/azeroth/websiteLeadSync.js";
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
  /**
   * 场景直达：官网场景页带来的场景库 id（如 boss-competitor-daily）。
   * 仅作归因记录 + 钉钉线索展示；落地预填由前端用同一参数自行完成，
   * id 是否真实存在由前端匹配场景库兜底，server 只做格式清洗。
   */
  scenario: z
    .string()
    .regex(/^[a-z0-9-]{1,64}$/)
    .optional()
    .catch(undefined),
});

const waitlistSchema = z.object({
  phone: z.string().regex(PHONE_PATTERN, "请输入有效的 11 位手机号"),
  utm: z.record(z.string(), z.string()).optional(),
});

const adminUpdateSchema = z.object({
  config: selfSignupConfigSchema,
  /**
   * SMS AccessKey Secret：undefined = 不改动现值；null = 清除 vault ref
   * （回退 env）；非空字符串 = 写入 secretVault 并替换 ref。永不回显。
   */
  smsAccessKeySecret: z.string().min(1).max(200).nullable().optional(),
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
const SMS_SECRET_VAULT_OWNER = "global";
const SMS_SECRET_VAULT_KIND = "signup-sms";

export interface SignupRouterDeps {
  userStore: UserStore;
  tenantStore: TenantStore;
  billingService?: BillingService;
  modelsConfig?: ModelsConfig;
  /** 动态配置 store（platform-admin 配置页写入，本 router 按 version 懒重建） */
  signupConfigStore: SignupConfigStore;
  /** SMS AccessKey Secret 的 vault；缺省回退 env AGENT_SMS_ACCESS_KEY_SECRET */
  secretVault?: SecretVault;
  jwtSecret: string;
  tokenExpiresIn: string;
  agentCwd: string;
  sharedDir: string;
  tenantSkillsRootDir?: string;
  loginLogFilePath: string;
  skillConfigStore?: SkillConfigStore;
  /**
   * ★ 新增（2026-07-18 企业专家目录 MVP）：orgAgentStore
   * 用于新试用租户开通时自动 seed 3 个种子专家模板（disabled）。
   * 缺省时跳过 seed（保持向后兼容，不阻断注册）。
   */
  orgAgentStore?: OrgAgentStore;
  /** 测试注入：覆盖内部按配置构建的验证码服务（capture sender 拿真码） */
  codeService?: VerificationCodeService;
}

export interface SignupRouters {
  /** 挂 /api/signup（公开，PUBLIC_ROUTES 放行） */
  publicRouter: Router;
  /** 挂 /api/admin/signup-config（requirePlatformAdmin） */
  adminRouter: Router;
}

/** 单个配置版本对应的运行态（配置变更时整体替换） */
interface SignupRuntime {
  version: number;
  cfg: SelfSignupConfig;
  publicEnabled: boolean;
  /** SMS 通道不可用原因（enabled=true 但配置不齐时非空，供 admin 自检展示） */
  smsError?: string;
  codeService?: VerificationCodeService;
  sendCodeIpLimiter: (ip: string) => boolean;
  registerIpLimiter: (ip: string) => boolean;
  trialAllowedModels: string[];
}

export function createSignupRouters(deps: SignupRouterDeps): SignupRouters {
  const {
    userStore,
    tenantStore,
    billingService,
    modelsConfig,
    signupConfigStore,
    secretVault,
    jwtSecret,
    tokenExpiresIn,
    agentCwd,
    sharedDir,
    tenantSkillsRootDir,
    loginLogFilePath,
    skillConfigStore,
    orgAgentStore,
  } = deps;

  async function resolveSmsSecret(): Promise<string | undefined> {
    const ref = signupConfigStore.getSmsAccessKeySecretRef();
    if (ref && secretVault) {
      try {
        return await secretVault.getSecret(ref, { actor: "system" });
      } catch (err) {
        // fail-closed：vault 解析失败按未配置处理（aliyun 通道会因缺 secret 关闭）
        apiLogger.warn(
          `[signup] 从 secretVault 读取 SMS Secret 失败（ref=${ref}）：${err instanceof Error ? err.message : String(err)}`,
        );
        return undefined;
      }
    }
    return optionalConfigValue(process.env.AGENT_SMS_ACCESS_KEY_SECRET);
  }

  async function buildRuntime(): Promise<SignupRuntime> {
    const version = signupConfigStore.getConfigVersion();
    const cfg = signupConfigStore.getConfig();
    const enabled = cfg.enabled === true;

    // 试用租户模型白名单：显式配置优先，缺省 = 仅全局默认模型
    const trialAllowedModels: string[] =
      cfg.allowedModels && cfg.allowedModels.length > 0
        ? cfg.allowedModels
        : modelsConfig?.default
          ? [modelsConfig.default]
          : [];
    if (enabled && trialAllowedModels.length === 0) {
      apiLogger.warn(
        "[signup] 未能确定试用租户模型白名单（allowedModels 与 models.default 均缺失），试用租户将不限模型",
      );
    }

    let codeService: VerificationCodeService | undefined;
    let smsError: string | undefined;
    if (enabled) {
      if (deps.codeService) {
        codeService = deps.codeService;
      } else {
        const secret = await resolveSmsSecret();
        const built = buildSmsSender(cfg, secret);
        smsError = built.error;
        codeService = built.sender
          ? buildVerificationCodeService(cfg, built.sender)
          : undefined;
      }
    }
    if (enabled && smsError) {
      apiLogger.warn(`[signup] 自助注册短信不可用：${smsError}`);
    }
    const publicEnabled = enabled && Boolean(codeService);
    if (publicEnabled) {
      apiLogger.info(
        `[signup] 自助注册运行态已构建 v${version} sms=${codeService!.sender.providerName} grantCredits=${cfg.grantCredits} models=${trialAllowedModels.join(",") || "(不限)"}`,
      );
    }

    return {
      version,
      cfg,
      publicEnabled,
      smsError,
      codeService,
      sendCodeIpLimiter: createIpLimiter(
        cfg.sms?.maxSendPerIpPerMinute ?? DEFAULT_SMS_SEND_CODE_IP_LIMIT_PER_MINUTE,
        60_000,
      ),
      registerIpLimiter: createIpLimiter(
        cfg.sms?.maxRegisterPerIpPerMinute ??
          DEFAULT_SMS_VERIFY_IP_LIMIT_PER_MINUTE,
        60_000,
      ),
      trialAllowedModels,
    };
  }

  let cached: SignupRuntime | undefined;
  let building: Promise<SignupRuntime> | undefined;

  /** version 感知懒重建：store 每次 update 后，下一个请求拿到新运行态 */
  async function getRuntime(): Promise<SignupRuntime> {
    const version = signupConfigStore.getConfigVersion();
    if (cached && cached.version === version) return cached;
    if (!building) {
      building = buildRuntime().finally(() => {
        building = undefined;
      });
    }
    cached = await building;
    return cached;
  }

  // ---------------- 公开路由 ----------------

  const publicRouter = Router();

  // GET /api/signup/status — 始终可访问，前端据此决定注册入口显隐
  publicRouter.get("/status", async (_req, res) => {
    try {
      const rt = await getRuntime();
      res.json({ enabled: rt.publicEnabled });
    } catch {
      res.json({ enabled: false });
    }
  });

  // POST /api/signup/send-code
  publicRouter.post("/send-code", async (req, res) => {
    try {
      const rt = await getRuntime();
      if (!rt.publicEnabled || !rt.codeService) {
        res.status(403).json({ error: "当前未开放自助注册" });
        return;
      }
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      if (!rt.sendCodeIpLimiter(ip)) {
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
      const result = await rt.codeService.requestCode(phone);
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

  // POST /api/signup/waitlist — 留资兜底（注册关闭时的 waitlist / 收不到验证码时人工开通）。
  // 不依赖 enabled 状态：注册关闭时这就是唯一出口；开着时也作发码失败的兜底。
  // 同号 1 小时窗口内幂等（重复提交仍返回 ok，但只推送一次，防刷群）。
  const waitlistRecent = new Map<string, number>();
  const WAITLIST_DEDUP_WINDOW_MS = 60 * 60 * 1000;
  publicRouter.post("/waitlist", async (req, res) => {
    try {
      const rt = await getRuntime();
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      if (!rt.registerIpLimiter(ip)) {
        res.status(429).json({ error: "操作过于频繁，请稍后再试" });
        return;
      }
      const parsed = waitlistSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0].message });
        return;
      }
      const { phone } = parsed.data;
      const utm = sanitizeUtm(parsed.data.utm);
      if (userStore.listAll().some((u) => u.phone === phone || u.username === phone)) {
        res.status(409).json({ error: "该手机号已注册，请直接登录" });
        return;
      }
      const now = Date.now();
      for (const [k, ts] of waitlistRecent) {
        if (now - ts > WAITLIST_DEDUP_WINDOW_MS) waitlistRecent.delete(k);
      }
      const isDuplicate = waitlistRecent.has(phone);
      if (!isDuplicate) {
        waitlistRecent.set(phone, now);
        // 日志兜底：webhook 未配置或推送失败时，server log 仍可追回留资
        apiLogger.info(
          `[signup] waitlist 留资 phone=${phone}${utm ? ` utm=${JSON.stringify(utm)}` : ""} webhook=${rt.cfg.dingtalkLeadWebhook ? "configured" : "missing"}`,
        );
        if (rt.cfg.dingtalkLeadWebhook) {
          void sendWaitlistLeadNotification(rt.cfg.dingtalkLeadWebhook, {
            phone,
            utm,
          });
        }
      }
      res.json({ ok: true });
    } catch (err) {
      apiLogger.warn(
        `[signup] waitlist 失败: ${err instanceof Error ? err.message : String(err)}`,
      );
      res.status(500).json({ error: "提交失败，请稍后再试" });
    }
  });

  // POST /api/signup/register
  publicRouter.post("/register", async (req, res) => {
    const rt = await getRuntime().catch(() => undefined);
    if (!rt?.publicEnabled || !rt.codeService) {
      res.status(403).json({ error: "当前未开放自助注册" });
      return;
    }
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    if (!rt.registerIpLimiter(ip)) {
      res.status(429).json({ error: "操作过于频繁，请稍后再试" });
      return;
    }
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }
    const { phone, code, password, name, position, company, scenario } = parsed.data;
    const utm = sanitizeUtm(parsed.data.utm);

    // 查重先于验证码消费（已注册用户不该白白烧掉一个有效验证码）；
    // 手机号是否已注册的信息 send-code 409 已可探测，此处不扩大泄露面。
    if (userStore.listAll().some((u) => u.phone === phone || u.username === phone)) {
      res.status(409).json({ error: "该手机号已注册，请直接登录" });
      return;
    }
    if (!rt.codeService.verifyAndConsume(phone, code)) {
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

      // 2. 租户设置：模型白名单（锁默认模型，禁用户切换）+ 首日引导条默认开。
      //    注意 updateSettings 是「DEFAULT + patch」全量替换语义，必须一次调用传齐，
      //    分两次调用后一次会把前一次的改动冲回默认值。
      await tenantStore.updateSettings(tenantId, {
        ...(rt.trialAllowedModels.length > 0
          ? {
              models: {
                ...DEFAULT_TENANT_SETTINGS.models,
                defaultModel: rt.trialAllowedModels[0],
                allowedModels: rt.trialAllowedModels,
                allowUserModelSwitch: false,
              },
            }
          : {}),
        // 试用租户默认开首日引导条（aha→cron→sprint），生效还需全局
        // roleKit.firstDayGuideBar.enabled 配置打开（生产 config.json）
        personalization: { firstDayGuideBarEnabled: true },
      });

      // 2.5 ★ 新增（2026-07-18 企业专家目录 MVP）：为新试用租户 seed 3 个种子专家（disabled）
      //     seed 失败只 warn 不阻断注册——注册链路对企业专家目录不构成硬依赖，
      //     管理员随时可在目录页手动新建。
      if (orgAgentStore) {
        try {
          const seedResult = await seedOrgAgentTemplatesForTenant(orgAgentStore, tenantId, SIGNUP_ACTOR);
          if (seedResult.seeded.length > 0) {
            apiLogger.info(
              `[signup] org-agent-templates seeded tenant=${tenantId} `
                + `count=${seedResult.seeded.length} errors=${seedResult.errors.length}`,
            );
          }
        } catch (err) {
          apiLogger.warn(
            `[signup] org-agent-templates seed 异常 tenant=${tenantId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
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
        phoneVerifiedAt: new Date().toISOString(),
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
        tenantSkillsRootDir,
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
          creditsDelta: rt.cfg.grantCredits,
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
          detail: `self-signup tenant=${tenantId}${scenario ? ` scenario=${scenario}` : ""}${utm ? ` utm=${JSON.stringify(utm)}` : ""}`,
        },
        loginLogFilePath,
      ).catch(() => {});
      if (rt.cfg.dingtalkLeadWebhook) {
        void sendSignupLeadNotification(rt.cfg.dingtalkLeadWebhook, {
          phone,
          name,
          position,
          company,
          tenantId,
          scenario,
          utm,
        });
      }
      // CRM 单轨：注册事件推 azeroth 按手机号合流（fire-and-forget，未配置时跳过）
      void sendTrialSignupToCrm({
        userId: user.id,
        phone,
        name,
        position,
        company,
        scenario,
        tenantId,
        utm,
      });

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
          phoneVerifiedAt: user.phoneVerifiedAt,
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
      if (msg === "Phone already exists" || msg === "Username already exists") {
        res.status(409).json({ error: "该手机号已注册，请直接登录" });
        return;
      }
      res.status(500).json({ error: "注册暂时不可用，请稍后再试或联系我们" });
    }
  });

  // ---------------- 管理路由（platform admin） ----------------

  async function buildAdminView(): Promise<Record<string, unknown>> {
    const rt = await getRuntime();
    const meta = signupConfigStore.getMeta();
    const vaultRef = signupConfigStore.getSmsAccessKeySecretRef();
    const envSecret = optionalConfigValue(
      process.env.AGENT_SMS_ACCESS_KEY_SECRET,
    );
    return {
      config: rt.cfg,
      /** 生效状态自检：publicEnabled=false 时 smsError 给出原因 */
      publicEnabled: rt.publicEnabled,
      smsError: rt.smsError ?? null,
      smsSecretConfigured: Boolean(vaultRef || envSecret),
      smsSecretSource: vaultRef ? "vault" : envSecret ? "env" : null,
      effectiveAllowedModels: rt.trialAllowedModels,
      updatedAt: meta.updatedAt ?? null,
      updatedBy: meta.updatedBy ?? null,
    };
  }

  const adminRouter = Router();
  adminRouter.use(requirePlatformAdmin);

  adminRouter.get("/", async (_req, res) => {
    try {
      res.json(await buildAdminView());
    } catch (err) {
      apiLogger.warn(
        `[signup] admin 读取配置失败: ${err instanceof Error ? err.message : String(err)}`,
      );
      res.status(500).json({ error: "读取注册配置失败" });
    }
  });

  adminRouter.put("/", async (req, res) => {
    try {
      const parsed = adminUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: `配置不合法：${parsed.error.issues[0]?.message ?? "unknown"}`,
        });
        return;
      }
      const { config, smsAccessKeySecret } = parsed.data;

      let secretRefPatch: string | null | undefined;
      if (typeof smsAccessKeySecret === "string") {
        if (!secretVault) {
          res.status(400).json({
            error:
              "secretVault 未启用，无法保存 SMS Secret；请改用环境变量 AGENT_SMS_ACCESS_KEY_SECRET",
          });
          return;
        }
        const ref = await secretVault.putSecret(
          SMS_SECRET_VAULT_OWNER,
          SMS_SECRET_VAULT_KIND,
          smsAccessKeySecret,
          { updatedBy: req.user?.username ?? "platform-admin" },
        );
        secretRefPatch = ref.id;
      } else if (smsAccessKeySecret === null) {
        secretRefPatch = null;
      }

      await signupConfigStore.update(config, {
        actor: req.user?.username ?? "platform-admin",
        smsAccessKeySecretRef: secretRefPatch,
      });
      apiLogger.info(
        `[signup] 注册配置已更新 by=${req.user?.username ?? "?"} enabled=${config.enabled} grantCredits=${config.grantCredits} smsProvider=${config.sms?.provider ?? "dev"}${secretRefPatch !== undefined ? " secret=updated" : ""}`,
      );
      res.json(await buildAdminView());
    } catch (err) {
      apiLogger.warn(
        `[signup] admin 更新配置失败: ${err instanceof Error ? err.message : String(err)}`,
      );
      res.status(500).json({ error: "保存注册配置失败" });
    }
  });

  return { publicRouter, adminRouter };
}

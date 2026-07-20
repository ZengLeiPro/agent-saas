import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { Router, type RequestHandler } from "express";
import jwt, { type SignOptions } from "jsonwebtoken";
import multer from "multer";
import { z } from "zod";
import {
  requireAdmin,
  requirePlatformAdmin,
  isPlatformAdmin,
} from "../auth/middleware.js";
import {
  getEffectivePlatformCapabilities,
  hasPlatformCapability,
  isSuperAdmin,
  normalizePlatformCapabilities,
  requireSuperAdmin,
} from "../auth/platformGovernance.js";
import type { JwtPayload } from "../auth/types.js";
import type { UserStore } from "../data/users/store.js";
import type { UserRecord } from "../data/users/types.js";
import type { TenantStore } from "../data/tenants/store.js";
import {
  DEFAULT_TENANT_ID,
  DEFAULT_TENANT_SETTINGS,
  TENANT_SLUG_PATTERN,
} from "../data/tenants/types.js";
import { checkTenantAccess } from "../data/tenants/access.js";
import type { SkillConfigStore } from "../data/skills/store.js";
import type { SignupConfigStore } from "../data/signupConfig.js";
import type { SecretVault } from "../security/secretVault.js";
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
  appendLoginLog,
  queryLoginLogs,
  clearLoginLogs,
  detectLoginChannel,
  auditLog,
  getLastActivePerUser,
} from "../data/login-logs/index.js";
import type { LoginEvent, LoginChannel } from "../data/login-logs/index.js";
import { apiLogger } from "../utils/logger.js";
import { resolveUserCwd, ensureUserWorkspace } from "../workspace/resolver.js";
import { softDeleteUserResources } from "../data/users/cleanup.js";
import type { McpOAuthService } from "../mcp/oauthService.js";

// ---- Zod schemas ----

const loginSchema = z.object({
  username: z.string().min(1, "账号不能为空"),
  password: z.string().min(1, "密码不能为空"),
});

const PHONE_PATTERN = /^1[3-9]\d{9}$/;

const smsLoginSendCodeSchema = z.object({
  phone: z.string().regex(PHONE_PATTERN, "请输入有效的 11 位手机号"),
});

const smsLoginSchema = z.object({
  phone: z.string().regex(PHONE_PATTERN, "请输入有效的 11 位手机号"),
  code: z.string().regex(/^\d{6}$/, "验证码为 6 位数字"),
});

const phoneVerificationSendCodeSchema = z.object({
  phone: z.string().regex(PHONE_PATTERN, "请输入有效的 11 位手机号"),
});

const phoneVerificationSchema = z.object({
  phone: z.string().regex(PHONE_PATTERN, "请输入有效的 11 位手机号"),
  code: z.string().regex(/^\d{6}$/, "验证码为 6 位数字"),
});

const permissionsSchema = z
  .object({
    maxTurns: z.number().int().positive().optional(),
    rateLimit: z
      .object({
        maxRequests: z.number().int().positive().optional(),
        windowMs: z.number().int().positive().optional(),
      })
      .optional(),
  })
  .optional();

const platformCapabilitySchema = z.enum([
  "tenant.manage",
  "user.manage",
  "customer_config.manage",
  "billing.adjust",
  "credential.reset",
  "runtime.operate",
  "finance.read",
]);

const platformCapabilityLimitsSchema = z.object({
  billingMaxCreditsPerTransaction: z.number().positive().optional(),
  billingMaxCreditsPerDay: z.number().positive().optional(),
}).optional();

// 用户名校验：只允许字母、数字、下划线、连字符、中日韩字符，防止路径注入
const USERNAME_PATTERN =
  /^[a-zA-Z0-9\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff][a-zA-Z0-9_\-\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]*$/;

const createUserSchema = z.object({
  username: z
    .string()
    .min(1, "用户名不能为空")
    .max(50, "用户名不超过 50 个字符")
    .regex(USERNAME_PATTERN, "用户名只能包含字母、数字、下划线、连字符或中文"),
  password: z.string().min(6, "密码至少 6 个字符"),
  role: z.enum(["admin", "user"]).optional().default("user"),
  realName: z.string().optional(),
  position: z.string().max(50, "岗位不超过 50 个字符").optional(),
  dingtalkStaffId: z.string().optional(),
  debugMode: z.boolean().optional().default(false),
  /**
   * tenantId 多组织归属。
   *   - 平台 admin：可显式指定任意已存在的 tenant id；省略则默认归属 platform admin 自己的 tenant（kaiyan）。
   *   - 组织 admin：忽略入参（即使指定也按调用方 tenant 强制）。
   */
  tenantId: z.string().regex(TENANT_SLUG_PATTERN, "tenantId 不合法").optional(),
  permissions: permissionsSchema,
  platformCapabilities: z.array(platformCapabilitySchema).max(20).optional(),
  platformCapabilityLimits: platformCapabilityLimitsSchema,
});

const changePasswordSchema = z.object({
  oldPassword: z.string().min(1, "请输入当前密码"),
  newPassword: z.string().min(6, "新密码至少 6 个字符"),
});

// PATCH /me/phone：仅保留清除手机号；绑定/更换手机号必须走验证码验证接口。
const updatePreferencesSchema = z.object({
  sidebarLayout: z.enum(["double", "single"]).optional(),
  authorizationModeEnabled: z.boolean().optional(),
  showSessionListAvatar: z.boolean().optional(),
  activeRoleId: z.string().min(1).optional(),
  industryHint: z.enum(["manufacturing", "trade", "retail", "service", "export", "ecommerce"]).optional(),
});

const updatePhoneSchema = z.object({
  phone: z
    .string()
    .refine(
      (v) => v === "" || PHONE_PATTERN.test(v),
      "请输入有效的 11 位手机号",
    ),
});

function validateTenantUserPolicy(
  tenantStore: TenantStore | undefined,
  userStore: UserStore,
  tenantId: string,
  role: "admin" | "user",
  password?: string,
  excludeUserId?: string,
): string | null {
  const settings = tenantStore?.getSettings(tenantId);
  if (!settings) return null;
  const minLength = settings.security.passwordMinLength;
  if (password && minLength && password.length < minLength) {
    return `密码至少 ${minLength} 个字符`;
  }
  const tenantUsers = userStore
    .listAll()
    .filter((u) => u.tenantId === tenantId && u.id !== excludeUserId);
  if (
    settings.quotas.maxUsers &&
    tenantUsers.length + 1 > settings.quotas.maxUsers
  ) {
    return `组织用户数已达到上限 ${settings.quotas.maxUsers}`;
  }
  if (role === "admin") {
    const adminCount = tenantUsers.filter((u) => u.role === "admin").length;
    if (
      settings.quotas.maxAdmins &&
      adminCount + 1 > settings.quotas.maxAdmins
    ) {
      return `组织管理员数已达到上限 ${settings.quotas.maxAdmins}`;
    }
  }
  return null;
}

const updateUserSchema = z.object({
  password: z.string().min(6, "密码至少 6 个字符").optional(),
  role: z.enum(["admin", "user"]).optional(),
  realName: z.string().optional(),
  position: z.string().max(50, "岗位不超过 50 个字符").optional(),
  dingtalkStaffId: z.string().optional(),
  debugMode: z.boolean().optional(),
  /** 仅平台 admin 可改 tenantId（业务层校验） */
  tenantId: z.string().regex(TENANT_SLUG_PATTERN, "tenantId 不合法").optional(),
  permissions: permissionsSchema.nullable(),
  platformCapabilities: z.array(platformCapabilitySchema).max(20).optional(),
  platformCapabilityLimits: platformCapabilityLimitsSchema,
});

function platformOperatorTargetError(
  caller: JwtPayload | undefined,
  target: Pick<UserRecord, "id" | "tenantId">,
): string | null {
  if (!caller || !isPlatformAdmin(caller) || isSuperAdmin(caller)) return null;
  if (target.id === caller.sub) return null;
  return target.tenantId === DEFAULT_TENANT_ID
    ? "平台运营管理员不能管理万神殿账号"
    : null;
}

function maskPhone(phone: string | undefined): string | undefined {
  if (!phone) return undefined;
  if (phone.length < 7) return "***";
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

function validatePlatformCapabilityConfig(
  capabilities: readonly string[] | undefined,
  limits: { billingMaxCreditsPerTransaction?: number; billingMaxCreditsPerDay?: number } | undefined,
): string | null {
  if (!capabilities?.includes("billing.adjust")) return null;
  const perTransaction = limits?.billingMaxCreditsPerTransaction;
  const perDay = limits?.billingMaxCreditsPerDay;
  if (!perTransaction || !perDay) {
    return "授权积分流水时必须同时设置单笔上限和每日上限";
  }
  if (perDay < perTransaction) return "积分流水每日上限不能小于单笔上限";
  return null;
}

function tenantAdminPeerAdminError(
  caller: JwtPayload | undefined,
  target: Pick<UserRecord, "id" | "role">,
): string | null {
  if (!caller || isPlatformAdmin(caller)) return null;
  if (target.id !== caller.sub && target.role === "admin") {
    return "组织管理员不能管理其他管理员";
  }
  return null;
}

function selfUpdateError(
  caller: JwtPayload | undefined,
  target: Pick<UserRecord, "id" | "role" | "tenantId">,
  input: { role?: "admin" | "user"; tenantId?: string },
): string | null {
  if (!caller || caller.sub !== target.id) return null;
  if (target.role === "admin" && input.role && input.role !== "admin") {
    return "不能降级自己";
  }
  if (input.tenantId && input.tenantId !== target.tenantId) {
    return "不能修改自己的组织归属";
  }
  return null;
}

// ---- Rate limiter ----

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60_000;

interface RateBucket {
  startedAt: number;
  count: number;
}

const loginAttempts = new Map<string, RateBucket>();

// 定期清理过期桶（每 2 分钟），unref() 避免阻止进程优雅退出
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of loginAttempts) {
    if (now - bucket.startedAt > WINDOW_MS) {
      loginAttempts.delete(ip);
    }
  }
}, WINDOW_MS * 2);
cleanupTimer.unref();

function checkLoginRate(ip: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  const bucket = loginAttempts.get(ip);

  if (!bucket || now - bucket.startedAt > WINDOW_MS) {
    loginAttempts.set(ip, { startedAt: now, count: 1 });
    return { allowed: true };
  }

  if (bucket.count >= MAX_ATTEMPTS) {
    const retryAfter = Math.ceil((bucket.startedAt + WINDOW_MS - now) / 1000);
    return { allowed: false, retryAfter };
  }

  bucket.count += 1;
  return { allowed: true };
}

// ---- Router ----

export interface AuthRouterDeps {
  userStore: UserStore;
  /**
   * Tenant store。PR 2 起 createUser/updateUser 在分配 tenantId 时校验存在性。
   * 若未提供（极端配置 auth.enabled 但 tenant 未初始化），fallback 到只校验 slug 规范。
   */
  tenantStore?: TenantStore;
  jwtSecret: string;
  tokenExpiresIn: string;
  /** 头像存储目录（绝对路径） */
  avatarsDir: string;
  /** 操作日志 JSONL 文件路径 */
  loginLogFilePath: string;
  /** Agent 工作根目录 */
  agentCwd: string;
  /** 共享资源目录 */
  sharedDir: string;
  /** 租户自有 skill 持久根目录 */
  tenantSkillsRootDir?: string;
  /** 用户被禁用时的回调（断开 WS 连接 + 中止活跃流） */
  onUserDisabled?: (userId: string) => void;
  /** Skill 配置 store，用于删除用户时清理孤儿条目 */
  skillConfigStore?: SkillConfigStore;
  /** 删除用户时撤销其 MCP OAuth token，并清理用户 MCP 配置。 */
  mcpOAuthService?: McpOAuthService;
  /** 动态注册配置 store：复用其中的 SMS provider 配置给短信验证码登录。 */
  signupConfigStore?: SignupConfigStore;
  /** SMS AccessKey Secret 的 vault；缺省回退 env AGENT_SMS_ACCESS_KEY_SECRET。 */
  secretVault?: SecretVault;
  /** 测试注入：覆盖按配置构建的验证码服务。 */
  loginCodeService?: VerificationCodeService;
}

function avatarUrl(
  userId: string,
  avatar?: string,
  avatarVersion?: number,
): string | undefined {
  if (!avatar) return undefined;
  const base = `/api/auth/avatar/${userId}`;
  return avatarVersion ? `${base}?v=${avatarVersion}` : base;
}

const ALLOWED_AVATAR_TYPES = ["image/png", "image/jpeg", "image/webp"];

export function createAuthRouter(deps: AuthRouterDeps): Router {
  const {
    userStore,
    tenantStore,
    jwtSecret,
    tokenExpiresIn,
    avatarsDir,
    loginLogFilePath,
    agentCwd,
    sharedDir,
    tenantSkillsRootDir,
    skillConfigStore,
    mcpOAuthService,
    signupConfigStore,
    secretVault,
    loginCodeService,
  } = deps;
  const router = Router();

  /** Resolve createdBy userId to username (fallback to raw value) */
  function resolveCreatedBy(createdBy: string | undefined): string {
    if (!createdBy || createdBy === "system") return createdBy || "";
    const creator = userStore.findById(createdBy);
    return creator ? creator.username : createdBy;
  }

  function tenantFeatures(tenantId: string | undefined) {
    return (
      tenantStore?.getSettings(tenantId || DEFAULT_TENANT_ID)?.features ??
      DEFAULT_TENANT_SETTINGS.features
    );
  }

  function buildAuthResponse(user: UserRecord) {
    const tenantId = user.tenantId || DEFAULT_TENANT_ID;
    const authPayload: JwtPayload = {
      sub: user.id,
      username: user.username,
      role: user.role,
      tenantId,
      platformCapabilities: user.platformCapabilities,
      platformCapabilityLimits: user.platformCapabilityLimits,
    };
    const token = jwt.sign(
      {
        sub: user.id,
        username: user.username,
        role: user.role,
        tenantId,
      },
      jwtSecret,
      { expiresIn: tokenExpiresIn } as SignOptions,
    );
    return {
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        tenantId,
        // 与 /me 同口径：登录响应即带 super 标记，避免前端在下一次 me 刷新前误判只读
        isSuperAdmin: isSuperAdmin(authPayload),
        platformCapabilities: getEffectivePlatformCapabilities(authPayload),
        platformCapabilityLimits: user.platformCapabilityLimits,
        realName: user.realName,
        position: user.position,
        phone: user.phone,
        phoneVerifiedAt: user.phoneVerifiedAt,
        avatar: avatarUrl(user.id, user.avatar, user.avatarVersion),
        avatarVersion: user.avatarVersion,
        debugMode: user.debugMode === true,
        tenantFeatures: tenantFeatures(tenantId),
        preferences: user.preferences ?? {},
      },
    };
  }

  interface SmsLoginRuntime {
    version: number;
    publicEnabled: boolean;
    smsError?: string;
    codeService?: VerificationCodeService;
    sendCodeIpLimiter: (ip: string) => boolean;
    loginIpLimiter: (ip: string) => boolean;
  }

  async function resolveSmsSecret(): Promise<string | undefined> {
    const ref = signupConfigStore?.getSmsAccessKeySecretRef();
    if (ref && secretVault) {
      try {
        return await secretVault.getSecret(ref, { actor: "system" });
      } catch (err) {
        apiLogger.warn(
          `[auth:sms] 从 secretVault 读取 SMS Secret 失败（ref=${ref}）：${err instanceof Error ? err.message : String(err)}`,
        );
        return undefined;
      }
    }
    return optionalConfigValue(process.env.AGENT_SMS_ACCESS_KEY_SECRET);
  }

  async function buildSmsLoginRuntime(): Promise<SmsLoginRuntime> {
    const version = signupConfigStore?.getConfigVersion() ?? 0;
    const cfg = signupConfigStore?.getConfig();
    const sendLimit =
      cfg?.sms?.maxSendPerIpPerMinute ??
      DEFAULT_SMS_SEND_CODE_IP_LIMIT_PER_MINUTE;
    const loginLimit =
      cfg?.sms?.maxRegisterPerIpPerMinute ??
      DEFAULT_SMS_VERIFY_IP_LIMIT_PER_MINUTE;
    const base = {
      version,
      sendCodeIpLimiter: createIpLimiter(sendLimit, 60_000),
      loginIpLimiter: createIpLimiter(loginLimit, 60_000),
    };

    const smsConfigured = Boolean(loginCodeService || cfg?.enabled === true || cfg?.sms);
    if (!smsConfigured) {
      return {
        ...base,
        publicEnabled: false,
        smsError: "短信通道未配置",
      };
    }
    if (loginCodeService) {
      return {
        ...base,
        publicEnabled: true,
        codeService: loginCodeService,
      };
    }
    if (!cfg) {
      return {
        ...base,
        publicEnabled: false,
        smsError: "短信通道未配置",
      };
    }

    const secret = await resolveSmsSecret();
    const built = buildSmsSender(cfg, secret);
    const codeService = built.sender
      ? buildVerificationCodeService(cfg, built.sender)
      : undefined;
    if (built.error) {
      apiLogger.warn(`[auth:sms] 短信登录不可用：${built.error}`);
    } else if (codeService) {
      apiLogger.info(
        `[auth:sms] 短信登录运行态已构建 v${version} sms=${codeService.sender.providerName}`,
      );
    }
    return {
      ...base,
      publicEnabled: Boolean(codeService),
      smsError: built.error,
      codeService,
    };
  }

  let cachedSmsLoginRuntime: SmsLoginRuntime | undefined;
  let buildingSmsLoginRuntime: Promise<SmsLoginRuntime> | undefined;

  async function getSmsLoginRuntime(): Promise<SmsLoginRuntime> {
    const version = signupConfigStore?.getConfigVersion() ?? 0;
    if (cachedSmsLoginRuntime && cachedSmsLoginRuntime.version === version) {
      return cachedSmsLoginRuntime;
    }
    if (!buildingSmsLoginRuntime) {
      buildingSmsLoginRuntime = buildSmsLoginRuntime().finally(() => {
        buildingSmsLoginRuntime = undefined;
      });
    }
    cachedSmsLoginRuntime = await buildingSmsLoginRuntime;
    return cachedSmsLoginRuntime;
  }

  function resolveSmsLoginUser(phone: string):
    | { ok: true; user: UserRecord }
    | { ok: false; status: number; error: string; code?: string } {
    const matches = userStore.findAllByPhone(phone);
    if (matches.length === 0) {
      return { ok: false, status: 404, error: "手机号未注册" };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        status: 409,
        error: "该手机号绑定了多个账号，请联系管理员处理",
        code: "PHONE_NOT_UNIQUE",
      };
    }
    const user = matches[0];
    const verified =
      user.phone === phone &&
      Boolean(
        user.phoneVerifiedAt ||
          (user.username === phone && user.createdBy === "self-signup"),
      );
    if (!verified) {
      return {
        ok: false,
        status: 403,
        error: "该手机号尚未完成验证，不能用于验证码登录",
        code: "PHONE_NOT_VERIFIED",
      };
    }
    return { ok: true, user };
  }

  function phoneBelongsToAnotherUser(phone: string, userId: string): boolean {
    return userStore.findAllByPhone(phone).some((u) => u.id !== userId);
  }

  // 确保头像目录存在
  if (!existsSync(avatarsDir)) {
    mkdirSync(avatarsDir, { recursive: true });
  }

  // multer 用于头像上传
  const avatarStorage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, avatarsDir),
    filename: (req, file, cb) => {
      // Admin uploading for another user: use target user ID from route params
      const userId = req.params.id || req.user?.sub || "unknown";
      const ext = extname(file.originalname).toLowerCase() || ".jpg";
      cb(null, `${userId}${ext}`);
    },
  });
  const avatarUpload = multer({
    storage: avatarStorage,
    limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
    fileFilter: (_req, file, cb) => {
      if (ALLOWED_AVATAR_TYPES.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error("仅支持 PNG、JPEG、WebP 格式的图片"));
      }
    },
  });
  // multer 错误 → 语义化 4xx JSON（与 agents.ts/orgAgents.ts avatar 上传同范式）。
  // 不捕获会落到 Express 默认错误处理器，对外表现为 500 HTML。
  const avatarUploadSingle: RequestHandler = (req, res, next) => {
    avatarUpload.single("avatar")(req, res, (err: unknown) => {
      if (err) {
        if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
          res.status(413).json({ error: "文件大小超过 2MB 限制" });
          return;
        }
        // fileFilter 抛出的格式错误等
        res.status(400).json({
          error: err instanceof Error ? err.message : "上传失败",
        });
        return;
      }
      next();
    });
  };

  // POST /api/auth/sms/send-code
  router.post("/sms/send-code", async (req, res) => {
    try {
      const rt = await getSmsLoginRuntime();
      if (!rt.publicEnabled || !rt.codeService) {
        res.status(403).json({ error: "当前未开放短信验证码登录" });
        return;
      }

      const ip = req.ip || req.socket.remoteAddress || "unknown";
      if (!rt.sendCodeIpLimiter(ip)) {
        res.status(429).json({ error: "操作过于频繁，请稍后再试" });
        return;
      }

      const parsed = smsLoginSendCodeSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0].message });
        return;
      }
      const { phone } = parsed.data;
      const resolved = resolveSmsLoginUser(phone);
      if (!resolved.ok) {
        res.status(resolved.status).json({ error: resolved.error, code: resolved.code });
        return;
      }

      const user = resolved.user;
      if (user.disabled) {
        res.status(403).json({ error: "账号已被禁用", code: "USER_DISABLED" });
        return;
      }
      const tenantAccess = checkTenantAccess(
        tenantStore,
        user.tenantId || DEFAULT_TENANT_ID,
      );
      if (!tenantAccess.ok) {
        res.status(403).json({ error: tenantAccess.message, code: tenantAccess.code });
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
        `[auth:sms] send-code 失败: ${err instanceof Error ? err.message : String(err)}`,
      );
      res.status(500).json({ error: "验证码发送失败，请稍后再试" });
    }
  });

  // POST /api/auth/sms/login
  router.post("/sms/login", async (req, res) => {
    try {
      const rt = await getSmsLoginRuntime();
      if (!rt.publicEnabled || !rt.codeService) {
        res.status(403).json({ error: "当前未开放短信验证码登录" });
        return;
      }

      const ip = req.ip || req.socket.remoteAddress || "unknown";
      const userAgent = req.headers["user-agent"] || "unknown";
      const channel = detectLoginChannel(userAgent);
      if (!rt.loginIpLimiter(ip)) {
        res.status(429).json({ error: "操作过于频繁，请稍后再试" });
        return;
      }

      const parsed = smsLoginSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0].message });
        return;
      }
      const { phone, code } = parsed.data;
      const resolved = resolveSmsLoginUser(phone);
      if (!resolved.ok) {
        res.status(resolved.status).json({ error: resolved.error, code: resolved.code });
        return;
      }

      const user = resolved.user;
      if (user.disabled) {
        if (user.role !== "admin") {
          appendLoginLog(
            {
              timestamp: new Date().toISOString(),
              event: "login_fail",
              username: user.username,
              userId: user.id,
              tenantId: user.tenantId,
              ip,
              userAgent,
              channel,
              failReason: "account_disabled",
            },
            loginLogFilePath,
          ).catch(() => {});
        }
        res.status(403).json({ error: "账号已被禁用", code: "USER_DISABLED" });
        return;
      }

      const loginTenantId = user.tenantId || DEFAULT_TENANT_ID;
      const tenantAccess = checkTenantAccess(tenantStore, loginTenantId);
      if (!tenantAccess.ok) {
        if (user.role !== "admin") {
          appendLoginLog(
            {
              timestamp: new Date().toISOString(),
              event: "login_fail",
              username: user.username,
              userId: user.id,
              tenantId: loginTenantId,
              ip,
              userAgent,
              channel,
              failReason: tenantAccess.code === "TENANT_DISABLED" ? "tenant_disabled" : "tenant_not_found",
            },
            loginLogFilePath,
          ).catch(() => {});
        }
        res.status(403).json({ error: tenantAccess.message, code: tenantAccess.code });
        return;
      }

      if (!rt.codeService.verifyAndConsume(phone, code)) {
        if (user.role !== "admin") {
          appendLoginLog(
            {
              timestamp: new Date().toISOString(),
              event: "login_fail",
              username: user.username,
              userId: user.id,
              tenantId: loginTenantId,
              ip,
              userAgent,
              channel,
              failReason: "invalid_sms_code",
            },
            loginLogFilePath,
          ).catch(() => {});
        }
        res.status(400).json({ error: "验证码错误或已过期" });
        return;
      }

      if (user.role !== "admin") {
        appendLoginLog(
          {
            timestamp: new Date().toISOString(),
            event: "login_success",
            username: user.username,
            userId: user.id,
            tenantId: loginTenantId,
            ip,
            userAgent,
            channel,
            detail: "sms_login",
          },
          loginLogFilePath,
        ).catch(() => {});
      }

      res.json(buildAuthResponse(user));
    } catch (err) {
      res
        .status(500)
        .json({ error: String(err instanceof Error ? err.message : err) });
    }
  });

  // POST /api/auth/login
  router.post("/login", async (req, res) => {
    try {
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      const userAgent = req.headers["user-agent"] || "unknown";
      const channel = detectLoginChannel(userAgent);

      const rate = checkLoginRate(ip);
      if (!rate.allowed) {
        // admin 用户不记录审计日志
        if (
          userStore.findByUsername(req.body?.username ?? "")?.role !== "admin"
        ) {
          appendLoginLog(
            {
              timestamp: new Date().toISOString(),
              event: "login_fail",
              username: req.body?.username || "unknown",
              tenantId: userStore.findByUsername(req.body?.username ?? "")?.tenantId,
              ip,
              userAgent,
              channel,
              failReason: "rate_limited",
            },
            loginLogFilePath,
          ).catch(() => {});
        }
        res.set("Retry-After", String(rate.retryAfter));
        res
          .status(429)
          .json({ error: `登录尝试过于频繁，请 ${rate.retryAfter} 秒后再试` });
        return;
      }

      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0].message });
        return;
      }
      const { username, password } = parsed.data;
      const user = await userStore.verifyPassword(username, password);
      if (!user) {
        // admin 用户不记录审计日志
        if (userStore.findByUsername(username)?.role !== "admin") {
          appendLoginLog(
            {
              timestamp: new Date().toISOString(),
              event: "login_fail",
              username,
              tenantId: userStore.findByUsername(username)?.tenantId,
              ip,
              userAgent,
              channel,
              failReason: "invalid_credentials",
            },
            loginLogFilePath,
          ).catch(() => {});
        }
        res.status(401).json({ error: "账号或密码错误" });
        return;
      }

      if (user.disabled) {
        // admin 用户不记录审计日志
        if (user.role !== "admin") {
          appendLoginLog(
            {
              timestamp: new Date().toISOString(),
              event: "login_fail",
              username: user.username,
              userId: user.id,
              tenantId: user.tenantId,
              ip,
              userAgent,
              channel,
              failReason: "account_disabled",
            },
            loginLogFilePath,
          ).catch(() => {});
        }
        res.status(403).json({ error: "账号已被禁用", code: "USER_DISABLED" });
        return;
      }

      const loginTenantId = user.tenantId || DEFAULT_TENANT_ID;
      const tenantAccess = checkTenantAccess(tenantStore, loginTenantId);
      if (!tenantAccess.ok) {
        if (user.role !== "admin") {
          appendLoginLog(
            {
              timestamp: new Date().toISOString(),
              event: "login_fail",
              username: user.username,
              userId: user.id,
              tenantId: loginTenantId,
              ip,
              userAgent,
              channel,
              failReason: tenantAccess.code === "TENANT_DISABLED" ? "tenant_disabled" : "tenant_not_found",
            },
            loginLogFilePath,
          ).catch(() => {});
        }
        res.status(403).json({ error: tenantAccess.message, code: tenantAccess.code });
        return;
      }

      // admin 用户不记录审计日志
      if (user.role !== "admin") {
        appendLoginLog(
          {
            timestamp: new Date().toISOString(),
            event: "login_success",
            username: user.username,
            userId: user.id,
            tenantId: loginTenantId,
            ip,
            userAgent,
            channel,
          },
          loginLogFilePath,
        ).catch(() => {});
      }

      res.json(buildAuthResponse(user));
    } catch (err) {
      res
        .status(500)
        .json({ error: String(err instanceof Error ? err.message : err) });
    }
  });

  // GET /api/auth/me
  router.get("/me", (req, res) => {
    const startedAt = Date.now();
    if (!req.user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    const record = userStore.findById(req.user.sub);
    res.json({
      id: req.user.sub,
      username: req.user.username,
      role: req.user.role,
      // 修 BUG #1（2026-06-21）：UserInfo type 定义 tenantId 为 required，但
      // /me handler 原先漏返。前端依赖此字段判断"当前组织"标签 / 是否平台 admin。
      // JWT payload 里有，所以直接透传 req.user.tenantId 即可。
      tenantId: req.user.tenantId,
      // 平台管理员分层治理（2026-07-18）：前端据此渲染平台管理只读模式；权威判定
      // 始终在服务端 enforcePlatformWritePolicy。
      isSuperAdmin: isSuperAdmin(req.user),
      platformCapabilities: getEffectivePlatformCapabilities(req.user),
      platformCapabilityLimits: req.user.platformCapabilityLimits,
      avatar: avatarUrl(req.user.sub, record?.avatar, record?.avatarVersion),
      avatarVersion: record?.avatarVersion,
      debugMode: record?.debugMode === true,
      realName: record?.realName,
      position: record?.position,
      phone: record?.phone,
      phoneVerifiedAt: record?.phoneVerifiedAt,
      createdAt: record?.createdAt,
      createdBy: resolveCreatedBy(record?.createdBy),
      permissions: record?.permissions,
      tenantFeatures: tenantFeatures(req.user.tenantId),
      preferences: record?.preferences ?? {},
    });
    const durationMs = Date.now() - startedAt;
    if (durationMs >= 500) {
      apiLogger.warn(
        `[auth] slow me ${durationMs}ms user=${req.user.username}`,
      );
    }
  });

  // GET /api/auth/users (admin only)
  // PR 5 修 P0-1：组织 admin 只看本组织用户；平台 admin 看全部
  router.get("/users", requireAdmin, async (req, res) => {
    const allUsers = userStore.listAll();
    const scoped = isPlatformAdmin(req.user)
      ? allUsers
      : allUsers.filter((u) => u.tenantId === req.user!.tenantId);
    const canReadPii = isSuperAdmin(req.user);
    const users = scoped.map((u) => ({
      ...u,
      ...(isPlatformAdmin(req.user) && !canReadPii
        ? { phone: maskPhone(u.phone), phoneVerifiedAt: undefined }
        : {}),
      ...(u.role === "admin" && u.tenantId === DEFAULT_TENANT_ID
        ? {
            platformCapabilities: getEffectivePlatformCapabilities({
              sub: u.id,
              username: u.username,
              role: u.role,
              tenantId: u.tenantId,
              platformCapabilities: u.platformCapabilities,
            }),
          }
        : {}),
      avatar: avatarUrl(u.id, u.avatar, u.avatarVersion),
      createdBy: resolveCreatedBy(u.createdBy),
      disabledBy: u.disabledBy ? resolveCreatedBy(u.disabledBy) : undefined,
    }));

    const lastActiveMap = await getLastActivePerUser(loginLogFilePath);

    const usersWithActivity = users.map((u) => {
      const activeInfo = lastActiveMap.get(u.username);
      return {
        ...u,
        lastActiveTime: activeInfo?.lastActive ?? null,
        mobileLastActiveTime: activeInfo?.mobileLastActive ?? null,
      };
    });

    res.json({ users: usersWithActivity });
  });

  // POST /api/auth/users (admin only)
  router.post("/users", requireAdmin, async (req, res) => {
    try {
      const parsed = createUserSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0].message });
        return;
      }
      const {
        username,
        password,
        role,
        realName,
        position,
        dingtalkStaffId,
        debugMode,
        permissions,
        platformCapabilities,
        platformCapabilityLimits,
      } = parsed.data;
      // tenantId 业务规则：
      //   - 平台 admin 可指定任意已存在 tenant；省略默认为 platform admin 的 tenant
      //   - 组织 admin 不能跨组织建用户，强制绑到调用方 tenantId（忽略入参）
      let effectiveTenantId: string;
      if (isPlatformAdmin(req.user)) {
        effectiveTenantId =
          parsed.data.tenantId || req.user!.tenantId || DEFAULT_TENANT_ID;
      } else {
        // 组织 admin：忽略 body.tenantId
        effectiveTenantId = req.user!.tenantId || DEFAULT_TENANT_ID;
      }
      if (
        isPlatformAdmin(req.user)
        && !isSuperAdmin(req.user)
        && effectiveTenantId === DEFAULT_TENANT_ID
      ) {
        res.status(403).json({ error: "平台运营管理员不能创建万神殿账号" });
        return;
      }
      if (
        (platformCapabilities !== undefined || platformCapabilityLimits !== undefined)
        && !isSuperAdmin(req.user)
      ) {
        res.status(403).json({ error: "仅平台超级管理员可配置平台能力" });
        return;
      }
      if (
        (platformCapabilities !== undefined || platformCapabilityLimits !== undefined)
        && (effectiveTenantId !== DEFAULT_TENANT_ID || role !== "admin")
      ) {
        res.status(400).json({ error: "平台能力仅可配置给万神殿管理员" });
        return;
      }
      const capabilityConfigError = validatePlatformCapabilityConfig(
        platformCapabilities,
        platformCapabilityLimits,
      );
      if (capabilityConfigError) {
        res.status(400).json({ error: capabilityConfigError });
        return;
      }
      if (tenantStore) {
        const tenant = tenantStore.findById(effectiveTenantId);
        if (!tenant) {
          res
            .status(400)
            .json({ error: `tenantId "${effectiveTenantId}" 不存在` });
          return;
        }
        if (tenant.disabled) {
          res
            .status(400)
            .json({ error: `tenantId "${effectiveTenantId}" 已禁用` });
          return;
        }
      }
      const policyError = validateTenantUserPolicy(
        tenantStore,
        userStore,
        effectiveTenantId,
        role,
        password,
      );
      if (policyError) {
        res.status(400).json({ error: policyError });
        return;
      }
      const user = await userStore.create({
        username,
        password,
        role,
        tenantId: effectiveTenantId,
        createdBy: req.user!.sub,
        realName,
        position,
        dingtalkStaffId,
        debugMode,
        permissions,
        platformCapabilities: platformCapabilities
          ? normalizePlatformCapabilities(platformCapabilities)
          : undefined,
        platformCapabilityLimits,
      });

      // 注册时立即初始化用户工作区（目录结构 + MEMORY.md）
      const userCwd = resolveUserCwd(agentCwd, {
        id: user.id,
        username: user.username,
        role: user.role as "admin" | "user",
        tenantId: user.tenantId,
      });
      await ensureUserWorkspace(
        userCwd,
        agentCwd,
        sharedDir,
        {
          id: user.id,
          username: user.username,
          role: user.role as "admin" | "user",
          tenantId: user.tenantId,
        },
        { realName, position },
        skillConfigStore,
        tenantSkillsRootDir,
      );

      auditLog(req, "user_created", `${username} (${role})`);
      res.status(201).json({
        ...user,
        avatar: avatarUrl(user.id, user.avatar, user.avatarVersion),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "Username already exists") {
        res.status(409).json({ error: "用户名已存在" });
      } else if (msg === "Phone already exists") {
        res.status(409).json({ error: "手机号已存在" });
      } else {
        res.status(500).json({ error: msg });
      }
    }
  });

  // PATCH /api/auth/users/:id (admin only)
  router.patch("/users/:id", requireAdmin, async (req, res) => {
    try {
      const parsed = updateUserSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0].message });
        return;
      }
      // PR 5 修 P0-1：跨组织写防御
      const target = userStore.findById(req.params.id);
      if (!target) {
        res.status(404).json({ error: "用户不存在" });
        return;
      }
      if (
        !isPlatformAdmin(req.user) &&
        target.tenantId !== req.user!.tenantId
      ) {
        res.status(403).json({ error: "跨组织访问被拒绝" });
        return;
      }
      const peerAdminError = tenantAdminPeerAdminError(req.user, target);
      if (peerAdminError) {
        res.status(403).json({ error: peerAdminError });
        return;
      }
      const platformTargetError = platformOperatorTargetError(req.user, target);
      if (platformTargetError) {
        res.status(403).json({ error: platformTargetError });
        return;
      }
      const destructiveSelfError = selfUpdateError(req.user, target, parsed.data);
      if (destructiveSelfError) {
        res.status(400).json({ error: destructiveSelfError });
        return;
      }
      const {
        password,
        role,
        realName,
        position,
        dingtalkStaffId,
        debugMode,
        permissions,
        platformCapabilities,
        platformCapabilityLimits,
      } = parsed.data;
      if (password && target.id !== req.user!.sub && isPlatformAdmin(req.user)
        && !hasPlatformCapability(req.user, "credential.reset")) {
        res.status(403).json({ error: "当前平台管理员未获授权：credential.reset" });
        return;
      }
      if (
        (platformCapabilities !== undefined || platformCapabilityLimits !== undefined)
        && !isSuperAdmin(req.user)
      ) {
        res.status(403).json({ error: "仅平台超级管理员可配置平台能力" });
        return;
      }
      // tenantId 改动权限：仅平台 admin 可改；其他 role 入参被忽略
      let tenantIdUpdate: string | undefined;
      if (parsed.data.tenantId && isPlatformAdmin(req.user)) {
        if (!isSuperAdmin(req.user) && parsed.data.tenantId !== target.tenantId) {
          res.status(403).json({ error: "仅平台超级管理员可迁移用户组织归属" });
          return;
        }
        if (tenantStore) {
          const tenant = tenantStore.findById(parsed.data.tenantId);
          if (!tenant) {
            res
              .status(400)
              .json({ error: `tenantId "${parsed.data.tenantId}" 不存在` });
            return;
          }
          if (tenant.disabled) {
            res
              .status(400)
              .json({ error: `tenantId "${parsed.data.tenantId}" 已禁用` });
            return;
          }
        }
        tenantIdUpdate = parsed.data.tenantId;
      }
      const effectiveUpdatedTenantId = tenantIdUpdate || target.tenantId;
      const effectiveUpdatedRole = role || target.role;
      if (
        (platformCapabilities !== undefined || platformCapabilityLimits !== undefined)
        && (effectiveUpdatedTenantId !== DEFAULT_TENANT_ID || effectiveUpdatedRole !== "admin")
      ) {
        res.status(400).json({ error: "平台能力仅可配置给万神殿管理员" });
        return;
      }
      const nextPlatformCapabilities = platformCapabilities ?? target.platformCapabilities;
      const nextPlatformCapabilityLimits = platformCapabilityLimits ?? target.platformCapabilityLimits;
      const capabilityConfigError = validatePlatformCapabilityConfig(
        nextPlatformCapabilities,
        nextPlatformCapabilityLimits,
      );
      if (capabilityConfigError) {
        res.status(400).json({ error: capabilityConfigError });
        return;
      }
      const policyError = validateTenantUserPolicy(
        tenantStore,
        userStore,
        effectiveUpdatedTenantId,
        effectiveUpdatedRole as "admin" | "user",
        password,
        target.id,
      );
      if (policyError) {
        res.status(400).json({ error: policyError });
        return;
      }
      const user = await userStore.update(req.params.id, {
        password,
        role,
        realName,
        position,
        dingtalkStaffId,
        debugMode,
        tenantId: tenantIdUpdate,
        permissions: permissions ?? undefined,
        platformCapabilities: platformCapabilities !== undefined
          ? normalizePlatformCapabilities(platformCapabilities)
          : undefined,
        platformCapabilityLimits,
      });
      auditLog(req, "user_updated", user.username);
      res.json({
        ...user,
        avatar: avatarUrl(user.id, user.avatar, user.avatarVersion),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "User not found") {
        res.status(404).json({ error: "用户不存在" });
      } else if (msg === "Phone already exists") {
        res.status(409).json({ error: "手机号已存在" });
      } else {
        res.status(400).json({ error: msg });
      }
    }
  });

  // DELETE /api/auth/users/:id (admin only)
  router.delete("/users/:id", requireAdmin, async (req, res) => {
    try {
      const target = userStore.findById(req.params.id);
      if (!target) {
        res.status(404).json({ error: "用户不存在" });
        return;
      }
      // PR 5 修 P0-1：跨组织删除防御
      if (
        !isPlatformAdmin(req.user) &&
        target.tenantId !== req.user!.tenantId
      ) {
        res.status(403).json({ error: "跨组织访问被拒绝" });
        return;
      }
      if (target.id === req.user!.sub) {
        res.status(400).json({ error: "不能删除自己" });
        return;
      }
      const peerAdminError = tenantAdminPeerAdminError(req.user, target);
      if (peerAdminError) {
        res.status(403).json({ error: peerAdminError });
        return;
      }
      const platformTargetError = platformOperatorTargetError(req.user, target);
      if (platformTargetError) {
        res.status(403).json({ error: platformTargetError });
        return;
      }
      await mcpOAuthService?.disconnectUser(target.username, target.tenantId);
      await userStore.delete(req.params.id);

      // 软删除关联资源（workspace、transcripts、avatars）
      // PR 6 P1-5：透传 target.tenantId 让 cleanup 落对路径
      softDeleteUserResources({
        userId: target.id,
        username: target.username,
        tenantId: target.tenantId,
        agentCwd,
        avatarsDir,
      });

      // 清理 skill 配置中的孤儿条目
      if (deps.skillConfigStore) {
        await deps.skillConfigStore.removeUser(target.username);
      }

      auditLog(req, "user_deleted", target.username);
      res.json({ ok: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "User not found") {
        res.status(404).json({ error: "用户不存在" });
      } else {
        res.status(400).json({ error: msg });
      }
    }
  });

  // PATCH /api/auth/users/:id/status — 禁用/启用用户 (admin only)
  router.patch("/users/:id/status", requireAdmin, async (req, res) => {
    try {
      const { disabled } = req.body;
      if (typeof disabled !== "boolean") {
        res.status(400).json({ error: "disabled 必须是布尔值" });
        return;
      }
      // PR 5 修 P0-1：跨组织禁用/启用防御
      const target = userStore.findById(req.params.id);
      if (!target) {
        res.status(404).json({ error: "用户不存在" });
        return;
      }
      if (
        !isPlatformAdmin(req.user) &&
        target.tenantId !== req.user!.tenantId
      ) {
        res.status(403).json({ error: "跨组织访问被拒绝" });
        return;
      }
      const peerAdminError = tenantAdminPeerAdminError(req.user, target);
      if (peerAdminError) {
        res.status(403).json({ error: peerAdminError });
        return;
      }
      const platformTargetError = platformOperatorTargetError(req.user, target);
      if (platformTargetError) {
        res.status(403).json({ error: platformTargetError });
        return;
      }
      const user = await userStore.setDisabled(
        req.params.id,
        disabled,
        req.user!.sub,
      );
      auditLog(req, disabled ? "user_disabled" : "user_enabled", user.username);
      if (disabled && deps.onUserDisabled) {
        deps.onUserDisabled(req.params.id);
      }
      res.json({
        ...user,
        avatar: avatarUrl(user.id, user.avatar, user.avatarVersion),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "User not found") {
        res.status(404).json({ error: "用户不存在" });
      } else if (msg === "Cannot disable yourself") {
        res.status(400).json({ error: "不能禁用自己" });
      } else if (msg === "Cannot disable the last active admin") {
        res.status(400).json({ error: "不能禁用最后一个活跃管理员" });
      } else {
        res.status(400).json({ error: msg });
      }
    }
  });

  // PATCH /api/auth/password — 修改自己的密码
  router.patch("/password", async (req, res) => {
    try {
      if (!req.user) {
        res.status(401).json({ error: "Not authenticated" });
        return;
      }
      const parsed = changePasswordSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0].message });
        return;
      }
      const { oldPassword, newPassword } = parsed.data;
      const settings = tenantStore?.getSettings(req.user.tenantId);
      const minLength = settings?.security.passwordMinLength;
      if (minLength && newPassword.length < minLength) {
        res.status(400).json({ error: `新密码至少 ${minLength} 个字符` });
        return;
      }
      const ok = await userStore.changePassword(
        req.user.sub,
        oldPassword,
        newPassword,
      );
      if (!ok) {
        res.status(400).json({ error: "当前密码错误" });
        return;
      }
      auditLog(req, "user_password_changed");
      res.json({ success: true });
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : "修改失败" });
    }
  });

  // POST /api/auth/me/phone/send-code — 当前用户绑定/更换手机号前发送验证码
  router.post("/me/phone/send-code", async (req, res) => {
    try {
      if (!req.user) {
        res.status(401).json({ error: "Not authenticated" });
        return;
      }
      const parsed = phoneVerificationSendCodeSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0].message });
        return;
      }
      const { phone } = parsed.data;
      if (phoneBelongsToAnotherUser(phone, req.user.sub)) {
        res.status(409).json({ error: "手机号已存在" });
        return;
      }

      const rt = await getSmsLoginRuntime();
      if (!rt.publicEnabled || !rt.codeService) {
        res.status(403).json({ error: "当前未开放手机号验证" });
        return;
      }
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      if (!rt.sendCodeIpLimiter(ip)) {
        res.status(429).json({ error: "操作过于频繁，请稍后再试" });
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
        `[auth:phone] send-code 失败: ${err instanceof Error ? err.message : String(err)}`,
      );
      res.status(500).json({ error: "验证码发送失败，请稍后再试" });
    }
  });

  // POST /api/auth/me/phone/verify — 当前用户验证并绑定手机号
  router.post("/me/phone/verify", async (req, res) => {
    try {
      if (!req.user) {
        res.status(401).json({ error: "Not authenticated" });
        return;
      }
      const parsed = phoneVerificationSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0].message });
        return;
      }
      const { phone, code } = parsed.data;
      if (phoneBelongsToAnotherUser(phone, req.user.sub)) {
        res.status(409).json({ error: "手机号已存在" });
        return;
      }

      const rt = await getSmsLoginRuntime();
      if (!rt.publicEnabled || !rt.codeService) {
        res.status(403).json({ error: "当前未开放手机号验证" });
        return;
      }
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      if (!rt.loginIpLimiter(ip)) {
        res.status(429).json({ error: "操作过于频繁，请稍后再试" });
        return;
      }
      if (!rt.codeService.verifyAndConsume(phone, code)) {
        res.status(400).json({ error: "验证码错误或已过期" });
        return;
      }
      const phoneVerifiedAt = new Date().toISOString();
      const updated = await userStore.update(req.user.sub, {
        phone,
        phoneVerifiedAt,
      });
      auditLog(req, "user_phone_verified");
      res.json({
        phone: updated.phone ?? null,
        phoneVerifiedAt: updated.phoneVerifiedAt ?? null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "验证失败";
      if (msg === "Phone already exists") {
        res.status(409).json({ error: "手机号已存在" });
        return;
      }
      apiLogger.warn(`[auth:phone] verify 失败: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  // PATCH /api/auth/me/phone — 当前用户清除手机号；绑定/更换手机号必须走验证码验证接口
  router.patch("/me/phone", async (req, res) => {
    try {
      if (!req.user) {
        res.status(401).json({ error: "Not authenticated" });
        return;
      }
      const parsed = updatePhoneSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0].message });
        return;
      }
      if (parsed.data.phone !== "") {
        res.status(400).json({ error: "请先通过验证码完成手机号验证" });
        return;
      }
      const updated = await userStore.update(req.user.sub, {
        phone: parsed.data.phone,
      });
      auditLog(req, "user_phone_updated");
      res.json({ phone: updated.phone ?? null });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "更新失败";
      if (msg === "Phone already exists") {
        res.status(409).json({ error: "手机号已存在" });
        return;
      }
      res.status(500).json({ error: msg });
    }
  });

  // PATCH /api/auth/me/preferences — 当前用户修改自己的界面偏好
  router.patch("/me/preferences", async (req, res) => {
    try {
      if (!req.user) {
        res.status(401).json({ error: "Not authenticated" });
        return;
      }
      const parsed = updatePreferencesSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0].message });
        return;
      }
      const updated = await userStore.updatePreferences(
        req.user.sub,
        parsed.data,
      );
      auditLog(req, "user_updated");
      res.json({ preferences: updated.preferences ?? {} });
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : "更新失败" });
    }
  });

  // POST /api/auth/avatar — 上传当前用户头像
  router.post("/avatar", avatarUploadSingle, async (req, res) => {
    try {
      if (!req.user) {
        res.status(401).json({ error: "Not authenticated" });
        return;
      }
      const file = req.file;
      if (!file) {
        res.status(400).json({ error: "请选择图片文件" });
        return;
      }

      const userId = req.user.sub;
      const ext = extname(file.originalname).toLowerCase() || ".jpg";
      const avatarFilename = `${userId}${ext}`;

      // 删除该用户可能存在的其他扩展名旧头像
      try {
        const files = readdirSync(avatarsDir);
        for (const f of files) {
          if (f.startsWith(userId) && f !== avatarFilename) {
            unlinkSync(join(avatarsDir, f));
          }
        }
      } catch {
        /* ignore cleanup errors */
      }

      const updated = await userStore.update(userId, {
        avatar: `avatars/${avatarFilename}`,
      });
      auditLog(req, "user_avatar_updated");
      res.json({
        avatar: `/api/auth/avatar/${userId}?v=${updated.avatarVersion}`,
        avatarVersion: updated.avatarVersion,
      });
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : "上传失败" });
    }
  });

  // POST /api/auth/users/:id/avatar — admin 修改指定用户头像
  router.post(
    "/users/:id/avatar",
    requireAdmin,
    avatarUploadSingle,
    async (req, res) => {
      try {
        const targetId = req.params.id;
        const target = userStore.findById(targetId);
        if (!target) {
          res.status(404).json({ error: "User not found" });
          return;
        }
        // PR 5 修 P0-1：跨组织改头像防御
        if (
          !isPlatformAdmin(req.user) &&
          target.tenantId !== req.user!.tenantId
        ) {
          res.status(403).json({ error: "跨组织访问被拒绝" });
          return;
        }
        const peerAdminError = tenantAdminPeerAdminError(req.user, target);
        if (peerAdminError) {
          res.status(403).json({ error: peerAdminError });
          return;
        }
        const platformTargetError = platformOperatorTargetError(req.user, target);
        if (platformTargetError) {
          res.status(403).json({ error: platformTargetError });
          return;
        }
        const file = req.file;
        if (!file) {
          res.status(400).json({ error: "请选择图片文件" });
          return;
        }

        const ext = extname(file.originalname).toLowerCase() || ".jpg";
        const avatarFilename = `${targetId}${ext}`;

        // 删除该用户可能存在的其他扩展名旧头像
        try {
          const files = readdirSync(avatarsDir);
          for (const f of files) {
            if (f.startsWith(targetId) && f !== avatarFilename) {
              unlinkSync(join(avatarsDir, f));
            }
          }
        } catch {
          /* ignore cleanup errors */
        }

        const updated = await userStore.update(targetId, {
          avatar: `avatars/${avatarFilename}`,
        });
        auditLog(req, "user_avatar_updated", target.username);
        res.json({
          avatar: `/api/auth/avatar/${targetId}?v=${updated.avatarVersion}`,
          avatarVersion: updated.avatarVersion,
        });
      } catch (err) {
        res
          .status(500)
          .json({ error: err instanceof Error ? err.message : "上传失败" });
      }
    },
  );

  // GET /api/auth/avatar/:userId — 获取用户头像（公开）
  router.get("/avatar/:userId", (req, res) => {
    const record = userStore.findById(req.params.userId);
    if (!record?.avatar) {
      // 返回 204 而非 404，避免用户存在性枚举
      res.status(204).end();
      return;
    }
    const filePath = resolve(avatarsDir, "..", record.avatar);
    if (!existsSync(filePath)) {
      res.status(404).json({ error: "Avatar file not found" });
      return;
    }
    // 带版本号的请求视为不可变资源，长期缓存；否则短期缓存
    if (req.query.v) {
      res.set("Cache-Control", "public, max-age=31536000, immutable");
    } else {
      res.set("Cache-Control", "public, max-age=86400");
    }
    res.sendFile(filePath);
  });

  // POST /api/auth/activity — 客户端上报活动事件（前后台切换、页面浏览等）
  const ALLOWED_ACTIVITY_EVENTS = new Set([
    "app_foreground",
    "app_background",
    "page_viewed",
    "agent_profile_viewed",
    "agent_persona_viewed",
    "agent_memory_viewed",
  ]);
  router.post("/activity", (req, res) => {
    if (!req.user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    const { event, location, detail } = req.body || {};
    if (!ALLOWED_ACTIVITY_EVENTS.has(event)) {
      res.status(400).json({ error: "Invalid event" });
      return;
    }
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const userAgent = req.headers["user-agent"] || "unknown";
    const channel = detectLoginChannel(userAgent);
    // 校验 location 格式
    const loc =
      location &&
      typeof location.latitude === "number" &&
      typeof location.longitude === "number"
        ? { latitude: location.latitude, longitude: location.longitude }
        : undefined;
    // admin 用户不记录审计日志
    if (req.user.role !== "admin") {
      appendLoginLog(
        {
          timestamp: new Date().toISOString(),
          event,
          username: req.user.username,
          userId: req.user.sub,
          tenantId: req.user.tenantId,
          ip,
          userAgent,
          channel,
          ...(loc && { location: loc }),
          ...(detail && typeof detail === "string" ? { detail } : {}),
        },
        loginLogFilePath,
      ).catch(() => {});
    }
    // app_foreground 带版本号时，更新到用户数据
    if (
      event === "app_foreground" &&
      typeof detail === "string" &&
      detail.startsWith("v")
    ) {
      userStore.updateAppVersion(req.user.sub, detail).catch(() => {});
    }
    res.json({ ok: true });
  });

  // GET /api/auth/login-logs (admin only)
  router.get("/login-logs", requireAdmin, async (req, res) => {
    const startedAt = Date.now();
    try {
      const requestedTenantId = req.query.tenantId as string | undefined;
      if (requestedTenantId && !TENANT_SLUG_PATTERN.test(requestedTenantId)) {
        res.status(400).json({ error: "tenantId 不合法" });
        return;
      }
      const tenantId = isPlatformAdmin(req.user)
        ? requestedTenantId
        : req.user?.tenantId;
      const result = await queryLoginLogs(
        {
          tenantId,
          username: (() => {
            const raw = req.query.username as string | undefined;
            if (!raw) return undefined;
            if (raw.includes(",")) return raw.split(",").filter(Boolean);
            return raw;
          })(),
          event: req.query.event as LoginEvent | undefined,
          category: req.query.category as string | undefined,
          channel: req.query.channel as LoginChannel | undefined,
          startTime: req.query.startTime as string | undefined,
          endTime: req.query.endTime as string | undefined,
          offset: req.query.offset
            ? parseInt(req.query.offset as string, 10)
            : undefined,
          limit: req.query.limit
            ? parseInt(req.query.limit as string, 10)
            : undefined,
        },
        loginLogFilePath,
      );
      const durationMs = Date.now() - startedAt;
      if (durationMs >= 500) {
        apiLogger.warn(
          `[auth] slow login-logs ${durationMs}ms total=${result.total} limit=${req.query.limit ?? "default"} offset=${req.query.offset ?? 0}`,
        );
      }
      res.json(result);
    } catch (err) {
      res
        .status(500)
        .json({ error: String(err instanceof Error ? err.message : err) });
    }
  });

  // DELETE /api/auth/login-logs
  // 2026-07-18 收紧：清空审计日志属超敏感操作，@admin 独占（此前仅 requireAdmin
  // 且无租户过滤，任何组织 admin 可清全局日志，属跨租户写漏洞）。
  router.delete("/login-logs", requireSuperAdmin, async (req, res) => {
    try {
      const beforeDate = req.query.before as string | undefined;
      const excludeUsername = req.query.excludeUsername as string | undefined;
      const result = await clearLoginLogs(loginLogFilePath, {
        beforeDate,
        excludeUsername,
      });
      res.json(result);
    } catch (err) {
      res
        .status(500)
        .json({ error: String(err instanceof Error ? err.message : err) });
    }
  });

  return router;
}

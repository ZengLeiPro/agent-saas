import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { Router } from "express";
import jwt, { type SignOptions } from "jsonwebtoken";
import multer from "multer";
import { z } from "zod";
import {
  requireAdmin,
  requirePlatformAdmin,
  isPlatformAdmin,
} from "../auth/middleware.js";
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

// ---- Zod schemas ----

const loginSchema = z.object({
  username: z.string().min(1, "用户名不能为空"),
  password: z.string().min(1, "密码不能为空"),
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
});

const changePasswordSchema = z.object({
  oldPassword: z.string().min(1, "请输入当前密码"),
  newPassword: z.string().min(6, "新密码至少 6 个字符"),
});

// PATCH /me/phone：空字符串 = 清除手机号；非空必须匹配中国大陆 11 位号码格式。
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
      (v) => v === "" || /^1[3-9]\d{9}$/.test(v),
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
});

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
              ip,
              userAgent,
              channel,
              failReason: "invalid_credentials",
            },
            loginLogFilePath,
          ).catch(() => {});
        }
        res.status(401).json({ error: "用户名或密码错误" });
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
            ip,
            userAgent,
            channel,
          },
          loginLogFilePath,
        ).catch(() => {});
      }

      const token = jwt.sign(
        {
          sub: user.id,
          username: user.username,
          role: user.role,
          tenantId: user.tenantId || DEFAULT_TENANT_ID,
        },
        jwtSecret,
        { expiresIn: tokenExpiresIn } as SignOptions,
      );
      res.json({
        token,
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          // 同 /me BUG #1：AuthUser 定义 tenantId 为 required，登录响应也必须返回，
          // 前端 AuthContext 据此判定平台 admin / 组织 admin。
          tenantId: user.tenantId || DEFAULT_TENANT_ID,
          realName: user.realName,
          position: user.position,
          phone: user.phone,
          avatar: avatarUrl(user.id, user.avatar, user.avatarVersion),
          avatarVersion: user.avatarVersion,
          debugMode: user.debugMode === true,
          tenantFeatures: tenantFeatures(user.tenantId || DEFAULT_TENANT_ID),
          preferences: user.preferences ?? {},
        },
      });
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
      avatar: avatarUrl(req.user.sub, record?.avatar, record?.avatarVersion),
      avatarVersion: record?.avatarVersion,
      debugMode: record?.debugMode === true,
      realName: record?.realName,
      position: record?.position,
      phone: record?.phone,
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
    const users = scoped.map((u) => ({
      ...u,
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
      } = parsed.data;
      // tenantId 改动权限：仅平台 admin 可改；其他 role 入参被忽略
      let tenantIdUpdate: string | undefined;
      if (parsed.data.tenantId && isPlatformAdmin(req.user)) {
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

  // PATCH /api/auth/me/phone — 当前用户修改自己的手机号
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
      const updated = await userStore.update(req.user.sub, {
        phone: parsed.data.phone,
      });
      auditLog(req, "user_phone_updated");
      res.json({ phone: updated.phone ?? null });
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : "更新失败" });
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
  router.post("/avatar", avatarUpload.single("avatar"), async (req, res) => {
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
    avatarUpload.single("avatar"),
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
      const result = await queryLoginLogs(
        {
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

  // DELETE /api/auth/login-logs (admin only)
  router.delete("/login-logs", requireAdmin, async (req, res) => {
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

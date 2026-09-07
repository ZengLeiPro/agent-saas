import type { Request, Router } from "express";
import { z } from "zod";

import { isPlatformAdmin, requireAdmin } from "../auth/middleware.js";
import type { AuthEpochAuthority } from "../auth/authEpochAuthority.js";
import type { JwtPayload } from "../auth/types.js";
import { appendLoginLog, auditLog, detectLoginChannel } from "../data/login-logs/index.js";
import type { TenantStore } from "../data/tenants/store.js";
import { DEFAULT_TENANT_ID } from "../data/tenants/types.js";
import type { UserStore } from "../data/users/store.js";
import type { UserInfo, UserRecord } from "../data/users/types.js";
import { createIpLimiter } from "../integrations/sms/configuredSms.js";
import type { VerificationCodeService } from "../integrations/sms/verificationService.js";
import { apiLogger } from "../utils/logger.js";
import { checkTenantAccess } from "../data/tenants/access.js";

const PHONE_PATTERN = /^1[3-9]\d{9}$/;

const resetPasswordSendCodeSchema = z.object({
  phone: z.string().regex(PHONE_PATTERN, "请输入有效的 11 位手机号"),
});

const resetPasswordSchema = z.object({
  phone: z.string().regex(PHONE_PATTERN, "请输入有效的 11 位手机号"),
  code: z.string().regex(/^\d{6}$/, "验证码为 6 位数字"),
  newPassword: z.string().min(6, "新密码至少 6 个字符"),
});

const adminResetPasswordSchema = z.object({
  newPassword: z.string().min(6, "新密码至少 6 个字符"),
});

interface SmsRuntime {
  publicEnabled: boolean;
  codeService?: VerificationCodeService;
  sendCodeIpLimiter: (ip: string) => boolean;
  loginIpLimiter: (ip: string) => boolean;
}

type ResolvedSmsUser =
  | { ok: true; user: UserRecord }
  | { ok: false; status: number; error: string; code?: string };

interface PasswordSessionDeps {
  authEpochAuthority?: AuthEpochAuthority;
  onAuthFenced?: (userId: string, reason: "revoke") => void | Promise<void>;
}

interface PasswordResetRouteDeps extends PasswordSessionDeps {
  userStore: UserStore;
  tenantStore?: TenantStore;
  membershipStore?: { getMembership(tenantId: string, userId: string): Promise<{ persona: "member" | "org_admin" } | null> };
  loginLogFilePath: string;
  getSmsRuntime: () => Promise<SmsRuntime>;
  resolveSmsUser: (phone: string) => ResolvedSmsUser;
}

type MembershipReader = PasswordResetRouteDeps["membershipStore"];

export async function adminPasswordResetTargetError(
  caller: JwtPayload | undefined,
  target: Pick<UserRecord, "id" | "role" | "tenantId">,
  membershipStore: MembershipReader,
): Promise<string | null> {
  if (!caller || isPlatformAdmin(caller) || target.id === caller.sub) return null;
  const targetMembership = await membershipStore?.getMembership(target.tenantId, target.id);
  const targetIsOrganizationAdmin = targetMembership
    ? targetMembership.persona === "org_admin"
    : target.role === "admin";
  return targetIsOrganizationAdmin ? "组织管理员不能管理其他管理员" : null;
}

async function revokeAllUserSessions(deps: PasswordSessionDeps, userId: string): Promise<void> {
  if (!deps.authEpochAuthority) return;
  deps.authEpochAuthority.fence(userId, "revoke");
  try {
    await deps.onAuthFenced?.(userId, "revoke");
  } catch (err) {
    apiLogger.warn(
      `[auth:password-reset] 断开用户连接失败 userId=${userId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function finalizeLegacyPasswordReset(
  req: Request,
  user: UserInfo,
  password: string | undefined,
  deps: PasswordSessionDeps,
): Promise<void> {
  if (!password) return;
  await revokeAllUserSessions(deps, user.id);
  auditLog(req, "user_password_changed", `管理员重置 ${user.username} 的密码`);
}

export function registerPasswordResetRoutes(
  router: Router,
  deps: PasswordResetRouteDeps,
): void {
  const phoneLimiter = createIpLimiter(1, 60_000);

  router.post("/password/reset/send-code", async (req, res) => {
    try {
      const runtime = await deps.getSmsRuntime();
      if (!runtime.publicEnabled || !runtime.codeService) {
        res.status(403).json({ error: "当前未开放短信密码找回" });
        return;
      }
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      if (!runtime.sendCodeIpLimiter(ip)) {
        res.status(429).json({ error: "操作过于频繁，请稍后再试" });
        return;
      }
      const parsed = resetPasswordSendCodeSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0].message });
        return;
      }
      const { phone } = parsed.data;
      if (!phoneLimiter(phone)) {
        res.status(429).json({ error: "操作过于频繁，请稍后再试" });
        return;
      }
      const resolved = deps.resolveSmsUser(phone);
      if (!resolved.ok || resolved.user.disabled) {
        res.json({ ok: true });
        return;
      }
      const tenantAccess = checkTenantAccess(
        deps.tenantStore,
        resolved.user.tenantId || DEFAULT_TENANT_ID,
      );
      if (!tenantAccess.ok) {
        res.json({ ok: true });
        return;
      }
      await runtime.codeService.requestCode(phone, "password-reset");
      res.json({ ok: true });
    } catch (err) {
      apiLogger.warn(
        `[auth:password-reset] send-code 失败: ${err instanceof Error ? err.message : String(err)}`,
      );
      res.json({ ok: true });
    }
  });

  router.post("/password/reset", async (req, res) => {
    try {
      const runtime = await deps.getSmsRuntime();
      if (!runtime.publicEnabled || !runtime.codeService) {
        res.status(403).json({ error: "当前未开放短信密码找回" });
        return;
      }
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      if (!runtime.loginIpLimiter(ip)) {
        res.status(429).json({ error: "操作过于频繁，请稍后再试" });
        return;
      }
      const parsed = resetPasswordSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0].message });
        return;
      }
      const { phone, code, newPassword } = parsed.data;
      const resolved = deps.resolveSmsUser(phone);
      if (!resolved.ok || resolved.user.disabled) {
        res.status(400).json({ error: "手机号、验证码或账号状态有误" });
        return;
      }
      const user = resolved.user;
      const tenantAccess = checkTenantAccess(
        deps.tenantStore,
        user.tenantId || DEFAULT_TENANT_ID,
      );
      if (!tenantAccess.ok) {
        res.status(400).json({ error: "手机号、验证码或账号状态有误" });
        return;
      }
      if (!runtime.codeService.verify(phone, code, "password-reset")) {
        res.status(400).json({ error: "手机号、验证码或账号状态有误" });
        return;
      }
      const minLength = deps.tenantStore?.getSettings(user.tenantId)?.security.passwordMinLength;
      if (minLength && newPassword.length < minLength) {
        res.status(400).json({ error: `新密码至少 ${minLength} 个字符` });
        return;
      }
      if (!runtime.codeService.verifyAndConsume(phone, code, "password-reset")) {
        res.status(400).json({ error: "手机号、验证码或账号状态有误" });
        return;
      }
      await deps.userStore.resetPassword(user.id, newPassword);
      await revokeAllUserSessions(deps, user.id);
      appendLoginLog({
        timestamp: new Date().toISOString(),
        event: "user_password_changed",
        username: user.username,
        userId: user.id,
        tenantId: user.tenantId,
        ip,
        userAgent: req.headers["user-agent"] || "unknown",
        channel: detectLoginChannel(req.headers["user-agent"] || ""),
        detail: "self_service_reset",
      }, deps.loginLogFilePath).catch(() => {});
      res.json({ ok: true });
    } catch (err) {
      apiLogger.warn(
        `[auth:password-reset] reset 失败: ${err instanceof Error ? err.message : String(err)}`,
      );
      res.status(500).json({ error: "密码重置失败，请稍后再试" });
    }
  });

  router.patch("/users/:id/password", requireAdmin, async (req, res) => {
    try {
      const parsed = adminResetPasswordSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0].message });
        return;
      }
      const target = deps.userStore.findById(req.params.id);
      if (!target) {
        res.status(404).json({ error: "用户不存在" });
        return;
      }
      const caller = req.user as JwtPayload;
      if (!isPlatformAdmin(caller) && target.tenantId !== caller.tenantId) {
        res.status(403).json({ error: "跨组织访问被拒绝" });
        return;
      }
      const targetError = await adminPasswordResetTargetError(caller, target, deps.membershipStore);
      if (targetError) {
        res.status(403).json({ error: targetError });
        return;
      }
      const minLength = deps.tenantStore?.getSettings(target.tenantId)?.security.passwordMinLength;
      if (minLength && parsed.data.newPassword.length < minLength) {
        res.status(400).json({ error: `密码至少 ${minLength} 个字符` });
        return;
      }
      await deps.userStore.resetPassword(target.id, parsed.data.newPassword);
      await revokeAllUserSessions(deps, target.id);
      auditLog(req, "user_password_changed", `管理员重置 ${target.username} 的密码`);
      res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "User not found") {
        res.status(404).json({ error: "用户不存在" });
        return;
      }
      res.status(500).json({ error: "密码重置失败，请稍后再试" });
    }
  });
}

import { isDebugModeAvailable } from "../../../shared/src/types/tenant.js";
import type { TenantStore } from "../data/tenants/store.js";
import type { UserStore } from "../data/users/store.js";

export function validateTenantUserPolicy(
  tenantStore: TenantStore | undefined,
  userStore: UserStore,
  tenantId: string,
  role: "admin" | "user",
  password?: string,
  debugMode?: boolean,
  excludeUserId?: string,
): string | null {
  const settings = tenantStore?.getSettings(tenantId);
  if (!settings) return null;
  if (debugMode === true && !isDebugModeAvailable(tenantId, settings.features)) {
    return "上级未开放调试模式，不能为成员开启";
  }
  const minLength = settings.security.passwordMinLength;
  if (password && minLength && password.length < minLength) {
    return `密码至少 ${minLength} 个字符`;
  }
  const tenantUsers = userStore
    .listAll()
    .filter((user) => user.tenantId === tenantId && user.id !== excludeUserId);
  if (
    settings.quotas.maxUsers &&
    tenantUsers.length + 1 > settings.quotas.maxUsers
  ) {
    return `组织用户数已达到上限 ${settings.quotas.maxUsers}`;
  }
  if (role === "admin") {
    const adminCount = tenantUsers.filter((user) => user.role === "admin").length;
    if (
      settings.quotas.maxAdmins &&
      adminCount + 1 > settings.quotas.maxAdmins
    ) {
      return `组织管理员数已达到上限 ${settings.quotas.maxAdmins}`;
    }
  }
  return null;
}

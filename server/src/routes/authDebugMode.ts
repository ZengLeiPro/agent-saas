import type { Router } from "express";
import { z } from "zod";

import { isDebugModeAvailable } from "../../../shared/src/types/tenant.js";
import { auditLog } from "../data/login-logs/index.js";
import type { TenantStore } from "../data/tenants/store.js";
import { DEFAULT_TENANT_SETTINGS } from "../data/tenants/types.js";
import type { UserStore } from "../data/users/store.js";
import { withTenantDebugModeLock } from "../data/tenants/debugModeLock.js";

const updateDebugModeSchema = z.object({
  debugMode: z.boolean(),
}).strict();

export function registerAuthDebugModeRoute(
  router: Router,
  deps: { userStore: UserStore; tenantStore?: TenantStore },
): void {
  const tenantFeatures = (tenantId: string) => (
    deps.tenantStore?.getSettings(tenantId)?.features ?? DEFAULT_TENANT_SETTINGS.features
  );

  router.patch("/me/debug-mode", async (req, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      const parsed = updateDebugModeSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "请求无效" });
      const current = deps.userStore.findById(req.user.sub);
      if (!current) return res.status(404).json({ error: "用户不存在" });
      return withTenantDebugModeLock(current.tenantId, async () => {
        const features = tenantFeatures(current.tenantId);
        if (parsed.data.debugMode && !isDebugModeAvailable(current.tenantId, features)) {
          return res.status(400).json({ error: "上级未开放调试模式，不能为本人开启" });
        }
        const updated = await deps.userStore.update(current.id, { debugMode: parsed.data.debugMode });
        const effectiveDebugMode = updated.debugMode === true
          && isDebugModeAvailable(updated.tenantId, tenantFeatures(updated.tenantId));
        auditLog(req, "user_updated", "debugMode");
        return res.json({
          debugMode: effectiveDebugMode,
          tenantFeatures: tenantFeatures(updated.tenantId),
        });
      });
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : "更新失败" });
    }
  });
}

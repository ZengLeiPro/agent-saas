import { Router } from "express";
import type { Request, Response } from "express";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

import type { UserStore } from "../data/users/store.js";
import {
  sanitizeCustomerFacingText,
} from "../../../shared/src/security/sanitizeCustomerFacingText.js";
import {
  scenarioLibraryFileSchema,
} from "../../../shared/src/schemas/roleKit.js";
import type { ScenarioRole } from "../../../shared/src/types/scenario.js";

const DEFAULT_DATA_PATH = resolve(
  import.meta.dirname,
  "../data/scenarios/scenario-library-v1.json",
);

const switchRoleSchema = z.object({
  roleId: z.string().min(1),
});

export interface UserRoleRouterOptions {
  userStore: UserStore;
  dataPath?: string;
}

async function loadRoles(dataPath: string): Promise<ScenarioRole[]> {
  const raw = JSON.parse(await readFile(dataPath, "utf-8")) as unknown;
  const parsed = scenarioLibraryFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`scenario-library validation failed: ${parsed.error.issues[0]?.message ?? "unknown"}`);
  }
  return [...parsed.data.roles].sort((a, b) => a.sort - b.sort) as ScenarioRole[];
}

function pickWelcomeMessage(role: ScenarioRole): string | null {
  const message = role.roleWelcomeMessage;
  if (!message) return null;
  if (typeof message === "string") return sanitizeCustomerFacingText(message).output;
  return sanitizeCustomerFacingText(message.default ?? message.internal ?? message.export ?? "").output || null;
}

export function createUserRoleRouter(options: UserRoleRouterOptions): Router {
  const router = Router();
  const dataPath = options.dataPath ?? DEFAULT_DATA_PATH;
  let roleCache: ScenarioRole[] | null = null;

  async function getRoles(): Promise<ScenarioRole[]> {
    roleCache ??= await loadRoles(dataPath);
    return roleCache;
  }

  router.get("/available-roles", async (req: Request, res: Response) => {
    if (!req.user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    try {
      const roles = await getRoles();
      const availableRoleIds = roles.map((role) => role.id);
      const record = options.userStore.findById(req.user.sub);
      const active = record?.preferences?.activeRoleId;
      res.json({
        availableRoleIds,
        activeRoleId: active && availableRoleIds.includes(active) ? active : (availableRoleIds[0] ?? null),
      });
    } catch (err) {
      res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
    }
  });

  router.post("/switch-role", async (req: Request, res: Response) => {
    if (!req.user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const parsed = switchRoleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });
      return;
    }
    try {
      const roles = await getRoles();
      const role = roles.find((item) => item.id === parsed.data.roleId);
      if (!role) {
        res.status(400).json({ error: "role_not_available" });
        return;
      }
      const updated = await options.userStore.updatePreferences(req.user.sub, {
        activeRoleId: role.id,
      });
      res.json({
        activeRoleId: role.id,
        welcomeMessage: pickWelcomeMessage(role),
        preferences: updated.preferences ?? {},
      });
    } catch (err) {
      res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
    }
  });

  return router;
}

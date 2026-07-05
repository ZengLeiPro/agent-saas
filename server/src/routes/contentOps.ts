import { Router } from "express";
import type { Request, Response } from "express";

import { requirePlatformAdmin } from "../auth/middleware.js";
import {
  sanitizeRole,
  sanitizeScenario,
} from "../../../shared/src/security/sanitizeCustomerFacingText.js";

export function createContentOpsRouter(): Router {
  const router = Router();

  router.post("/scenarios/preview", requirePlatformAdmin, (req: Request, res: Response) => {
    const draft = req.body as Record<string, unknown>;
    const report = draft.roleTopPains || draft.roleP0DataSources || draft.roleWelcomeMessage
      ? sanitizeRole(draft)
      : sanitizeScenario(draft);
    res.json({
      safeToPublish: report.safeToPublish,
      scenario: report.scenario,
      hits: report.hits,
      blocked: report.blocked,
    });
  });

  return router;
}

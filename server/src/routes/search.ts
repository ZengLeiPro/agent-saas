import { Router } from "express";
import type { Request, Response } from "express";
import type { UserStore } from "../data/users/store.js";
import { createSessionSearchService } from "../search/service.js";

export interface SearchRouterOptions {
  agentCwd: string;
  userStore?: UserStore;
}

export function createSearchRouter(options: SearchRouterOptions): Router {
  const router = Router();
  const service = createSessionSearchService(options);

  router.get("/sessions", async (req: Request, res: Response) => {
    try {
      const q = typeof req.query.q === "string" ? req.query.q : "";
      const limit = typeof req.query.limit === "string"
        ? Number.parseInt(req.query.limit, 10)
        : undefined;
      const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;

      const result = await service.searchSessions(
        { user: req.user },
        { q, limit, cursor },
      );
      res.json(result);
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      if (msg.includes("outside allowed directory")) {
        res.status(403).json({ error: msg });
        return;
      }
      res.status(500).json({ error: msg });
    }
  });

  return router;
}

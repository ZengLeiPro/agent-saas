import type { Request, RequestHandler, Response } from "express";

import { isValidSessionId } from "../data/transcripts/index.js";

type SessionAccessResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

export function createSessionWarmupHandler(options: {
  readAccessibleSessionMetaForRequest: (
    req: Request,
    sessionId: string,
  ) => Promise<SessionAccessResult>;
  sandboxWarmup?: (sessionId: string) => void;
}): RequestHandler {
  return async (req: Request, res: Response) => {
    try {
      const { sessionId } = req.params;
      if (!isValidSessionId(sessionId)) {
        res.status(400).json({ error: "Invalid sessionId format" });
        return;
      }

      const accessible = await options.readAccessibleSessionMetaForRequest(req, sessionId);
      if (!accessible.ok) {
        res.status(accessible.status).json({ error: accessible.error });
        return;
      }

      options.sandboxWarmup?.(sessionId);
      res.status(202).json({ status: "accepted" });
    } catch (err) {
      res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
    }
  };
}

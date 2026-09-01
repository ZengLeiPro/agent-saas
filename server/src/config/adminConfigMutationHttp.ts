import type { Request, Response } from 'express';

import { ConfigConflictError } from './adminConfigMutationService.js';

export function mutationRequestContext(req: Request): {
  actor: string;
  expectedFingerprint?: string;
} {
  const raw = req.header('if-match')?.trim().replace(/^W\//u, '').replace(/^"|"$/gu, '');
  return {
    actor: req.user?.username ?? req.user?.sub ?? 'platform-admin',
    ...(raw ? { expectedFingerprint: raw } : {}),
  };
}

export function sendConfigMutationError(res: Response, error: unknown): void {
  if (error instanceof ConfigConflictError) {
    res.status(409).json({
      error: error.message,
      code: error.code,
      effectiveConfigFingerprint: error.currentFingerprint,
    });
    return;
  }
  res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
}

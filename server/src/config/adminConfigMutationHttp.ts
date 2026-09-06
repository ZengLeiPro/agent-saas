import type { Request, Response } from 'express';

import {
  ConfigConflictError,
  ProductionConfigPublishRequiredError,
} from './adminConfigMutationService.js';
import {
  CapabilityEnableError,
  capabilityEnableHttpStatus,
} from './capabilityEnableTransaction.js';

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

/**
 * 能力启用失败的统一出口。错误码是契约的一部分：绕过前端直接调保存接口时，
 * 调用方要能从码上区分「配置不全」「缺 Secret」「探测失败」「运行未就绪」
 * 「指纹冲突」和「需要审批」，而不是只拿到一个 500。
 */
export function sendCapabilityEnableError(res: Response, error: unknown): void {
  if (!(error instanceof CapabilityEnableError)) {
    sendConfigMutationError(res, error);
    return;
  }
  res.status(capabilityEnableHttpStatus(error.code)).json({
    error: error.message,
    code: error.code,
    ...error.details,
  });
}

export function sendConfigMutationError(res: Response, error: unknown): void {
  if (error instanceof ProductionConfigPublishRequiredError) {
    res.status(409).json({ error: error.message, code: error.code });
    return;
  }
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

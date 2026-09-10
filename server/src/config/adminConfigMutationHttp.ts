import type { Request, Response } from 'express';
import { readFileSync } from 'node:fs';

import { getAppConfigPath } from '../app/config.js';
import { configRevision } from '../routes/configWriteLock.js';
import type { AdminConfigMutationService } from './adminConfigMutationService.js';

import {
  ConfigConflictError,
  ConfigMutationCommittedError,
  RuntimeRestoreFailedError,
  ProductionConfigPublishRequiredError,
  ProductionConfirmationError,
} from './adminConfigMutationService.js';
import {
  AdminConfigOperationConflictError,
  AdminConfigOperationPendingError,
} from './adminConfigOperationJournal.js';
import {
  CapabilityEnableError,
  capabilityEnableHttpStatus,
} from './capabilityEnableTransaction.js';

export function mutationRequestContext(req: Request): {
  actor: string;
  expectedFingerprint?: string;
  expectedRevision?: string;
  productionConfirmation?: string;
  operationId?: string;
  requestSemantic: unknown;
} {
  const ifMatchRevision = req.header('if-match')?.trim().replace(/^W\//u, '').replace(/^"|"$/gu, '');
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {};
  const headerRevision = req.header('x-config-revision')?.trim();
  const bodyRevision = typeof body.expectedRevision === 'string' ? body.expectedRevision.trim() : undefined;
  if ((headerRevision && bodyRevision && headerRevision !== bodyRevision)
    || (ifMatchRevision && (headerRevision || bodyRevision) && ifMatchRevision !== (headerRevision ?? bodyRevision))) {
    throw new ConfigConflictError('', headerRevision ?? bodyRevision ?? ifMatchRevision);
  }
  const headerFingerprint = req.header('x-config-fingerprint')?.trim();
  const bodyFingerprint = typeof body.expectedFingerprint === 'string' ? body.expectedFingerprint.trim() : undefined;
  if (headerFingerprint && bodyFingerprint && headerFingerprint !== bodyFingerprint) {
    throw new ConfigConflictError(headerFingerprint, headerRevision ?? bodyRevision ?? ifMatchRevision);
  }
  const headerConfirmation = req.header('x-production-confirmation')?.trim();
  const bodyConfirmation = typeof body.productionConfirmation === 'string'
    ? body.productionConfirmation.trim()
    : undefined;
  if (headerConfirmation && bodyConfirmation && headerConfirmation !== bodyConfirmation) {
    throw new ProductionConfirmationError();
  }
  const operationId = req.header('x-config-operation-id')?.trim()
    ?? (typeof body.operationId === 'string' ? body.operationId.trim() : undefined);
  return {
    actor: req.user?.username ?? req.user?.sub ?? 'platform-admin',
    ...((headerFingerprint || bodyFingerprint) ? { expectedFingerprint: headerFingerprint ?? bodyFingerprint } : {}),
    ...((headerRevision || bodyRevision || ifMatchRevision)
      ? { expectedRevision: headerRevision ?? bodyRevision ?? ifMatchRevision }
      : {}),
    ...((headerConfirmation || bodyConfirmation)
      ? { productionConfirmation: headerConfirmation ?? bodyConfirmation }
      : {}),
    ...(operationId ? { operationId } : {}),
    requestSemantic: {
      method: req.method,
      params: req.params,
      body: mutationBusinessBody(req),
    },
  };
}

const CONTROL_FIELDS = new Set(['expectedRevision', 'expectedFingerprint', 'productionConfirmation', 'operationId']);

/** strict 业务 schema 只接收业务字段，控制元信息由 mutationRequestContext 单独校验。 */
export function mutationBusinessBody(req: Request): Record<string, unknown> {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {};
  return Object.fromEntries(Object.entries(body).filter(([key]) => !CONTROL_FIELDS.has(key)));
}

export function adminConfigReadMetadata(
  processCwd: string,
  service: AdminConfigMutationService,
): { revision: string; writePolicy: ReturnType<AdminConfigMutationService['getWritePolicy']> } {
  const text = readFileSync(getAppConfigPath(processCwd), 'utf8');
  return { revision: configRevision(text), writePolicy: service.getWritePolicy() };
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
  if (error instanceof AdminConfigOperationConflictError) {
    res.status(409).json({ code: error.code, error: error.message });
    return;
  }
  if (error instanceof AdminConfigOperationPendingError) {
    res.status(409).json({ code: error.code, error: error.message, operationState: error.state });
    return;
  }
  if (error instanceof ConfigMutationCommittedError) {
    res.status(500).json({ code: error.code, error: error.message });
    return;
  }
  if (error instanceof RuntimeRestoreFailedError) {
    res.status(500).json({ code: error.code, error: error.message });
    return;
  }
  if (error instanceof ProductionConfigPublishRequiredError) {
    res.status(409).json({ error: error.message, code: error.code, writePolicy: error.writePolicy });
    return;
  }
  if (error instanceof ProductionConfirmationError) {
    res.status(409).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof ConfigConflictError) {
    res.status(409).json({
      error: error.message,
      code: error.code,
      effectiveConfigFingerprint: error.currentFingerprint,
      ...(error.currentRevision ? { revision: error.currentRevision } : {}),
    });
    return;
  }
  res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
}

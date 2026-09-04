import type { RequestHandler } from 'express';
import { isSkillSelectionPreferenceWrite } from './skillSelection.js';

interface LegacySkillWriteGate {
  assertLegacyWriteAllowed(input: {
    actor: 'user' | 'service';
    compatibilityProjection: boolean;
  }): Promise<void>;
}

function isGovernanceNativeWrite(method: string, path: string): boolean {
  if (isSkillSelectionPreferenceWrite(method, path)) return true;
  if (
    /^(?:PUT \/me\/skills\/[^/]+\/document|DELETE \/me\/skills\/[^/]+)$/.test(`${method} ${path}`)
  )
    return true;
  return /^(?:PUT|DELETE) \/(?:pool\/[^/]+|tenants\/[^/]+\/(?:pool|skills)\/[^/]+)\/presentation$/.test(
    `${method} ${path}`,
  );
}

export function createSkillLegacyWriteGate(gate?: LegacySkillWriteGate): RequestHandler {
  return async (req, res, next) => {
    const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
    if (
      !isMutation ||
      isGovernanceNativeWrite(req.method, req.path) ||
      req.path === '/sync' ||
      !gate
    )
      return next();
    try {
      await gate.assertLegacyWriteAllowed({ actor: 'user', compatibilityProjection: false });
      next();
    } catch {
      res.status(409).json({
        error: '旧版 Skill 写入口已封闭，请使用治理资源 API',
        code: 'MIGRATION_LEGACY_WRITE_SEALED',
      });
    }
  };
}

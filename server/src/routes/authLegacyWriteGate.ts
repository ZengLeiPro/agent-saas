import type { RequestHandler } from 'express';

export interface LegacyAuthWriteGate {
  assertLegacyWriteAllowed(input: {
    actor: 'user' | 'service';
    compatibilityProjection: boolean;
  }): Promise<void>;
}

export interface LegacyAuthWriteGateDeps {
  legacyWriteGate?: LegacyAuthWriteGate;
}

function isGovernedLegacyIdentityMutation(path: string, method: string, body: unknown): boolean {
  const usersMutation = path === '/users' && method === 'POST';
  const userDelete = /^\/users\/[^/]+$/.test(path) && method === 'DELETE';
  const identityPatch = /^\/users\/[^/]+$/.test(path)
    && method === 'PATCH'
    && typeof body === 'object'
    && body !== null
    && ('role' in body || 'tenantId' in body);
  const statusPatch = /^\/users\/[^/]+\/status$/.test(path) && method === 'PATCH';
  return usersMutation || userDelete || identityPatch || statusPatch;
}

/** Fail closed once governance seals legacy User/Membership identity writes. */
export function createLegacyAuthWriteGate(gate: LegacyAuthWriteGate | undefined): RequestHandler {
  return async (req, res, next) => {
    if (!gate || !isGovernedLegacyIdentityMutation(req.path, req.method, req.body)) {
      next();
      return;
    }
    try {
      await gate.assertLegacyWriteAllowed({ actor: 'user', compatibilityProjection: false });
      next();
    } catch {
      res.status(409).json({
        error: '旧版用户身份与 Membership 写入口已封闭，请使用治理 API',
        code: 'MIGRATION_LEGACY_WRITE_SEALED',
      });
    }
  };
}

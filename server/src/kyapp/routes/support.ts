/**
 * WP2a 路由公用件：错误体、请求 id、鉴权判定。
 *
 * 错误体一律用附录 D 的形态 `{ ok:false, error:{ code, retryable, message, requestId } }`。
 * 附录 D 的 `code` 枚举是**定制项目可发出**的集合；平台管理端点还需要
 * `review_required` / `conflict` 之类的自有 code，因此这里另立一张状态映射表，
 * 只复用形态、不复用枚举（见基线偏差记录）。
 *
 * `message` 只进日志与平台管理界面，客户面文案由前端按 `code` 渲染；
 * 一律不写「上游」二字（施工总则 §3.5）。
 */
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';

import { isPlatformAdmin, type JwtPayload } from '../../auth/types.js';

/** 平台端点自有错误码 → HTTP 状态。 */
export const KY_APP_ERROR_STATUS: Readonly<Record<string, number>> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  invalid_input: 400,
  conflict: 409,
  review_required: 409,
  digest_mismatch: 409,
  state_gap: 409,
  installation_disabled: 403,
  rate_limited: 429,
  unavailable: 503,
  upstream_unavailable: 503,
  internal: 500,
};

const RETRYABLE_CODES = new Set([
  'unavailable',
  'upstream_unavailable',
  'rate_limited',
  'internal',
]);

export interface KyAppErrorBody {
  ok: false;
  error: { code: string; retryable: boolean; message: string; requestId: string };
}

/** 请求关联 id：优先取客户端带来的 `X-KY-Request-Id`，否则新生成。 */
export function requestIdOf(req: Request): string {
  const header = req.header('x-ky-request-id');
  return typeof header === 'string' && header.length > 0 && header.length <= 128
    ? header
    : randomUUID();
}

export function kyAppErrorBody(req: Request, code: string, message: string): KyAppErrorBody {
  return {
    ok: false,
    error: {
      code,
      retryable: RETRYABLE_CODES.has(code),
      message: message.slice(0, 200),
      requestId: requestIdOf(req),
    },
  };
}

export function sendKyAppError(req: Request, res: Response, code: string, message: string): void {
  res.status(KY_APP_ERROR_STATUS[code] ?? 500).json(kyAppErrorBody(req, code, message));
}

/** 已知业务异常 → 错误码。未知异常一律 `internal`，细节只进日志。 */
export function kyAppErrorCode(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'KyAppSystemNotFoundError') return 'not_found';
  if (name === 'KyAppSystemConflictError') return 'conflict';
  if (name === 'KyAppOnboardConflictError') return 'conflict';
  if (name === 'KyAppCredentialConflictError') return 'conflict';
  if (name === 'KyAppSigningKeyConflictError') return 'conflict';
  if (name === 'KyAppSigningKeyError') return 'conflict';
  if (name === 'GovernanceAuditUnavailableError') return 'unavailable';
  if (name === 'AssignmentInvariantError') return 'conflict';
  if (name === 'KyAppInstallationError' || name === 'KyAppHandshakeError') {
    const code = (error as { code?: string }).code ?? 'conflict';
    if (code === 'forbidden' || code === 'installation_forbidden') return 'forbidden';
    if (code === 'installation_not_found') return 'not_found';
    if (code === 'installation_disabled') return 'installation_disabled';
    if (code === 'memberships_unavailable') return 'unavailable';
    if (code.startsWith('invalid_')) return 'invalid_input';
    return 'conflict';
  }
  if (name === 'KyAppSatDeniedError') return 'forbidden';
  if (name === 'KyAppAttestationError') return 'unauthorized';
  if (name === 'KyAppOutboundError') return 'upstream_unavailable';
  return 'internal';
}

/** 统一的异常出口：把已知业务异常映射成附录 D 形态，未知异常按 500 归口。 */
export function sendKyAppFailure(req: Request, res: Response, error: unknown): void {
  const code = kyAppErrorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  sendKyAppError(req, res, code, code === 'internal' ? '服务内部错误' : message);
}

export function currentUser(req: Request): JwtPayload | undefined {
  return req.user;
}

/** 组织管理员：本组织的 admin（平台管理员天然覆盖全部组织）。 */
export function canManageTenant(user: JwtPayload | undefined, tenantId: string): boolean {
  if (!user) return false;
  if (isPlatformAdmin(user)) return true;
  return user.role === 'admin' && user.tenantId === tenantId;
}

/** 治理审计需要的 actor 三元组。 */
export function governanceActorOf(user: JwtPayload): {
  sub: string;
  role: string;
  tenantId: string;
} {
  return { sub: user.sub, role: user.role, tenantId: user.tenantId };
}

/** 壳会话标识：会话 JWT 的 `jti`；旧 token 无 `jti` 时用稳定组合值兜底。 */
export function shellSessionId(user: JwtPayload): string {
  return user.jti ?? `${user.sub}:${user.authEpoch ?? 0}:${user.generation ?? 0}`;
}

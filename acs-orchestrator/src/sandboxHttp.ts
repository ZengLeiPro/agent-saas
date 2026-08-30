import type { IncomingMessage, ServerResponse } from 'node:http';

import { SandboxDeletionPreconditionError } from './sandboxDeletion.js';
import {
  SandboxBusyError,
  SandboxCapacityError,
  SandboxInvalidStateError,
  SandboxNotFoundError,
} from './sandboxManager.js';

export type SandboxRoute =
  | { kind: 'list' }
  | { kind: 'name'; rawName: string; action?: 'pause' | 'resume' };

const SANDBOX_NAME_PATTERN = /^as-[a-z0-9-]{1,60}$/;
const DEPLOY_SMOKE_BYPASS = 'deploy-smoke-v1';

export function allowsExecutionMaintenanceBypass(req: IncomingMessage): boolean {
  const remoteAddress = req.socket.remoteAddress;
  const loopback = remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1';
  return loopback && req.headers['x-acs-maintenance-bypass'] === DEPLOY_SMOKE_BYPASS;
}

export function matchSandboxRoute(rawUrl: string | undefined): SandboxRoute | null {
  const path = (rawUrl ?? '').split(/[?#]/)[0] ?? '';
  if (path === '/sandboxes') return { kind: 'list' };
  const match = /^\/sandboxes\/([^/]+)(?:\/(pause|resume))?$/.exec(path);
  if (!match) return null;
  return {
    kind: 'name',
    rawName: match[1]!,
    ...(match[2] ? { action: match[2] as 'pause' | 'resume' } : {}),
  };
}

export function decodeSandboxName(rawName: string): string | null {
  try {
    const name = decodeURIComponent(rawName);
    return SANDBOX_NAME_PATTERN.test(name) ? name : null;
  } catch {
    return null;
  }
}

export function sendSandboxError(res: ServerResponse, err: unknown): void {
  if (err instanceof SandboxCapacityError) return sendCapacityError(res, err);
  if (err instanceof SandboxBusyError || err instanceof SandboxDeletionPreconditionError) {
    return sendJsonError(res, 409, err.message);
  }
  if (err instanceof SandboxNotFoundError) return sendJsonError(res, 404, err.message);
  if (err instanceof SandboxInvalidStateError) return sendJsonError(res, 400, err.message);
  return sendJsonError(res, 500, err instanceof Error ? err.message : String(err));
}

export function sendCapacityError(res: ServerResponse, err: SandboxCapacityError): void {
  res.writeHead(503, {
    'content-type': 'application/json', 'retry-after': '30', 'x-acs-error-code': err.code,
  });
  res.end(JSON.stringify({ status: 'error', code: err.code, error: err.message, capacity: err.snapshot }));
}

export function sendExecutionMaintenance(res: ServerResponse, reason?: string): void {
  res.writeHead(503, {
    'content-type': 'application/json', 'retry-after': '30', 'x-acs-error-code': 'ACS_EXECUTION_MAINTENANCE',
  });
  res.end(JSON.stringify({
    status: 'error', code: 'ACS_EXECUTION_MAINTENANCE', error: reason || 'ACS execution maintenance is active',
  }));
}

function sendJsonError(res: ServerResponse, status: number, error: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: 'error', error }));
}

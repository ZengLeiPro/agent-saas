import type { IncomingMessage, ServerResponse } from 'node:http';

import { MAX_BODY_BYTES } from './protocol.js';
import type { SandboxManager } from './sandboxManager.js';
import { parseLifecycleIdentity, parseLifecycleUpdate } from './sandboxLifecyclePolicy.js';
import { sendSandboxError } from './sandboxHttp.js';

export type SandboxLifecycleRoute = 'update' | 'delete-scope';
// These paths are consumed by server/runtime/sandboxLifecycleService.ts.

export function matchSandboxLifecycleRoute(rawUrl: string | undefined): SandboxLifecycleRoute | null {
  const path = (rawUrl ?? '').split(/[?#]/)[0] ?? '';
  if (path === '/sandboxes/lifecycle') return 'update';
  if (path === '/sandboxes/scope') return 'delete-scope';
  return null;
}

export async function handleSandboxLifecycleRoute(
  req: IncomingMessage,
  res: ServerResponse,
  route: SandboxLifecycleRoute,
  options: {
    sandboxManager: SandboxManager;
    authorize: (req: IncomingMessage) => boolean;
    busySandboxNames: () => Set<string>;
  },
): Promise<void> {
  if (!options.authorize(req)) return sendJson(res, 401, { status: 'error', error: 'unauthorized' });
  const expectedMethod = route === 'update' ? 'POST' : 'DELETE';
  if (req.method !== expectedMethod) {
    return sendJson(res, 405, {
      status: 'error',
      error: `method not allowed; use ${expectedMethod}`,
    });
  }

  const body = await readJson(req, res);
  if (!body.ok) return;
  try {
    if (route === 'update') {
      const parsed = parseLifecycleUpdate(body.value);
      if (!parsed.ok) return sendJson(res, 400, { status: 'error', error: parsed.error });
      const result = await options.sandboxManager.updateLifecycle(parsed.value);
      return sendJson(res, 200, { status: 'ok', ...result });
    }

    const parsed = parseLifecycleIdentity(body.value);
    if (!parsed.ok) return sendJson(res, 400, { status: 'error', error: parsed.error });
    const result = await options.sandboxManager.deleteByScope(parsed.value, {
      busySandboxNames: options.busySandboxNames(),
    });
    return sendJson(res, 200, { status: 'ok', ...result });
  } catch (err) {
    return sendSandboxError(res, err);
  }
}

async function readJson(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > MAX_BODY_BYTES) throw new Error(`body 超过 ${MAX_BODY_BYTES} bytes`);
      chunks.push(buffer);
    }
    const raw = Buffer.concat(chunks).toString('utf-8');
    return { ok: true, value: raw.trim() ? JSON.parse(raw) : {} };
  } catch (err) {
    sendJson(res, 400, {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false };
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

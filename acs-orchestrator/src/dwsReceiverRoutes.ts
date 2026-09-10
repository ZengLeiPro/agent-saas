import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AcsExecutor } from './executor.js';
import type { AcsOrchestratorConfig } from './config.js';
import {
  DWS_RECEIVER_LIMITS,
  DwsReceiverProtocolError,
  parseDwsReceiverRequest,
} from 'server/runtime/dwsReceiverProtocol.js';

interface Dependencies {
  config: AcsOrchestratorConfig;
  executor: Pick<AcsExecutor, 'execute'>;
  authorize(request: IncomingMessage): boolean;
  draining(): boolean;
  run<T>(work: () => Promise<T>): Promise<T>;
}

export function handleDwsReceiverRoute(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: Dependencies,
): boolean {
  if (request.url === '/dws-receivers/capabilities') {
    void capabilities(request, response, dependencies);
    return true;
  }
  if (request.url === '/dws-receivers/control') {
    void dependencies.run(() => control(request, response, dependencies));
    return true;
  }
  return false;
}

async function capabilities(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: Dependencies,
): Promise<void> {
  if (request.method !== 'GET') return json(response, 405, { code: 'method_not_allowed' });
  if (!dependencies.authorize(request)) return json(response, 401, { code: 'unauthorized' });
  return json(response, 200, {
    protocolVersion: 1,
    ownershipReaders: 1,
    durableReceiver: 1,
    upstreamReplay: 'unverified',
    minimumRollbackProtocol: 1,
    sourceSha: dependencies.config.releaseIdentity?.sourceSha ?? null,
  });
}

async function control(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: Dependencies,
): Promise<void> {
  if (request.method !== 'POST') return json(response, 405, { code: 'method_not_allowed' });
  if (!dependencies.authorize(request)) return json(response, 401, { code: 'unauthorized' });
  try {
    const body = parseDwsReceiverRequest(JSON.parse(await boundedBody(request, 64 * 1024)));
    if (dependencies.draining() && body.action === 'start') {
      return json(response, 503, { code: 'orchestrator_draining' }, { 'retry-after': '2' });
    }
    const result = await dependencies.executor.execute({
      toolName: '__DwsReceiver',
      input: body,
      context: {
        invocationId: `dws-rpc-${body.owner.receiverId}-${body.action}-${randomUUID()}`,
        workspace: {
          id: body.workspace.id,
          sessionId: body.workspace.sessionId,
          sandboxScopeId: body.workspace.sandboxScopeId,
          mountSubPath: body.workspace.mountSubPath,
          userId: body.owner.accountId,
          username: 'dws-receiver',
          workload: { class: 'cron' },
        },
      },
    });
    if (result.status !== 'success') {
      const code = /^[a-z0-9_:-]{1,128}$/.test(result.error)
        ? result.error
        : 'receiver_control_failed';
      return json(response, result.metadata?.remoteExecution ? 503 : 409, { code });
    }
    let snapshot: unknown;
    try {
      snapshot = JSON.parse(result.content);
    } catch {
      throw new DwsReceiverProtocolError('receiver_control_invalid_response', 502);
    }
    return json(response, 200, snapshot);
  } catch (error) {
    if (error instanceof DwsReceiverProtocolError)
      return json(response, error.statusCode, { code: error.code });
    if (error instanceof SyntaxError) return json(response, 400, { code: 'invalid_receiver_json' });
    return json(response, 503, { code: 'receiver_control_unavailable' });
  }
}

async function boundedBody(request: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    bytes += chunk.length;
    if (bytes > limit) throw new DwsReceiverProtocolError('receiver_control_input_limit', 413);
    chunks.push(chunk);
  }
  if (bytes === 0) throw new DwsReceiverProtocolError('receiver_control_input_missing', 400);
  return Buffer.concat(chunks).toString('utf8');
}

function json(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  if (response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(body));
}

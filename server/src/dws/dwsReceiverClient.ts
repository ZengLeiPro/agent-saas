import {
  DWS_RECEIVER_LIMITS, DwsReceiverProtocolError, parseDwsReceiverRequest, parseDwsReceiverSnapshot,
  type DwsReceiverAction, type DwsReceiverSnapshot,
} from '../runtime/dwsReceiverProtocol.js';
import type { DwsDeliverySession } from '../data/agentDwsAccounts/durableDeliveryStore.js';

export interface DwsReceiverCapabilities {
  protocolVersion: 1;
  ownershipReaders: 1;
  durableReceiver: 1;
  upstreamReplay: 'unverified';
  minimumRollbackProtocol: 1;
  sourceSha: string | null;
}

export class DwsReceiverClient {
  constructor(private readonly options: {
    baseUrl: string;
    authToken: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  }) {}

  async capabilities(signal?: AbortSignal): Promise<DwsReceiverCapabilities> {
    const value = await this.request('/dws-receivers/capabilities', undefined, signal) as Partial<DwsReceiverCapabilities>;
    if (!value || value.protocolVersion !== 1 || value.ownershipReaders !== 1 || value.durableReceiver !== 1
      || value.minimumRollbackProtocol !== 1 || value.upstreamReplay !== 'unverified') {
      throw new DwsReceiverProtocolError('durable_receiver_capability_required', 426);
    }
    return value as DwsReceiverCapabilities;
  }

  async control(action: DwsReceiverAction, session: DwsDeliverySession,
    cursor: { after?: number; through?: number; limit?: number } = {}, signal?: AbortSignal): Promise<DwsReceiverSnapshot> {
    const body = parseDwsReceiverRequest({ protocolVersion: 1, action,
      owner: session.owner, source: session.source, workspace: session.workspace, ...cursor });
    const result = await this.request('/dws-receivers/control', body, signal);
    return parseDwsReceiverSnapshot(result, session.owner);
  }

  private async request(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    if (!this.options.authToken) throw new DwsReceiverProtocolError('receiver_credentials_required', 503);
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutMs = this.options.timeoutMs ?? DWS_RECEIVER_LIMITS.rpcMs;
    const work = (async () => {
      const response = await (this.options.fetchImpl ?? fetch)(`${this.options.baseUrl.replace(/\/$/, '')}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${this.options.authToken}`, 'content-type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
        redirect: 'error',
      });
      const value = await readBoundedJson(response, DWS_RECEIVER_LIMITS.pageBytes + 64 * 1024);
      if (!response.ok) {
        const code = value && typeof value === 'object' ? (value as Record<string, unknown>).code : undefined;
        throw new DwsReceiverProtocolError(typeof code === 'string' && /^[a-z0-9_:-]{1,128}$/.test(code)
          ? code : 'receiver_control_failed', response.status);
      }
      return value;
    })();
    // Even a custom transport that ignores AbortSignal cannot keep a caller open.
    // Its late result is observed; neither a timeout nor EOF releases a source owner.
    const boundary = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new DwsReceiverProtocolError('receiver_rpc_timeout', 504));
      }, timeoutMs);
      timer.unref?.();
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason
        ?? new DwsReceiverProtocolError('receiver_rpc_aborted', 499)), { once: true });
    });
    void work.catch(() => undefined);
    try {
      if (signal?.aborted) abort();
      return await Promise.race([work, boundary]);
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      controller.abort();
    }
  }
}

async function readBoundedJson(response: Response, limit: number): Promise<unknown> {
  if (!response.body) throw new DwsReceiverProtocolError('receiver_response_missing');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit) throw new DwsReceiverProtocolError('receiver_response_limit');
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } finally {
    void reader.cancel().catch(() => undefined);
    try { reader.releaseLock(); } catch { /* A detached transport still owns its pending read. */ }
  }
}

import { createHash } from 'node:crypto';

import {
  listAzerothTokenBindings,
  resolveAzerothInjection,
  type AzerothTokenBinding,
} from '../../../integrations/azeroth/tokens.js';
import type { AzerothBindingPort, AzerothHttpClient, AzerothServerBinding } from './types.js';

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface ConfigAzerothContextPortsOptions {
  fetchImpl?: FetchLike;
  listBindings?: () => AzerothTokenBinding[];
  resolveInjection?: (tenantId: string, username: string) => { token: string; apiUrl?: string } | null;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

interface CredentialLocator {
  tenantId: string;
  username: string;
  expectedBaseUrl: string;
}

/**
 * Keeps PAT material behind a server-only opaque handle. The worker can select an
 * authoritative binding but never receives, persists or logs the credential.
 */
export class ConfigAzerothContextPorts implements AzerothBindingPort, AzerothHttpClient {
  private readonly fetchImpl: FetchLike;
  private readonly listBindings: () => AzerothTokenBinding[];
  private readonly resolveInjection: NonNullable<ConfigAzerothContextPortsOptions['resolveInjection']>;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly credentials = new Map<string, CredentialLocator>();

  constructor(options: ConfigAzerothContextPortsOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.listBindings = options.listBindings ?? listAzerothTokenBindings;
    this.resolveInjection = options.resolveInjection ?? resolveAzerothInjection;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 16 * 1024 * 1024;
  }

  async listServerBindings(tenantId: string): Promise<readonly AzerothServerBinding[]> {
    const results: AzerothServerBinding[] = [];
    for (const binding of this.listBindings().filter(item => item.tenantId === tenantId)) {
      const injection = this.resolveInjection(binding.tenantId, binding.username);
      if (!injection?.token || !injection.apiUrl) continue;
      const baseUrl = normalizeBaseUrl(injection.apiUrl);
      const handle = credentialHandle(binding.tenantId, binding.username);
      this.credentials.set(handle, { tenantId: binding.tenantId, username: binding.username, expectedBaseUrl: baseUrl });
      results.push({
        bindingId: `azeroth:${createHash('sha256').update(`${binding.tenantId}\0${binding.username}`).digest('hex').slice(0, 24)}`,
        serverSide: true,
        roles: binding.roles ?? [],
        baseUrl,
        credentialHandle: handle,
      });
    }
    return results;
  }

  async get(input: {
    binding: AzerothServerBinding;
    path: string;
    query: Readonly<Record<string, string | number>>;
    signal?: AbortSignal;
  }): Promise<unknown> {
    const locator = this.credentials.get(input.binding.credentialHandle);
    if (!locator) throw new Error('AZEROTH_CONTEXT_CREDENTIAL_UNAVAILABLE');
    const injection = this.resolveInjection(locator.tenantId, locator.username);
    if (!injection?.token || !injection.apiUrl) throw new Error('AZEROTH_CONTEXT_CREDENTIAL_UNAVAILABLE');
    const baseUrl = normalizeBaseUrl(injection.apiUrl);
    if (baseUrl !== locator.expectedBaseUrl || baseUrl !== normalizeBaseUrl(input.binding.baseUrl)) {
      throw new Error('AZEROTH_CONTEXT_ENDPOINT_DRIFT');
    }
    if (!/^\/api\/v1\/[a-z0-9-]+$/.test(input.path)) throw new Error('AZEROTH_CONTEXT_PATH_INVALID');
    const url = new URL(input.path, `${baseUrl}/`);
    for (const [key, value] of Object.entries(input.query)) url.searchParams.set(key, String(value));

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('AZEROTH_CONTEXT_TIMEOUT')), this.timeoutMs);
    const abort = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await this.fetchImpl(url, {
        headers: { Authorization: `Bearer ${injection.token}`, Accept: 'application/json' },
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`AZEROTH_CONTEXT_HTTP_${response.status}`);
      const contentLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > this.maxResponseBytes) {
        throw new Error('AZEROTH_CONTEXT_RESPONSE_TOO_LARGE');
      }
      const body = await response.text();
      if (Buffer.byteLength(body, 'utf8') > this.maxResponseBytes) throw new Error('AZEROTH_CONTEXT_RESPONSE_TOO_LARGE');
      return JSON.parse(body) as unknown;
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener('abort', abort);
    }
  }
}

function credentialHandle(tenantId: string, username: string): string {
  return `cred:${createHash('sha256').update(`context-azeroth\0${tenantId}\0${username}`).digest('hex')}`;
}

function normalizeBaseUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('AZEROTH_CONTEXT_ENDPOINT_INVALID');
  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';
  parsed.pathname = parsed.pathname.replace(/\/api\/v1\/?$/, '').replace(/\/+$/, '');
  return parsed.toString().replace(/\/$/, '');
}

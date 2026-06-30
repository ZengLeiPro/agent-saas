import { lookup as dnsLookup } from 'node:dns/promises';
import net from 'node:net';

import ipaddr from 'ipaddr.js';

export interface WebEgressPolicy {
  allowPrivateNetworks?: boolean;
  allowedHosts?: string[];
  blockedHosts?: string[];
}

export interface ValidateRemoteUrlOptions {
  lookup?: typeof dnsLookup;
  egress?: WebEgressPolicy;
}

export interface FetchRemoteTextOptions extends ValidateRemoteUrlOptions {
  fetchImpl?: typeof fetch;
  init?: RequestInit;
  maxBytes: number;
  maxRedirects: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const TEXT_DECODER = new TextDecoder();

export class WebFetchBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebFetchBlockedError';
  }
}

export interface FetchedRemoteText {
  url: string;
  finalUrl: string;
  status: number;
  statusText: string;
  headers: Headers;
  body: string;
  bytesRead: number;
  truncatedByBytes: boolean;
}

export async function validateRemoteUrl(rawUrl: string | URL, options: ValidateRemoteUrlOptions = {}): Promise<URL> {
  const url = rawUrl instanceof URL ? new URL(rawUrl.toString()) : new URL(rawUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebFetchBlockedError('Only HTTP and HTTPS URLs can be fetched.');
  }
  if (url.username || url.password) {
    throw new WebFetchBlockedError('URLs with username/password are not allowed.');
  }

  const hostname = normalizeHostname(url.hostname);
  if (!hostname) throw new WebFetchBlockedError('URL must include a hostname.');
  assertHostPolicy(hostname, options.egress);

  if (net.isIP(hostname)) {
    assertPublicAddress(hostname, hostname, options.egress);
    return url;
  }

  const lookup = options.lookup ?? dnsLookup;
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch (err) {
    throw new WebFetchBlockedError(`Failed to resolve ${hostname}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (addresses.length === 0) {
    throw new WebFetchBlockedError(`Failed to resolve ${hostname}: no addresses returned.`);
  }
  for (const { address } of addresses) {
    assertPublicAddress(address, hostname, options.egress);
  }
  return url;
}

export async function fetchRemoteText(
  rawUrl: string | URL,
  options: FetchRemoteTextOptions,
): Promise<FetchedRemoteText> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let current = await validateRemoteUrl(rawUrl, options);
  let init = options.init ?? {};

  for (let redirects = 0; redirects <= options.maxRedirects; redirects += 1) {
    const response = await fetchImpl(current, { ...init, redirect: 'manual' });
    if (!REDIRECT_STATUSES.has(response.status)) {
      const { body, bytesRead, truncatedByBytes } = await readBodyWithLimit(response, options.maxBytes);
      return {
        url: rawUrl.toString(),
        finalUrl: current.toString(),
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        body,
        bytesRead,
        truncatedByBytes,
      };
    }

    const location = response.headers.get('location');
    if (!location) {
      const { body, bytesRead, truncatedByBytes } = await readBodyWithLimit(response, options.maxBytes);
      return {
        url: rawUrl.toString(),
        finalUrl: current.toString(),
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        body,
        bytesRead,
        truncatedByBytes,
      };
    }
    if (redirects === options.maxRedirects) {
      throw new WebFetchBlockedError(`Too many redirects fetching ${current.toString()}.`);
    }
    current = await validateRemoteUrl(new URL(location, current), options);
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && init.method?.toUpperCase() === 'POST')) {
      const { body: _body, ...nextInit } = init;
      init = { ...nextInit, method: 'GET' };
    }
  }

  throw new WebFetchBlockedError(`Too many redirects fetching ${current.toString()}.`);
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function assertHostPolicy(hostname: string, egress?: WebEgressPolicy): void {
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new WebFetchBlockedError(`Blocked internal hostname: ${hostname}`);
  }
  const blockedHosts = new Set((egress?.blockedHosts ?? []).map(normalizeHostname));
  if (blockedHosts.has(hostname)) {
    throw new WebFetchBlockedError(`Blocked hostname: ${hostname}`);
  }
  const allowedHosts = (egress?.allowedHosts ?? []).map(normalizeHostname);
  if (allowedHosts.length > 0 && !allowedHosts.includes(hostname)) {
    throw new WebFetchBlockedError(`Hostname is not in allowedHosts: ${hostname}`);
  }
}

function assertPublicAddress(address: string, hostname: string, egress?: WebEgressPolicy): void {
  if (egress?.allowPrivateNetworks === true) return;
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(address);
  } catch {
    throw new WebFetchBlockedError(`Resolved non-IP address for ${hostname}: ${address}`);
  }
  if (parsed.kind() === 'ipv6' && parsed.range() === 'ipv4Mapped') {
    parsed = (parsed as ipaddr.IPv6).toIPv4Address();
  }
  const range = parsed.range();
  const blocked = new Set([
    'unspecified',
    'broadcast',
    'multicast',
    'linkLocal',
    'loopback',
    'private',
    'reserved',
    'carrierGradeNat',
    'uniqueLocal',
  ]);
  if (blocked.has(range)) {
    throw new WebFetchBlockedError(`Blocked internal address for ${hostname}: ${address}`);
  }
}

async function readBodyWithLimit(response: Response, maxBytes: number): Promise<{
  body: string;
  bytesRead: number;
  truncatedByBytes: boolean;
}> {
  const contentLength = response.headers.get('content-length');
  if (contentLength) {
    const parsed = Number(contentLength);
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      throw new WebFetchBlockedError(`Response too large (${parsed} bytes > ${maxBytes} bytes).`);
    }
  }
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      throw new WebFetchBlockedError(`Response too large (${buffer.byteLength} bytes > ${maxBytes} bytes).`);
    }
    return { body: TEXT_DECODER.decode(buffer), bytesRead: buffer.byteLength, truncatedByBytes: false };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    bytesRead += value.byteLength;
    if (bytesRead > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new WebFetchBlockedError(`Response too large (${bytesRead} bytes > ${maxBytes} bytes).`);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body: TEXT_DECODER.decode(merged), bytesRead, truncatedByBytes: false };
}

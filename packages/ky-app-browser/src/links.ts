/**
 * §5.4 `link.open` 的客户端先行校验：仅 `https:`、无 userinfo、非 IP、
 * host ∈ manifest `externalLinkHosts`。不符直接本地拒绝，**不发消息**。
 *
 * 壳侧还会再校验一次（纵深防御），这里拒绝是为了不把明显危险的 URL 递给壳。
 */
import type { KyLinkRejectReason } from './types.js';

/** 点分四段十进制。 */
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/u;
/** 纯数字 host（`http://3232235777` 这类整数形式 IPv4）。 */
const ALL_DIGITS = /^\d+$/u;
/** `0x7f000001` 这类十六进制形式。 */
const HEX_HOST = /^0[xX][0-9a-fA-F]+$/u;

export interface LinkCheckResult {
  ok: boolean;
  reason?: KyLinkRejectReason;
  /** 校验通过时给出的规范化 URL（`URL` 序列化结果）。 */
  url?: string;
}

export function checkExternalLink(
  rawUrl: string,
  allowedHosts: readonly string[],
): LinkCheckResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  if (parsed.protocol !== 'https:') return { ok: false, reason: 'not_https' };
  if (parsed.username !== '' || parsed.password !== '') return { ok: false, reason: 'userinfo' };
  const host = parsed.hostname.toLowerCase();
  if (host === '') return { ok: false, reason: 'invalid_url' };
  if (isIpLiteral(host)) return { ok: false, reason: 'ip_host' };
  const allowed = allowedHosts.some((entry) => entry.trim().toLowerCase() === host);
  if (!allowed) return { ok: false, reason: 'not_allowlisted' };
  return { ok: true, url: parsed.toString() };
}

/** IPv4（点分 / 整数 / 十六进制）与 `[::1]` 形式的 IPv6 都算 IP 字面量。 */
export function isIpLiteral(hostname: string): boolean {
  if (hostname.startsWith('[')) return true;
  if (IPV4.test(hostname)) return true;
  if (ALL_DIGITS.test(hostname)) return true;
  if (HEX_HOST.test(hostname)) return true;
  return false;
}

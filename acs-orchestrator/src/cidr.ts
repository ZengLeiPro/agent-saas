/**
 * 极简 IPv4 CIDR 工具（2026-08-10，配套 SNAT `shared-cidr` 模式）。
 *
 * 只处理 IPv4：ACS pod 与 NAT 网关 SNAT 条目当前都是 IPv4，引入依赖不划算。
 * 用途是安全兜底——判断 pod IP 是否真的落在明确允许的托管网段内；不在时
 * fail-closed 并告警，禁止退化成 per-pod 条目风暴或让 pod 静默断网。
 */

export interface Ipv4Cidr {
  /** 网络地址（已按掩码归一） */
  networkInt: number;
  prefixLength: number;
  /** 归一后的规范写法，如 172.16.179.5/24 → 172.16.179.0/24 */
  canonical: string;
}

function parseIpv4(value: string): number | null {
  const parts = value.trim().split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    result = (result * 256) + n;
  }
  return result >>> 0;
}

function formatIpv4(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.');
}

export function parseIpv4Cidr(value: string | undefined): Ipv4Cidr | null {
  if (!value) return null;
  const [ipPart, prefixPart] = value.trim().split('/');
  if (!ipPart || prefixPart === undefined) return null;
  if (!/^\d{1,2}$/.test(prefixPart)) return null;
  const prefixLength = Number(prefixPart);
  if (prefixLength < 0 || prefixLength > 32) return null;
  const ip = parseIpv4(ipPart);
  if (ip === null) return null;
  // prefixLength=0 时 32 位移位在 JS 里是未定义行为（x << 32 === x），单独处理
  const mask = prefixLength === 0 ? 0 : (0xFFFFFFFF << (32 - prefixLength)) >>> 0;
  const networkInt = (ip & mask) >>> 0;
  return { networkInt, prefixLength, canonical: `${formatIpv4(networkInt)}/${prefixLength}` };
}

/** 判断某个 IPv4 地址是否落在 CIDR 内。任一侧不可解析都返回 false（fail-closed）。 */
export function ipv4InCidr(ip: string | undefined, cidr: Ipv4Cidr | string | undefined | null): boolean {
  if (!ip) return false;
  const parsed = typeof cidr === 'string' || cidr === undefined || cidr === null
    ? parseIpv4Cidr(typeof cidr === 'string' ? cidr : undefined)
    : cidr;
  if (!parsed) return false;
  const value = parseIpv4(ip);
  if (value === null) return false;
  const mask = parsed.prefixLength === 0 ? 0 : (0xFFFFFFFF << (32 - parsed.prefixLength)) >>> 0;
  return ((value & mask) >>> 0) === parsed.networkInt;
}

export function ipv4CidrsOverlap(left: Ipv4Cidr, right: Ipv4Cidr): boolean {
  const narrower = left.prefixLength >= right.prefixLength ? left : right;
  const broader = narrower === left ? right : left;
  return ipv4InCidr(formatIpv4(narrower.networkInt), broader);
}

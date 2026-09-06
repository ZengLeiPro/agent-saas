/**
 * §5.4 `link.open` 的壳侧准入：仅 `https:`、无 userinfo、非 IP、
 * host 属于 manifest 的 `externalLinkHosts`；确认框标「外部网站」并显示 punycode。
 *
 * 为什么壳侧要自己有一份判定（而不是复用子端 SDK 的 `checkExternalLink`）：
 * 子端那份是「不把明显危险的 URL 递给壳」的**客户端先行校验**，运行在被嵌套的
 * 定制项目里，攻击面上等同于不可信输入 —— 壳不能把准入决定外包给它。
 * 这份是壳自己的最终判定，参照 `shell.html:289-299` 的 `checkLink`，
 * 并按 §5.4 补齐 shell.html 缺的两条：非 IP、punycode 展示。
 */

/** 拒绝原因；会随 `link_blocked` 安全事件落审计（闭集，服务端 `reason` 字段）。 */
export type LinkRejectReason =
  'invalid_url' | 'not_https' | 'userinfo' | 'ip_host' | 'not_allowlisted';

export interface LinkVerdict {
  ok: boolean;
  reason?: LinkRejectReason;
  /** 通过时给出规范化 URL（`URL` 序列化结果）；打开时用它而不是原始串。 */
  url?: string;
  /**
   * 确认框里展示的 host。`URL.hostname` 对国际化域名给的就是 punycode（`xn--`），
   * 这正是 §5.4 要的：用户看到 `xn--80ak6aa92e.com` 而不是长得像 apple.com 的同形字。
   */
  displayHost?: string;
}

/** 点分四段十进制。 */
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/u;
/** 纯数字 host（`https://3232235777` 这类整数形式 IPv4）。 */
const ALL_DIGITS = /^\d+$/u;
/** `0x7f000001` 这类十六进制形式。 */
const HEX_HOST = /^0[xX][0-9a-fA-F]+$/u;

/** IPv4（点分 / 整数 / 十六进制）与 `[::1]` 形式的 IPv6 都算 IP 字面量。 */
export function isIpLiteral(hostname: string): boolean {
  if (hostname.startsWith('[')) return true;
  if (IPV4.test(hostname)) return true;
  if (ALL_DIGITS.test(hostname)) return true;
  if (HEX_HOST.test(hostname)) return true;
  return false;
}

export function checkExternalLink(rawUrl: unknown, allowedHosts: readonly string[]): LinkVerdict {
  if (typeof rawUrl !== 'string' || rawUrl === '') return { ok: false, reason: 'invalid_url' };
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  // 顺序照 §5.4 逐条来，且每条都要有自己的 reason —— 审计里分不清是
  // 「打错字」还是「有人在试 javascript:」就等于没记。
  if (parsed.protocol !== 'https:') return { ok: false, reason: 'not_https' };
  if (parsed.username !== '' || parsed.password !== '') return { ok: false, reason: 'userinfo' };
  const host = parsed.hostname.toLowerCase();
  if (host === '') return { ok: false, reason: 'invalid_url' };
  if (isIpLiteral(host)) return { ok: false, reason: 'ip_host' };
  const allowed = allowedHosts.some((entry) => entry.trim().toLowerCase() === host);
  if (!allowed) return { ok: false, reason: 'not_allowlisted' };
  return { ok: true, url: parsed.toString(), displayHost: host };
}

/** 确认框正文：标「外部网站」并显示 punycode 后的 host（§5.4）。 */
export function externalLinkConfirmText(displayHost: string): string {
  return `即将打开外部网站：${displayHost}。确认继续吗？`;
}

/**
 * 打开外链：必须 `noopener,noreferrer`。
 * `noopener` 之外还要 `noreferrer`，否则目标站能从 Referer 读到壳的深链路径。
 *
 * **不能用返回值判断有没有打开成功。** HTML 规范规定：窗口特性里带 `noopener` 时
 * `window.open()` 一律返回 `null`（新窗口与打开方彻底断开，本来就拿不到句柄）。
 * 早先这里写 `return handle !== null`，结果是**放行的外链也一律回 `link.result{ok:false}`**
 * —— 子端每次都以为被拦了。弹窗拦截同样返回 `null`，两者无法区分，所以这个
 * 信号根本不存在：只要 `open()` 没抛异常就按已发起处理。
 */
export function openExternalLink(url: string, open: typeof window.open = window.open): boolean {
  try {
    open.call(window, url, '_blank', 'noopener,noreferrer');
    return true;
  } catch {
    return false;
  }
}

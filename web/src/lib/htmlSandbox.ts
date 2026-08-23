/** HTML 产物预览统一沙箱 CSP：仅允许文档内联资源，显式禁止联网、表单与导航。 */
export const HTML_SANDBOX_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' blob:",
  "style-src 'unsafe-inline' data:",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src data: blob:",
  "worker-src blob:",
  "form-action 'none'",
  "base-uri 'none'",
  "navigate-to 'none'",
].join("; ");

/**
 * 将 CSP 放在全部不可信文档字节之前。只对白名单内的现代标准 DOCTYPE 保持首位；
 * PUBLIC、内部子集和畸形声明一律把 CSP 放到声明之前。少数旧文档可能进入 quirks
 * mode，但不能用自制解析器猜浏览器 tokenizer 的结束位置而让 CSP 被声明吞掉。
 */
export function injectSandboxCsp(html: string, controlledHead = ""): string {
  const injected = `<meta http-equiv="Content-Security-Policy" content="${HTML_SANDBOX_CSP}">${controlledHead}`;
  const safeDoctype = html.match(/^(\s*<!doctype\s+html\s*>)/i)?.[1];
  if (!safeDoctype) return `${injected}${html}`;
  return `${safeDoctype}${injected}${html.slice(safeDoctype.length)}`;
}

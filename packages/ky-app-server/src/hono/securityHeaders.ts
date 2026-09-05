/**
 * §5.1 部署与响应头（Hono 中间件）。
 *
 * 定制项目 HTML 入口与重定向终点必须带：
 * `Content-Security-Policy: frame-ancestors https://agent.kaiyan.net; default-src 'self';
 *  script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'`，
 * 以及 HSTS；**不设** `X-Frame-Options`（helmet 默认要覆盖掉，否则壳的 iframe 加载不了）。
 */
import type { MiddlewareHandler } from 'hono';

/** 壳站 origin，`frame-ancestors` 只允许它。 */
export const SHELL_ORIGIN = 'https://agent.kaiyan.net';

/** §5.1 的 CSP 原文。 */
export const CONTENT_SECURITY_POLICY = [
  `frame-ancestors ${SHELL_ORIGIN}`,
  "default-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
].join('; ');

/** HSTS：两年 + 子域 + preload。 */
export const STRICT_TRANSPORT_SECURITY = 'max-age=63072000; includeSubDomains; preload';

export interface SecurityHeadersOptions {
  /** 覆盖 CSP（例如本地开发需要放开 `connect-src`）；生产不要动。 */
  contentSecurityPolicy?: string;
  /** 关闭 HSTS（纯 http 的本地环境）。 */
  hsts?: boolean;
}

/**
 * 统一响应头中间件。
 *
 * 注意：这里**主动删除** `X-Frame-Options`。很多框架 / 反代默认加 `SAMEORIGIN` 或 `DENY`，
 * 一旦带上，壳站的跨源 iframe 就会被浏览器拦掉，而 CSP 的 `frame-ancestors` 才是契约要求的
 * 唯一嵌入控制手段。
 */
export function securityHeaders(options: SecurityHeadersOptions = {}): MiddlewareHandler {
  const csp = options.contentSecurityPolicy ?? CONTENT_SECURITY_POLICY;
  const hsts = options.hsts !== false;
  return async (c, next) => {
    await next();
    c.res.headers.set('Content-Security-Policy', csp);
    if (hsts) c.res.headers.set('Strict-Transport-Security', STRICT_TRANSPORT_SECURITY);
    c.res.headers.set('X-Content-Type-Options', 'nosniff');
    c.res.headers.set('Referrer-Policy', 'strict-origin');
    c.res.headers.delete('X-Frame-Options');
  };
}

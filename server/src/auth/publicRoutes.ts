/**
 * `/api` 下的免鉴权路由表。
 *
 * 原本内联在 `auth/middleware.ts`。WP2a 需要把定制项目的 `credential-ack` 加进来
 * （它用服务凭据 Bearer 自鉴权，不走会话 JWT），而该文件必须只缩不涨，
 * 因此把整张表连同匹配函数外提，行为逐字保持不变。
 */
import type { Request } from 'express';

// 中间件通过 app.use('/api', ...) 挂载，req.path 不含 /api 前缀。
const PUBLIC_ROUTES: Array<{ method?: string; path: string | RegExp }> = [
  { method: 'POST', path: '/auth/login' },
  { method: 'POST', path: '/auth/sms/send-code' },
  { method: 'POST', path: '/auth/sms/login' },
  // M30-01 logout verifies bearer inside the router so replay remains idempotent after fencing.
  { method: 'POST', path: '/auth/logout' },
  // 自助注册试用（官网联动）：status/send-code/register 均免登录；
  // enabled 开关与频控在 routes/signup.ts 内收口
  { path: /^\/signup\// },
  { path: '/health' },
  { path: '/healthz' },
  { path: '/healthz/drain' },
  // 蓝绿部署探针（2026-07-15）：live=进程存活，ready=可接流量（部署门禁在
  // 新色端口上等它 200 再切流）。与 /healthz 同口径公开，只暴露 warmup 进度。
  { path: '/healthz/live' },
  { path: '/healthz/ready' },
  { path: '/config' },
  { method: 'POST', path: '/internal/acs-alerts' },
  { method: 'GET', path: '/app/version' },
  { path: /^\/dingtalk\/webhook\// },
  { method: 'GET', path: /^\/auth\/avatar\// },
  { method: 'GET', path: /^\/agents\/avatar\// },
  // 企业专家图片头像：<img> 加载不带鉴权头，与 agents/avatar 同口径公开（204 防枚举在路由内）
  { method: 'GET', path: /^\/org-agents\/avatar\// },
  { method: 'GET', path: '/mcp/oauth/callback' },
  { method: 'GET', path: '/connectors/oauth/callback' },
  { method: 'GET', path: '/mcp/oauth/client-metadata' },
  { method: 'GET', path: /^\/artifacts\/[^/]+\/content$/ },
  { method: 'GET', path: /^\/share\/artifacts\/[^/]+$/ },
  { method: 'GET', path: /^\/share\/artifacts\/[^/]+\/content$/ },
  { method: 'HEAD', path: /^\/share\/artifacts\/[^/]+\/content$/ },
  { method: 'GET', path: /^\/share\/sessions\/[^/]+$/ },
  { path: /^\/share\/sessions\/[^/]+\/file$/ },
  // WP2a：定制项目用服务凭据 Bearer 确认新签发的凭据（规范 §3.6）。
  // 它没有会话 JWT，鉴权在 router 内按 token 的 sha256 比对完成。
  { method: 'POST', path: /^\/app-contract\/v1\/installations\/[^/]+\/credential-ack$/ },
];

export function isPublicRoute(req: Request): boolean {
  return PUBLIC_ROUTES.some(({ method, path }) => {
    if (method && req.method !== method) return false;
    if (typeof path === 'string') return req.path === path;
    return path.test(req.path);
  });
}

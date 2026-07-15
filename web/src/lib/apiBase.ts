import { getAgentAvatarUrl } from '@agent/shared';
import { webConfig } from '../platform/webConfig';

/**
 * 裸 fetch 场景的 API URL 拼接（公开端点如 signup/login/share、FormData 上传等
 * 不走 authFetch 的请求）。分域部署下 authFetch/fileUtils 已通过 platform
 * getBaseUrl() 收口，此 helper 是同一收口在 web 端裸 fetch 处的补充。
 *
 * 直接 import webConfig 而非 getPlatform()：preload.ts 等模块级立即执行的代码
 * 早于 platform 注册运行，webConfig 是无依赖模块常量，不受初始化顺序影响。
 */
export function apiUrl(path: string): string {
  return webConfig.getBaseUrl() + path;
}

/**
 * server 返回的相对 API 资源路径（如用户头像 `/api/auth/avatar/:id`、企业专家
 * 头像上传响应）转为可跨域加载的绝对 URL。分域部署下 `<img src>` 不走 fetch
 * 收口，相对路径会打到前端 OSS 域被错误文档（index.html）吞掉。
 * blob:/data:/绝对 URL 等非 `/api/` 前缀值原样返回。
 */
export function resolveApiAssetUrl(url: string): string;
export function resolveApiAssetUrl(url: string | undefined): string | undefined;
export function resolveApiAssetUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  return url.startsWith('/api/') ? webConfig.getBaseUrl() + url : url;
}

/**
 * web 端 Agent/企业专家头像 URL：包装 shared 的 getAgentAvatarUrl，
 * 自动注入分域 base（shared 版 serverUrl 缺省为空串=相对路径，仅同源可用）。
 */
export function agentAvatarUrl(username: string, avatar?: string, version?: number): string | null {
  return getAgentAvatarUrl(username, avatar, webConfig.getBaseUrl(), version);
}

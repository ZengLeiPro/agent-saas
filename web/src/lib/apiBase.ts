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

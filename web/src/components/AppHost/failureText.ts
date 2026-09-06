/**
 * §6.6 客户面失败场景表（壳能检测到的那些行）。
 *
 * 纪律（施工总则 §3.2-15）：**不写技术归因、不用「上游」这类词**。
 * 用户看到的每一句都在这里，别处不许现写字符串。
 *
 * §6.6 里另有三行不归壳，落点在补丁轮核实过（偏差 4-B-05）：
 * - `/me` 超时（菜单骨架 + 重试）、菜单为空（「你在《系统名》中还没有被分配角色…」）
 *   → 归**子端**。注意不是 `packages/ky-app-browser`（那个包里没有 `/me` 概念），
 *   而是脚手架模板 `packages/create-ky-app/templates/hono-vue`
 *   （`web/src/ky.ts` 的 `refreshMe()` 与 `web/src/App.vue` 的空菜单分支）。
 *   两行目前都未合规实现，已记为 WP1 尾单。
 * - 能力未启用（Agent「该系统暂未开放此操作」）→ 归 **Capability Gateway（WP3）**，
 *   文案出现在 KY Agent 的对话里而不是定制项目页面里。
 *
 * 壳没有 `/me`、不渲染子端菜单、也不投影工具调用结果，这三行壳侧都检测不到。
 */

/** 壳能检测到的失败种类。 */
export type AppHostFailureKind =
  /** 握手 / 证明失败、`ready` 10 s 超时（§5.4-3）。 */
  | 'handshake_failed'
  /** 契约版本不为 1（§8.3、§9.3-16；shell.html:314-318）。 */
  | 'contract_version_mismatch'
  /** 系统停用 / `live` 失败 / 不再对本人可见（§5.5、§6.6）。 */
  | 'unavailable'
  /** 壳会话过期（`token.refresh.error{session_expired}`）。 */
  | 'session_expired'
  /** 系统正在更新（`maintenance` / 需重新注册 / digest 不一致）。 */
  | 'system_updating'
  /** 账号 / 组织成员被停用（`token.refresh.error{user_disabled}`）。 */
  | 'user_disabled'
  /** 子端请求登出（`logout.request`）。 */
  | 'logged_out';

export interface AppHostFailureText {
  /** 主文案。 */
  message: string;
  /** 是否给「重试」按钮。 */
  retryable: boolean;
}

/** 系统名缺失时的兜底称呼；不要退化成 installationId（那是运维标识，不面向客户）。 */
export const UNKNOWN_SYSTEM_NAME = '该系统';

export function systemLabel(name: string | null | undefined): string {
  const trimmed = (name ?? '').trim();
  return trimmed === '' ? UNKNOWN_SYSTEM_NAME : trimmed;
}

export function describeAppHostFailure(
  kind: AppHostFailureKind,
  systemName: string | null | undefined,
): AppHostFailureText {
  const label = systemLabel(systemName);
  switch (kind) {
    case 'handshake_failed':
      return { message: `《${label}》暂时无法加载，已通知技术支持`, retryable: true };
    case 'contract_version_mismatch':
      // shell.html:316 的原文；这是唯一一条不带系统名的，因为它与哪个系统无关
      return { message: '系统版本不兼容', retryable: false };
    case 'unavailable':
      return { message: `《${label}》暂不可用`, retryable: false };
    case 'session_expired':
      return { message: '登录状态已过期，请重新登录', retryable: false };
    case 'user_disabled':
      // §6.6 没有这一行；`token.refresh.error{user_disabled}` 必须有个说法，
      // 按同表的口吻写：只说结果与下一步，不说是账号停用还是成员停用
      return { message: '你的账号暂时无法使用该系统，请联系管理员', retryable: false };
    case 'system_updating':
      return { message: `《${label}》正在更新，暂不可操作`, retryable: true };
    case 'logged_out':
      return { message: '已退出登录，请重新登录', retryable: false };
  }
}

/** 权限被撤：自动回首页并提示（§6.6「权限被撤」行）。 */
export const PERMISSION_CHANGED_NOTICE = '权限已更新';

/** 4-A-01 总控拍板：非法应用内路径回落首页时的轻提示（不写技术归因）。 */
export const INVALID_PATH_NOTICE = '链接无效，已返回首页';

/** §6.4 积分耗尽的壳层降级文案（Agent 标签置灰用）。 */
export const CREDITS_EXHAUSTED_NOTICE = '本组织的 AI 额度已用完，已通知管理员';

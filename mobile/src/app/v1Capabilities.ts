/**
 * V1 能力清单（capability manifest）——移动端 V1 范围裁剪的唯一机器可读标准。
 *
 * 依据：`assets/20260828/TASK-307-移动端V1实施方案.md`（Normative v1.0）
 *   - §1.3 V1 强制信息架构（对话 / 设置 两个 Tab）
 *   - §2.1 必须交付、§2.2 必须隐藏或删除、§2.3 明确延期
 *   - 任务 M00-01「发布能力清单与路由裁剪」
 *
 * 约定：
 *   1. 路由 pattern 与 expo-router `useSegments()` 的输出一致：
 *      段以 `/` 连接，包含路由组段（如 `(tabs)`），动态段保留 pattern 名
 *      （如 `[sessionId]`），`app/index.tsx` 对应空字符串。
 *   2. 生产（production）构建按 allowlist 白名单放行（fail closed）：
 *      未分类路由一律拒绝。
 *   3. development / preview 构建不裁剪（开发与内测仍可用全部页面）。
 *   4. 本模块必须保持纯函数、无 React Native / Expo 运行时依赖，
 *      以便在 vitest（node 环境）中与路由清单扫描测试共同执行。
 */

export const V1_CAPABILITY_MANIFEST_VERSION = 1;

/** 构建档位：与 mobile/eas.json 的 build profile 一一对应。 */
export type V1BuildProfile = 'production' | 'preview' | 'development';

const BUILD_PROFILES: readonly V1BuildProfile[] = [
  'production',
  'preview',
  'development',
];

/**
 * V1 强制信息架构：生产包只保留「对话 / 设置」两个 Tab。
 * （方案 §1.3、§2.2「Files Tab 必须隐藏」）
 */
export const V1_PRODUCTION_TABS: readonly string[] = ['chat', 'settings'];

/**
 * 生产构建允许的路由 allowlist（段连接 pattern，见文件头约定）。
 * 对应方案 §1.3 信息架构 + §2.1 必须交付项（含系统分享 share-target、
 * Markdown 产物查看、账号自助修改密码）。
 */
export const V1_ALLOWED_ROUTES: readonly string[] = [
  // 根跳转 / 未匹配兜底 / 登录
  '', // app/index.tsx -> /(tabs)/chat
  'login',
  '+not-found',
  // 对话 Tab：会话与分组
  '(tabs)/chat',
  '(tabs)/chat/group/[groupKey]',
  // 会话详情与 Markdown 产物查看（§2.1 #5/#6/#11）
  'chat/[sessionId]',
  'chat/markdown-preview',
  // 设置 Tab：当前账号与当前 Agent、必要偏好、退出
  '(tabs)/settings',
  'settings/agent-profile',
  'settings/user-detail/[userId]',
  'change-password',
  'settings/connections',
  'oauth/callback',
  // 系统分享附件入口（§2.1 #8）
  'share-target',
];

/**
 * V1 已删除路由（墓碑记录）：文件已从代码库删除，仅作审计证据，
 * 不要求对应现存文件；若同名路由重新出现，将落入 unclassified 并被
 * 生产 allowlist fail closed 拒绝。
 */
export const V1_DELETED_ROUTES: Readonly<Record<string, string>> = {
  'webview-spike': '§2.2 WebView Spike 入口已删除（M00-01）',
};

/**
 * V1 延期/禁入路由及其唯一理由（对应方案 §2.2 / §2.3 与里程碑 ID）。
 * 理由文案是发布 Gate A 审计证据的一部分，不得留空。
 */
export const V1_DEFERRED_ROUTES: Readonly<Record<string, string>> = {
  '(tabs)/files': '§2.2 Files Tab 延期至完整文件中心（Gate A）',
  '(tabs)/files/browse': '§2.2 Files Tab 延期至完整文件中心（Gate A）',
  'chat/html-preview': '§2.3 HTML/SVG 主动内容原生脚本预览延期（M50-03）',
  cron: '§2.2 Cron 导航与管理 UI 延期（Gate A）',
  'cron/[jobId]': '§2.2 Cron 导航与管理 UI 延期（Gate A）',
  'cron-form': '§2.2 Cron 导航与管理 UI 延期（Gate A）',
  'memory-browser': '§2.2 Memory 浏览与编辑 UI 延期（Gate A）',
  'persona-editor': '§1.3 V1 最小设置：Agent 人格/记忆编辑不在信息架构内（M30-03 后评估）',
  'text-editor': '仅被延期的 Cron/Memory 流程使用（§2.2）',
  'settings/all-agents': '§2.2 「所有 Agent」旧页面不得作为可执行 Agent 入口（M30-03）',
  'settings/agent-profile/[username]': '仅从延期的 all-agents 页面可达（§2.2）',
  'settings/users': '§2.2 用户管理移动页延期（平台/租户管理走 Web）',
  'user-form': '§2.2 用户管理移动页延期（平台/租户管理走 Web）',
  'settings/audit-log': '§2.2 审计移动页延期（平台/租户管理走 Web）',
  'settings/skills': '§2.2 技能管理移动页延期（平台/租户管理走 Web）',
  'settings/skills-admin': '§2.2 技能管理移动页延期（平台/租户管理走 Web）',
  'settings/skills-tenant-admin': '§2.2 技能管理移动页延期（平台/租户管理走 Web）',
  'settings/my-permissions': '§1.3 V1 设置信息架构不含个人治理 UI（§2.2）',
};

/** 路由分类结果。 */
export type V1RouteClassification = 'allowed' | 'deferred' | 'unclassified';

export function classifyV1Route(routePattern: string): V1RouteClassification {
  if (V1_ALLOWED_ROUTES.includes(routePattern)) return 'allowed';
  if (Object.prototype.hasOwnProperty.call(V1_DEFERRED_ROUTES, routePattern)) {
    return 'deferred';
  }
  return 'unclassified';
}

/**
 * 解析构建档位。无法确定时 fail closed 返回 'production'（最严格裁剪）。
 *
 * @param input.dev            Metro 的 __DEV__ 标记（本地 expo start / dev client）
 * @param input.profileEnv     构建期注入的 EXPO_PUBLIC_V1_PROFILE（eas.json env）
 */
export function resolveV1BuildProfile(input: {
  dev?: boolean;
  profileEnv?: string | undefined;
}): V1BuildProfile {
  if (input.dev) return 'development';
  const env = (input.profileEnv ?? '').trim().toLowerCase();
  if (BUILD_PROFILES.includes(env as V1BuildProfile)) {
    return env as V1BuildProfile;
  }
  // fail closed：未知档位一律按生产裁剪。
  return 'production';
}

/** 该构建档位是否为生产（受 V1 裁剪约束）。 */
export function isProductionProfile(profile: V1BuildProfile): boolean {
  return profile === 'production';
}

/**
 * 路由是否允许进入。
 * - production：allowlist 白名单（fail closed，未分类拒绝）。
 * - development / preview：不裁剪。
 */
export function isV1RouteAllowed(
  routePattern: string,
  profile: V1BuildProfile,
): boolean {
  if (!isProductionProfile(profile)) return true;
  return classifyV1Route(routePattern) === 'allowed';
}

/**
 * 由 `useSegments()` 的段数组判断当前路由是否允许（生产深链 fail closed 的
 * 运行时入口）。空段数组（app/index.tsx）视为允许。
 */
export function isV1SegmentsAllowed(
  segments: readonly string[],
  profile: V1BuildProfile,
): boolean {
  return isV1RouteAllowed(segments.join('/'), profile);
}

/**
 * 生产可见 Tab 列表（其余档位返回完整 Tab 集）。
 * Tab 名与 `app/(tabs)/_layout.tsx` 的路由名一致。
 */
export function getV1VisibleTabs(
  profile: V1BuildProfile,
  allTabs: readonly string[],
): string[] {
  if (!isProductionProfile(profile)) return [...allTabs];
  return allTabs.filter((tab) => V1_PRODUCTION_TABS.includes(tab));
}

// ── V1 路由门禁决策（M00-01 返工：渲染前 fail closed） ────────────────

export interface V1GateInput {
  profile: V1BuildProfile;
  /** `useSegments()` 输出（含路由组段与动态段 pattern 名）。 */
  segments: readonly string[];
  authLoading: boolean;
  hasUser: boolean;
}

export interface V1GateDecision {
  /**
   * 是否挂载目标路由。
   * false = fail closed：渲染安全空壳，不挂载任何子路由/副作用。
   */
  mountRoute: boolean;
  /** 需要重定向的目标；null = 无需重定向。 */
  redirectTo: '/login' | '/(tabs)/chat' | null;
}

/**
 * 根路由门禁的唯一决策函数（纯函数，供运行时与测试共用）。
 *
 * 关键不变量（Review 返工要求）：
 * 1. 生产档位下，延期/未分类路由无论鉴权是否仍在 loading，
 *    都不得挂载目标路由（mountRoute=false），先重定向到安全页；
 * 2. 非生产档位不做路由裁剪；
 * 3. 允许路由仅在鉴权状态明确后才执行登录/回跳重定向（loading 时不跳）。
 */
export function resolveV1GateDecision(input: V1GateInput): V1GateDecision {
  const { profile, segments, authLoading, hasUser } = input;
  if (
    isProductionProfile(profile) &&
    !isV1SegmentsAllowed(segments, profile)
  ) {
    return {
      mountRoute: false,
      redirectTo: hasUser ? '/(tabs)/chat' : '/login',
    };
  }
  if (authLoading) {
    return { mountRoute: true, redirectTo: null };
  }
  const inAuthGroup = segments[0] === 'login';
  if (!hasUser && !inAuthGroup) {
    return { mountRoute: true, redirectTo: '/login' };
  }
  if (hasUser && inAuthGroup) {
    return { mountRoute: true, redirectTo: '/(tabs)/chat' };
  }
  return { mountRoute: true, redirectTo: null };
}

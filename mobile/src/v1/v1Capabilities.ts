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
 * （方案 §1.3、§2.2「Files Tab 必须隐藏」；P3-3c 后文件中心是 Stack 路由，
 * `app/(tabs)/_layout.tsx` 里已经不存在 files Tab 定义。）
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
  // 设置 Tab（P3-3d）：主页按 Web `unifiedSettingsRegistry` 的 8 个个人分区重排，
  // 分区 ID 与 Web `/settings/<id>` 一一对应（`connections` 落能力中心连接器 Tab、
  // `trash` 是页内 TrashSheet，两者没有独立路由）。
  '(tabs)/settings',
  'settings/account-security',
  'settings/my-agent',
  'settings/chat-model',
  'settings/appearance-layout',
  'settings/files-storage',
  // 个人治理：服务端权威有效资源视图（P3-3d 起进入生产 IA）
  'settings/my-permissions',
  'settings/agent-profile',
  'settings/user-detail/[userId]',
  'change-password',
  // 我的 Agent → 记忆：memory 目录浏览与人格 / MEMORY.md 编辑（P3-3d 解锁）
  'memory-browser',
  'persona-editor',
  // OAuth callback 保留最小安全回跳。
  'oauth/callback',
  // 能力中心（P3-3a）：工作流 / 技能 / 连接器 / 专家四 Tab，
  // 与 Web `/capabilities/*` 同一信息架构；旧的 settings/skills 与
  // settings/connections 已并入此处并记墓碑。
  'capabilities',
  'capabilities/workflows',
  'capabilities/skills',
  'capabilities/connectors',
  'capabilities/experts',
  // 任务中心（P3-3b）：定时任务列表 / 详情 / 创建编辑，与 Web `CronManager`
  // 的「定时任务」二级 Tab 同一信息架构（任务看板不进 mobile）。
  // 入口按 `tenantFeatures.cronEnabled` + `personalAgentOnly` 门控，
  // 与 Web `getSidebarNavItems` 一致。
  'cron',
  'cron/[jobId]',
  'cron-form',
  // 文件中心（P3-3c）：浏览 / 子目录 / 通用预览，与 Web `FileBrowser` +
  // `FilePreviewPanel` 同一信息架构。09-05 拍板不恢复第三个 Tab，
  // 入口是会话列表「文件」pill 与设置页「文件与存储」，按
  // `tenantFeatures.filesEnabled` 门控（见 src/lib/filesEntry.ts）。
  'files',
  'files/browse',
  'files/preview',
  // 全屏文本编辑器：任务中心的提示词/事件内容编辑走它（此前随 Cron 一起延期）
  'text-editor',
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
  'chat/html-preview': '旧 workspace HTML preview 已关闭（M50-03）；正式交付仅走 Artifact viewer',
  'settings/users': '09-04 拍板：移动端定位员工使用端，用户管理走 Web（管理后台留 Web）',
  'user-form': '09-04 拍板：移动端定位员工使用端，用户管理走 Web（管理后台留 Web）',
  'settings/audit-log': '09-04 拍板：移动端定位员工使用端，用户管理走 Web（管理后台留 Web）',
  'settings/all-agents': '09-04 拍板：移动端定位员工使用端，用户管理走 Web（管理后台留 Web）',
  'settings/agent-profile/[username]': '09-04 拍板：移动端定位员工使用端，用户管理走 Web（管理后台留 Web）',
  'settings/skills-admin': '09-04 拍板：移动端定位员工使用端，用户管理走 Web（管理后台留 Web）',
  'settings/skills-tenant-admin': '09-04 拍板：移动端定位员工使用端，用户管理走 Web（管理后台留 Web）',
  'settings/skills': 'P3-3a：员工技能页并入能力中心 capabilities/skills，旧路由删除',
  'settings/connections': 'P3-3a：MCP/OAuth 连接管理并入能力中心 capabilities/connectors，旧路由删除',
  '(tabs)/files': 'P3-3c：文件中心迁到 Stack 路由 files（不恢复第三个 Tab），旧 Tab 路由删除',
  '(tabs)/files/browse': 'P3-3c：文件中心迁到 Stack 路由 files/browse，旧 Tab 路由删除',
};

/**
 * V1 延期/禁入路由及其唯一理由（对应方案 §2.2 / §2.3 与里程碑 ID）。
 * 理由文案是发布 Gate A 审计证据的一部分，不得留空。
 */
export const V1_DEFERRED_ROUTES: Readonly<Record<string, string>> = {
  // P3-3d 起为空：设置 8 分区落地后，memory-browser / persona-editor /
  // settings/my-permissions 全部转入 allowlist。清单保留是为了
  // 「未来新增页面可以先登记延期理由再上线」；空对象不改变 fail closed 语义
  // ——未分类路由仍然被生产 allowlist 拒绝。
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

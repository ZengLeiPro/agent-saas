/**
 * §9.2 强制范式：生成给定制项目 `CLAUDE.md` 的契约片段。
 *
 * 脚手架（`create-ky-app`）生成模板时调用本函数写入 `CLAUDE.md`，**不手写第二份**：
 * 范式条款只有这一处事实源，改规范时改这里，所有项目下次生成即对齐。
 * 返回值是纯字符串（Markdown 片段），调用方可以直接追加到已有 `CLAUDE.md` 后面。
 */
import {
  ADMIN_REQUIRED_MENU_KEY,
  CAPABILITY_RESPONSE_MAX_BYTES,
  CAPABILITY_TIMEOUT_MAX_MS,
  CONTRACT_VERSION,
  HTTP_HEADERS,
  RESERVED_PATH_PREFIXES,
  RESERVED_QUERY_PARAMS,
} from './types/constants.js';

export interface ClaudeMdSectionOptions {
  /** 系统 id（manifest `systemId`）；缺省时用占位符。 */
  systemId?: string;
  /** 系统显示名。 */
  name?: string;
  /** 标题层级，默认 2（`##`）。 */
  headingLevel?: number;
}

/** §9.2 的七条强制范式，逐条可执行。 */
export const MANDATORY_PATTERNS: readonly string[] = [
  '**声明式权限表**：`{ menuKey, path, requiredPermission, children }` 一张表同时驱动 `/ky/v1/me` 的菜单树与前后端路由守卫。新增页面只改这张表，禁止在别处再写一份权限判断。',
  '**service 层共用**：能力 handler 与页面 API 必须调用同一个 service 函数；查询逻辑只允许存在一处，禁止复制粘贴。',
  '**`ctx` 只由验签中间件构造**：service 首参 `ctx{ tenantId, installationId, userId, roles, isTenantAdmin, dataScope }`，handler 永远拿不到原始 claims，也不得自己拼 `ctx`。',
  '**禁止 handler 内 `fetch` 自身 HTTP**：能力 handler 不得回头调用本服务的页面 API，一律直接调 service。',
  '**深链可达的每个页面接口在无权用户下必须 403**：菜单不可见不等于接口不可达，两者都要判。',
  `**组织管理员必备菜单**：\`adminRole\` 用户的菜单树必须含 \`${ADMIN_REQUIRED_MENU_KEY}\`（角色权限页），缺了即视为配置错误。`,
  `**每个业务 API 响应带 \`${HTTP_HEADERS.permVersion}\`**：权限变化由这个头传播到壳与浏览器 SDK。`,
];

function heading(level: number, text: string): string {
  return `${'#'.repeat(Math.min(Math.max(level, 1), 6))} ${text}`;
}

/**
 * 生成 `CLAUDE.md` 的契约片段（Markdown）。
 *
 * 内容 = §9.2 强制范式 + 契约硬约束速查（保留前缀 / 保留 query / 能力上限 / 响应头），
 * 全部取自 `@kaiyan/ky-app-contract` 的常量，不会与实现漂移。
 */
export function renderClaudeMdContractSection(options: ClaudeMdSectionOptions = {}): string {
  const level = options.headingLevel ?? 2;
  const systemId = options.systemId ?? '<systemId>';
  const name = options.name ?? '<系统名>';
  const lines: string[] = [];

  lines.push(heading(level, '开沿定制项目契约（由 @kaiyan/ky-app-contract 生成，勿手改）'));
  lines.push('');
  lines.push(
    `本项目是《开沿定制项目与 KY Agent 衔接契约》的定制项目一侧，` +
      `\`contractVersion = ${String(CONTRACT_VERSION)}\`，\`systemId = ${systemId}\`（${name}）。`,
  );
  lines.push('以下条款来自契约 §9.2「强制范式」，是硬性要求，改动前先改契约。');
  lines.push('');

  lines.push(heading(level + 1, '强制范式'));
  lines.push('');
  for (const [index, item] of MANDATORY_PATTERNS.entries()) {
    lines.push(`${String(index + 1)}. ${item}`);
  }
  lines.push('');

  lines.push(heading(level + 1, '契约硬约束速查'));
  lines.push('');
  lines.push(
    `- 保留路径前缀（\`pathPrefixes\` 不得覆盖）：${RESERVED_PATH_PREFIXES.map((prefix) => `\`${prefix}\``).join('、')}。`,
  );
  lines.push(
    `- 壳注入的保留 query 参数（路由规范化时一律剔除）：${RESERVED_QUERY_PARAMS.map((name_) => `\`${name_}\``).join('、')}。`,
  );
  lines.push(
    `- 能力响应体 UTF-8 ≤ ${String(CAPABILITY_RESPONSE_MAX_BYTES)} 字节；单次执行超时 ≤ ${String(CAPABILITY_TIMEOUT_MAX_MS)} ms。`,
  );
  lines.push(
    `- 请求头：\`${HTTP_HEADERS.requestId}\`（回显并进日志）、\`${HTTP_HEADERS.idempotencyKey}\`（写能力必带且等于 SAT 的 \`lcid\`）。`,
  );
  lines.push(
    `- 响应头：\`${HTTP_HEADERS.permVersion}\`（每个业务 API 都要带）；HTML 入口与重定向终点必须带 \`frame-ancestors\` 的 CSP，且**不设** \`X-Frame-Options\`。`,
  );
  lines.push(
    '- 密钥只从密钥管理注入，绝不进仓库：`.env` 只提交 `.env.example`，提交前跑密钥扫描。',
  );
  lines.push('- 客户可见文案用「技能」，不写英文 Skill，也不写「上游」一类技术归因。');
  lines.push('');

  lines.push(heading(level + 1, '自测'));
  lines.push('');
  lines.push('```bash');
  lines.push('pnpm build          # 前端产物由后端托管，一致性测试打的是生产构建');
  lines.push('pnpm doctor         # ky-app doctor：§9.3 全部 16 章一致性测试');
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

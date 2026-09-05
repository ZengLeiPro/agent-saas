/**
 * 个人设置 8 分区注册表 —— 与 Web `web/src/lib/unifiedSettingsRegistry.ts`
 * 的 `scope: "personal"` 条目同名、同序、同 ID、同分组。
 *
 * 约定：
 * 1. `id` 必须与 Web 一致：Web 的个人设置路径是 `/settings/<id>`，移动端
 *    Stack 路由同样落在 `settings/<id>`，将来接深链时两端可直接互换；
 * 2. 本模块保持纯数据（无 React / lucide / expo-router 依赖），
 *    图标映射放在 `src/components/settings/settingsIcons.ts`
 *    （与 Web `SettingsCenter/settingsConfig.ts` 的分层一致）；
 * 3. `target` 是移动端的落点：多数分区落自己的 Stack 路由，
 *    「连接与授权」复用能力中心连接器 Tab，「回收站」是设置页内的底部面板。
 */

export const PERSONAL_SETTINGS_GROUP_ORDER = ['personal', 'preferences', 'access', 'data'] as const;

export type PersonalSettingsGroup = (typeof PERSONAL_SETTINGS_GROUP_ORDER)[number];

/** 与 Web `SETTINGS_GROUP_LABELS` 一致。 */
export const PERSONAL_SETTINGS_GROUP_LABELS: Record<PersonalSettingsGroup, string> = {
  personal: '个人',
  preferences: '偏好',
  access: '访问',
  data: '数据',
};

export type PersonalSettingsSectionId =
  | 'account-security'
  | 'my-agent'
  | 'chat-model'
  | 'appearance-layout'
  | 'my-permissions'
  | 'connections'
  | 'files-storage'
  | 'trash';

/** 与 Web `PERSONAL_SETTINGS_ICONS` 的键一致。 */
export type PersonalSettingsIconKey =
  'user' | 'bot' | 'message-square' | 'palette' | 'admin' | 'link' | 'hard-drive' | 'trash';

/** 移动端落点：Stack 路由 pattern（与 V1 能力清单同一书写法）或页内浮层。 */
export type PersonalSettingsTarget =
  { kind: 'route'; route: string } | { kind: 'sheet'; sheet: 'trash' };

export interface PersonalSettingsSection {
  id: PersonalSettingsSectionId;
  label: string;
  /** 移动端副标题；不追求与 Web description 逐字一致（见 appearance-layout）。 */
  description: string;
  group: PersonalSettingsGroup;
  iconKey: PersonalSettingsIconKey;
  target: PersonalSettingsTarget;
}

export const PERSONAL_SETTINGS_SECTIONS: readonly PersonalSettingsSection[] = [
  {
    id: 'account-security',
    label: '账户与安全',
    description: '账号资料、安全和登录状态。',
    group: 'personal',
    iconKey: 'user',
    target: { kind: 'route', route: 'settings/account-security' },
  },
  {
    id: 'my-agent',
    label: '我的 Agent',
    description: '资料与长期 Memory。',
    group: 'personal',
    iconKey: 'bot',
    target: { kind: 'route', route: 'settings/my-agent' },
  },
  {
    id: 'chat-model',
    label: '对话与模型',
    description: '默认模型与对话展示偏好。',
    group: 'preferences',
    iconKey: 'message-square',
    target: { kind: 'route', route: 'settings/chat-model' },
  },
  {
    id: 'appearance-layout',
    label: '外观与布局',
    // 移动端没有侧边栏，描述刻意不照抄 Web 的「侧边栏、会话列表和界面偏好」。
    description: '字号、主题与会话列表显示。',
    group: 'preferences',
    iconKey: 'palette',
    target: { kind: 'route', route: 'settings/appearance-layout' },
  },
  {
    id: 'my-permissions',
    label: '我的权限',
    description: '服务端权威有效资源与权限解释。',
    group: 'access',
    iconKey: 'admin',
    target: { kind: 'route', route: 'settings/my-permissions' },
  },
  {
    id: 'connections',
    label: '连接与授权',
    description: '长期账号授权与运行时工具批准。',
    group: 'access',
    iconKey: 'link',
    // 与 Web 一致：连接器管理已并入能力中心（P3-3a），这里直接跳过去。
    target: { kind: 'route', route: 'capabilities/connectors' },
  },
  {
    id: 'files-storage',
    label: '文件与存储',
    description: '浏览文件、查看用量并清理附件。',
    group: 'data',
    iconKey: 'hard-drive',
    target: { kind: 'route', route: 'settings/files-storage' },
  },
  {
    id: 'trash',
    label: '回收站',
    description: '恢复或彻底清理已删除会话。',
    group: 'data',
    iconKey: 'trash',
    // 移动端回收站是设置页内的底部面板（TrashSheet），没有独立路由。
    target: { kind: 'sheet', sheet: 'trash' },
  },
];

export interface PersonalSettingsGroupView {
  group: PersonalSettingsGroup;
  label: string;
  sections: PersonalSettingsSection[];
}

/**
 * 按 Web 的分组顺序投影出「分组标题 + 该组分区」；
 * `hiddenIds` 用于租户开关 / V1 allowlist 关掉的分区，空组不渲染。
 */
export function groupPersonalSettingsSections(
  hiddenIds: readonly PersonalSettingsSectionId[] = [],
): PersonalSettingsGroupView[] {
  const hidden = new Set(hiddenIds);
  return PERSONAL_SETTINGS_GROUP_ORDER.map((group) => ({
    group,
    label: PERSONAL_SETTINGS_GROUP_LABELS[group],
    sections: PERSONAL_SETTINGS_SECTIONS.filter(
      (section) => section.group === group && !hidden.has(section.id),
    ),
  })).filter((view) => view.sections.length > 0);
}

/** 分区落点是 Stack 路由时返回其 pattern（供 V1 清单校验与导航使用）。 */
export function personalSettingsRoutes(): string[] {
  return PERSONAL_SETTINGS_SECTIONS.flatMap((section) =>
    section.target.kind === 'route' ? [section.target.route] : [],
  );
}

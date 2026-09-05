import { governanceRoute, type GovernanceRouteState } from '@/lib/governanceNavigation';

export type ManagementSurface = 'config' | 'analytics';
export type ManagementArea = 'organization' | 'platform';

export interface ManagementTabDefinition {
  id: string;
  label: string;
  routeId: string;
  search?: string;
}

export interface ManagementPageDefinition {
  id: string;
  surface: ManagementSurface;
  area: ManagementArea;
  group: string;
  label: string;
  description: string;
  iconKey: string;
  routeId: string;
  search?: string;
  aliases?: readonly string[];
  tabs?: readonly ManagementTabDefinition[];
}

const tab = (
  id: string,
  label: string,
  routeId: string,
  search?: string,
): ManagementTabDefinition => ({ id, label, routeId, search });

export const MANAGEMENT_PAGES: readonly ManagementPageDefinition[] = [
  {
    id: 'org-agents',
    surface: 'config',
    area: 'organization',
    group: '构建 · 调用资产',
    label: '智能体',
    description: '配置组织内的专职智能体、能力和开放范围。',
    iconKey: 'bot',
    routeId: 'organization.agents.org-agents',
    tabs: [
      tab('agents', '智能体清单', 'organization.agents.org-agents'),
      tab('templates', '模板范围', 'organization.agents.org-agents', '?view=templates'),
    ],
  },
  {
    id: 'org-skills',
    surface: 'config',
    area: 'organization',
    group: '构建 · 调用资产',
    label: '技能',
    description: '管理组织技能以及成员和群组的可用范围。',
    iconKey: 'sparkles',
    routeId: 'organization.agents.skills',
    tabs: [
      tab('catalog', '技能清单', 'organization.agents.skills'),
      tab('access', '授权范围', 'organization.agents.skills', '?view=access'),
    ],
  },
  {
    id: 'org-workflows',
    surface: 'config',
    area: 'organization',
    group: '构建 · 调用资产',
    label: '工作流',
    description: '配置组织可见的工作流和展示方式。',
    iconKey: 'workflow',
    routeId: 'organization.agents.workflows',
  },
  {
    id: 'org-connectors',
    surface: 'config',
    area: 'organization',
    group: '构建 · 调用资产',
    label: '连接器',
    description: '统一管理已接系统、凭据、MCP 服务、字段映射和钉钉账号。',
    iconKey: 'plug',
    routeId: 'organization.agents.connectors',
    aliases: [
      'organization.agents.mcp-catalog',
      'organization.agents.connector-mappings',
      'organization.agents.dingtalk-accounts',
    ],
    tabs: [
      tab('credentials', '已接系统与凭据', 'organization.agents.connectors'),
      tab('mcp', 'MCP 服务', 'organization.agents.mcp-catalog'),
      tab('mappings', '字段映射', 'organization.agents.connector-mappings'),
      tab('dingtalk', '钉钉账号', 'organization.agents.dingtalk-accounts'),
    ],
  },
  {
    id: 'org-knowledge',
    surface: 'config',
    area: 'organization',
    group: '构建 · 调用资产',
    label: '记忆与知识',
    description: '管理知识来源、组织记忆以及文件与数据。',
    iconKey: 'database',
    routeId: 'organization.agents.memory-knowledge',
    aliases: ['organization.agents.files-data'],
    tabs: [
      tab('knowledge', '知识与记忆', 'organization.agents.memory-knowledge'),
      tab('files', '文件与数据', 'organization.agents.files-data'),
    ],
  },
  {
    id: 'org-rules',
    surface: 'config',
    area: 'organization',
    group: '构建 · 调用资产',
    label: '智能体规则',
    description: '维护适用于本组织的统一行为规则。',
    iconKey: 'scroll',
    routeId: 'organization.settings.rules',
  },
  {
    id: 'org-automation',
    surface: 'config',
    area: 'organization',
    group: '运行',
    label: '自动化任务',
    description: '创建、启停并检查组织自动化任务。',
    iconKey: 'clock',
    routeId: 'organization.governance.automation',
  },
  {
    id: 'org-budget',
    surface: 'config',
    area: 'organization',
    group: '运行',
    label: '预算与计费',
    description: '配置预算边界并查看套餐与账单。',
    iconKey: 'wallet',
    routeId: 'organization.governance.usage',
    search: '?usageSection=billing',
    tabs: [
      tab('budget', '预算', 'organization.governance.usage', '?usageSection=billing'),
      tab(
        'billing',
        '套餐与账单',
        'organization.governance.usage',
        '?usageSection=billing&view=statement',
      ),
    ],
  },
  {
    id: 'org-members',
    surface: 'config',
    area: 'organization',
    group: '治理 · 边界',
    label: '成员',
    description: '管理组织成员、身份、资源指派、用量策略和安全记录。',
    iconKey: 'users',
    routeId: 'organization.members.list',
    aliases: ['organization.members.accounts', 'organization.members.member'],
  },
  {
    id: 'org-groups',
    surface: 'config',
    area: 'organization',
    group: '治理 · 边界',
    label: '部门与群组',
    description: '查看组织目录同步后的部门与群组。',
    iconKey: 'groups',
    routeId: 'organization.members.groups',
  },
  {
    id: 'org-roles',
    surface: 'config',
    area: 'organization',
    group: '治理 · 边界',
    label: '角色与权限',
    description: '管理组织所有者、管理员和权限策略。',
    iconKey: 'shield',
    routeId: 'organization.members.owners',
    aliases: ['organization.members.policies'],
    tabs: [
      tab('admins', '所有者与管理员', 'organization.members.owners'),
      tab('policies', '权限策略', 'organization.members.policies'),
    ],
  },
  {
    id: 'org-scope',
    surface: 'config',
    area: 'organization',
    group: '治理 · 边界',
    label: '可用范围',
    description: '配置模型、工具和执行环境的组织边界。',
    iconKey: 'sliders',
    routeId: 'organization.agents.model-tools',
    aliases: ['organization.agents.environments'],
    tabs: [
      tab('models', '模型', 'organization.agents.model-tools'),
      tab('tools', '工具', 'organization.agents.model-tools', '?view=tools'),
      tab('defaults', '默认策略', 'organization.agents.model-tools', '?view=defaults'),
      tab('environments', '执行环境', 'organization.agents.environments'),
    ],
  },
  {
    id: 'org-offboarding',
    surface: 'config',
    area: 'organization',
    group: '治理 · 边界',
    label: '离职交接',
    description: '先完成资源交接，再安全撤销成员权限。',
    iconKey: 'user-minus',
    routeId: 'organization.members.offboarding',
  },
  {
    id: 'org-profile',
    surface: 'config',
    area: 'organization',
    group: '组织设置',
    label: '组织资料',
    description: '维护组织名称、行业和联系信息。',
    iconKey: 'building',
    routeId: 'organization.settings.profile',
  },
  {
    id: 'org-brand',
    surface: 'config',
    area: 'organization',
    group: '组织设置',
    label: '品牌',
    description: '配置组织在产品中的品牌展示。',
    iconKey: 'palette',
    routeId: 'organization.settings.brand',
  },
  {
    id: 'org-security',
    surface: 'config',
    area: 'organization',
    group: '组织设置',
    label: '登录与安全',
    description: '管理登录方式和组织安全策略。',
    iconKey: 'lock',
    routeId: 'organization.settings.security',
  },
  {
    id: 'org-features',
    surface: 'config',
    area: 'organization',
    group: '组织设置',
    label: '功能与配额',
    description: '配置组织可用功能、默认模型和配额。',
    iconKey: 'settings',
    routeId: 'organization.settings.general',
  },

  {
    id: 'platform-tenants',
    surface: 'config',
    area: 'platform',
    group: '组织',
    label: '组织',
    description: '管理组织授权、配额、资源范围和生命周期。',
    iconKey: 'building',
    routeId: 'platform.org-business.tenants',
  },
  {
    id: 'platform-users',
    surface: 'config',
    area: 'platform',
    group: '组织',
    label: '用户检索',
    description: '跨组织检索用户并查看账号归属。',
    iconKey: 'search',
    routeId: 'platform.org-business.users',
  },
  {
    id: 'platform-models',
    surface: 'config',
    area: 'platform',
    group: '资源目录',
    label: '模型',
    description: '维护平台模型目录、能力和定价参数。',
    iconKey: 'cpu',
    routeId: 'platform.resource-center.models',
  },
  {
    id: 'platform-skills',
    surface: 'config',
    area: 'platform',
    group: '资源目录',
    label: '技能池',
    description: '管理平台技能及其发布状态。',
    iconKey: 'sparkles',
    routeId: 'platform.resource-center.skills',
  },
  {
    id: 'platform-connectors',
    surface: 'config',
    area: 'platform',
    group: '资源目录',
    label: '连接器',
    description: '管理平台 MCP 服务和字段映射目录。',
    iconKey: 'plug',
    routeId: 'platform.resource-center.connectors',
    tabs: [
      tab('mcp', 'MCP 服务', 'platform.resource-center.connectors'),
      tab('mappings', '字段映射', 'platform.resource-center.connectors', '?view=mappings'),
    ],
  },
  {
    id: 'platform-templates',
    surface: 'config',
    area: 'platform',
    group: '资源目录',
    label: '模板',
    description: '管理智能体模板和执行环境模板。',
    iconKey: 'layout-template',
    routeId: 'platform.resource-center.agent-templates',
    aliases: ['platform.resource-center.environment-templates'],
    tabs: [
      tab('agents', '智能体模板', 'platform.resource-center.agent-templates'),
      tab('environments', '环境模板', 'platform.resource-center.environment-templates'),
    ],
  },
  {
    id: 'platform-tools',
    surface: 'config',
    area: 'platform',
    group: '资源目录',
    label: '工具与策略',
    description: '管理平台工具开关和全局策略。',
    iconKey: 'wrench',
    routeId: 'platform.resource-center.tools',
  },
  {
    id: 'platform-system',
    surface: 'config',
    area: 'platform',
    group: '系统',
    label: '系统配置',
    description: '集中查看系统配置、配置状态和系统智能体。',
    iconKey: 'settings',
    routeId: 'platform.governance.system-settings',
    aliases: ['platform.governance.config-status'],
    tabs: [
      tab('config', '配置', 'platform.governance.system-settings'),
      tab('status', '配置状态', 'platform.governance.config-status'),
      tab('agents', '系统智能体', 'platform.governance.system-settings', '?view=agents'),
    ],
  },
  {
    id: 'platform-prompts',
    surface: 'config',
    area: 'platform',
    group: '系统',
    label: '系统提示语',
    description: '管理平台级系统提示语。',
    iconKey: 'message',
    routeId: 'platform.governance.system-prompts',
  },
  {
    id: 'platform-memory',
    surface: 'config',
    area: 'platform',
    group: '系统',
    label: '记忆策略',
    description: '配置平台记忆轮询和整合策略。',
    iconKey: 'database',
    routeId: 'platform.governance.memory-policy',
  },
  {
    id: 'platform-egress',
    surface: 'config',
    area: 'platform',
    group: '系统',
    label: '网络出口',
    description: '管理执行环境的受控网络出口。',
    iconKey: 'globe',
    routeId: 'platform.governance.network-security',
  },
  {
    id: 'platform-access',
    surface: 'config',
    area: 'platform',
    group: '系统',
    label: '访问控制',
    description: '管理平台管理员和注册策略。',
    iconKey: 'key',
    routeId: 'platform.org-business.platform-admins',
    aliases: ['platform.org-business.signup'],
    tabs: [
      tab('admins', '平台管理员', 'platform.org-business.platform-admins'),
      tab('signup', '注册管理', 'platform.org-business.signup'),
    ],
  },

  {
    id: 'org-overview',
    surface: 'analytics',
    area: 'organization',
    group: '组织分析',
    label: '组织总览',
    description: '查看组织使用、运行和治理的整体趋势。',
    iconKey: 'gauge',
    routeId: 'organization.overview.overview',
  },
  {
    id: 'org-usage',
    surface: 'analytics',
    area: 'organization',
    group: '组织分析',
    label: '用量与成本',
    description: '分析组织、成员和模型的用量与成本。',
    iconKey: 'chart',
    routeId: 'organization.governance.usage',
  },
  {
    id: 'org-qa',
    surface: 'analytics',
    area: 'organization',
    group: '组织分析',
    label: '会话质检',
    description: '查看质检结果、风险和改进趋势。',
    iconKey: 'message',
    routeId: 'organization.governance.qa',
  },
  {
    id: 'org-audit',
    surface: 'analytics',
    area: 'organization',
    group: '组织分析',
    label: '操作记录',
    description: '追踪组织管理操作和回执。',
    iconKey: 'history',
    routeId: 'organization.governance.audit',
  },

  {
    id: 'platform-overview',
    surface: 'analytics',
    area: 'platform',
    group: '平台分析',
    label: '平台总览',
    description: '查看全平台组织、用户、运行和收入概况。',
    iconKey: 'gauge',
    routeId: 'platform.overview.overview',
  },
  {
    id: 'platform-billing',
    surface: 'analytics',
    area: 'platform',
    group: '平台分析',
    label: '计费总表',
    description: '汇总各组织套餐、消耗和账单。',
    iconKey: 'wallet',
    routeId: 'platform.org-business.entitlements-billing',
  },
  {
    id: 'platform-provider-quota',
    surface: 'analytics',
    area: 'platform',
    group: '平台分析',
    label: '套餐额度',
    description: '查看 Codex、火山等模型套餐账号的实时用量、重置时间与撞限状态。',
    iconKey: 'quota',
    routeId: 'platform.runtime.provider-quota',
  },
  {
    id: 'platform-sessions',
    surface: 'analytics',
    area: 'platform',
    group: '平台分析',
    label: '会话',
    description: '检索平台会话并下钻查看详情。',
    iconKey: 'message',
    routeId: 'platform.runtime.sessions',
  },
  {
    id: 'platform-runs',
    surface: 'analytics',
    area: 'platform',
    group: '平台分析',
    label: '运行追踪',
    description: '追踪运行步骤、用量和原始事件。',
    iconKey: 'workflow',
    routeId: 'platform.runtime.runs',
  },
  {
    id: 'platform-environments',
    surface: 'analytics',
    area: 'platform',
    group: '平台分析',
    label: '执行环境',
    description: '查看执行提供方和环境实例状态。',
    iconKey: 'server',
    routeId: 'platform.runtime.execution-providers',
    aliases: ['platform.runtime.environments'],
    tabs: [
      tab('providers', '提供方', 'platform.runtime.execution-providers'),
      tab('instances', '实例', 'platform.runtime.environments'),
    ],
  },
  {
    id: 'platform-infra',
    surface: 'analytics',
    area: 'platform',
    group: '平台分析',
    label: '系统资源',
    description: '查看平台基础设施资源和告警。',
    iconKey: 'hard-drive',
    routeId: 'platform.runtime.infra',
  },
  {
    id: 'platform-efficiency',
    surface: 'analytics',
    area: 'platform',
    group: '平台分析',
    label: '执行效率',
    description: '分析执行耗时、成功率和资源效率。',
    iconKey: 'activity',
    routeId: 'platform.runtime.efficiency',
  },
  {
    id: 'platform-audit',
    surface: 'analytics',
    area: 'platform',
    group: '平台分析',
    label: '操作记录',
    description: '追踪平台级管理操作和回执。',
    iconKey: 'history',
    routeId: 'platform.governance.audit',
  },
];

const PAGE_BY_ID = new Map(MANAGEMENT_PAGES.map((page) => [page.id, page]));

function normalizedSearch(search: string | undefined): URLSearchParams {
  return new URLSearchParams(search?.startsWith('?') ? search.slice(1) : (search ?? ''));
}

function matchesSearch(page: ManagementPageDefinition, route: GovernanceRouteState): boolean {
  const routeParams = normalizedSearch(route.search);
  if (page.id === 'org-budget') return routeParams.get('usageSection') === 'billing';
  if (page.id === 'org-usage') return routeParams.get('usageSection') !== 'billing';
  return true;
}

export function managementPageById(id: string): ManagementPageDefinition | null {
  return PAGE_BY_ID.get(id) ?? null;
}

export function managementPageForRoute(
  route: GovernanceRouteState | null | undefined,
): ManagementPageDefinition | null {
  if (!route || route.area === 'settings') return null;
  return (
    MANAGEMENT_PAGES.find(
      (page) =>
        page.area === route.area &&
        (page.routeId === route.routeId || page.aliases?.includes(route.routeId)) &&
        matchesSearch(page, route),
    ) ?? null
  );
}

export function managementSurfaceForRoute(
  route: GovernanceRouteState | null | undefined,
): ManagementSurface | null {
  return managementPageForRoute(route)?.surface ?? null;
}

export function managementPagesFor(
  surface: ManagementSurface,
  area?: ManagementArea,
): readonly ManagementPageDefinition[] {
  return MANAGEMENT_PAGES.filter(
    (page) => page.surface === surface && (!area || page.area === area),
  );
}

export function activeManagementTab(
  page: ManagementPageDefinition,
  route: GovernanceRouteState,
): ManagementTabDefinition | null {
  if (!page.tabs?.length) return null;
  const routeParams = normalizedSearch(route.search);
  return (
    page.tabs.find((candidate) => {
      if (candidate.routeId !== route.routeId) return false;
      const expected = normalizedSearch(candidate.search);
      for (const [key, value] of expected) {
        if (routeParams.get(key) !== value) return false;
      }
      if (page.id === 'org-skills')
        return candidate.id === (routeParams.get('view') === 'access' ? 'access' : 'catalog');
      if (page.id === 'org-agents')
        return candidate.id === (routeParams.get('view') === 'templates' ? 'templates' : 'agents');
      if (page.id === 'org-scope') {
        if (candidate.routeId === 'organization.agents.environments')
          return candidate.id === 'environments';
        return (
          candidate.id ===
          (routeParams.get('view') === 'tools'
            ? 'tools'
            : routeParams.get('view') === 'defaults'
              ? 'defaults'
              : 'models')
        );
      }
      if (page.id === 'org-budget')
        return candidate.id === (routeParams.get('view') === 'statement' ? 'billing' : 'budget');
      if (page.id === 'platform-connectors')
        return candidate.id === (routeParams.get('view') === 'mappings' ? 'mappings' : 'mcp');
      if (page.id === 'platform-system')
        return (
          candidate.id ===
          (routeParams.get('view') === 'agents'
            ? 'agents'
            : candidate.routeId === 'platform.governance.config-status'
              ? 'status'
              : 'config')
        );
      return true;
    }) ?? page.tabs[0]
  );
}

export function managementRouteForPage(
  page: ManagementPageDefinition,
  current?: GovernanceRouteState | null,
  fallbackOrgId?: string | null,
): GovernanceRouteState {
  return governanceRoute(page.routeId, {
    orgId:
      page.area === 'organization'
        ? current?.area === 'organization'
          ? current.orgId
          : (fallbackOrgId ?? null)
        : null,
    search: page.search ?? '',
  });
}

export function managementRouteForTab(
  page: ManagementPageDefinition,
  tabId: string,
  current: GovernanceRouteState,
): GovernanceRouteState {
  const target = page.tabs?.find((candidate) => candidate.id === tabId);
  if (!target) throw new Error(`Unknown management tab: ${page.id}/${tabId}`);
  return governanceRoute(target.routeId, {
    orgId: page.area === 'organization' ? current.orgId : null,
    search: target.search ?? '',
  });
}

/**
 * 企业专家目录 MVP · 3 个种子专家模板（2026-07-18 蓝图 v2 § 5）
 *
 * 数据来源：`assets/20260718/企业专家目录-实施蓝图v2.md` § 5.1/5.2/5.3
 *
 * 用途：新租户开通时自动 seed 到 org-agents 表（status=disabled），
 *      管理员在目录页看到"推荐模板"卡片主动启用/编辑。
 *      seed 保留幂等：同 tenant 已存在同名或已 seed 过任一 template 时跳过。
 *
 * 模板设计原则（蓝图 v2 § 5.4）：
 *  - scopeDescription 三段式（职责 + 允许问 + 拒绝问），呼应 UI 填空题
 *  - guardrail.mode 一律 shadow 上线，管理员观察 3-7 天后切 enforce
 *  - strictness 按业务严肃性区分：报价/合同 strict、客户情报 lenient
 *  - audience.exposure 默认 all；合同类因敏感度用 allow_users 白名单
 *  - avatar 用 8 岗位预设 key（sales/boss/…），前端映射到 kaikai-presets/<key>.jpg
 */

import type { CreateOrgAgentInput, OrgAgentStore } from './orgAgents/store.js';

/**
 * 种子模板结构：等价于 CreateOrgAgentInput 但去掉 tenantId
 * （seed 时按目标 tenant 注入），并加 `templateId` 用于幂等跳过
 */
export interface OrgAgentTemplate {
  /** 稳定 id，用于日志与幂等标记（与 name 独立，避免管理员改名后重复 seed） */
  templateId: string;
  /** 面向管理员的模板描述（不进入 record；仅日志/文档用） */
  templateDescription: string;
  payload: Omit<CreateOrgAgentInput, 'tenantId'>;
}

const DEFAULT_GUARDRAIL_STRICT = {
  mode: 'shadow' as const,
  enabled: false, // shadow 不拦截 → 派生 enabled=false 供旧代码兼容
  strictness: 'strict' as const,
};

const DEFAULT_GUARDRAIL_LENIENT = {
  mode: 'shadow' as const,
  enabled: false,
  strictness: 'lenient' as const,
};

/** 5.1 报价审核助手（strict，audience=all） */
const QUOTE_REVIEWER: OrgAgentTemplate = {
  templateId: 'template-quote-reviewer',
  templateDescription: '审销售提交的报价单：报价规则 + 账期风险 + 折扣越权 + SKU 组合',
  payload: {
    name: '报价审核助手',
    avatar: 'sales',
    description: '审销售提交的报价单，检查是否符合公司报价规则、账期风险、折扣越权、SKU 组合。',
    starterPrompts: [
      '帮我审这份报价单：[粘贴]',
      '客户 XX 的账期上限是多少？',
      '8 折权限我有吗？',
    ],
    instructions: [
      '你是一位资深销售运营 + 财务风控双背景的助手。你的职责是审核销售同事上传的报价单，从以下 4 个维度检查：',
      '1. 报价是否符合公司现行报价规则（价格底线、折扣权限、赠品搭配规则）',
      '2. 客户账期是否合理（对照客户历史付款记录，识别账期风险）',
      '3. 合同条款是否有漏洞（付款条件、违约金、验收条款）',
      '4. 是否符合销售流程（有无缺失的领导审批、财务确认）',
      '',
      '回答风格：先给结论（通过 / 有风险 / 拒绝），再列 3-5 条具体理由，每条引用具体数据/规则原文。所有引用必须来自挂载知识库，不得凭空判断。',
    ].join('\n'),
    allowedSkills: ['pdf-invoice-parser', 'finance-quote-rules-matcher', 'crm-customer-lookup'],
    audience: { exposure: 'all', usernames: [] },
    guardrail: {
      ...DEFAULT_GUARDRAIL_STRICT,
      scopeDescription: [
        '职责：审核销售提交的报价单，检查是否符合公司报价规则、是否有账期风险、折扣是否越权、SKU 组合是否合理。',
        '',
        '允许问：',
        '· 粘贴一份报价单让我审',
        '· 问某个折扣是否合规',
        '· 问某个客户的账期上限',
        '· 问历史类似客户的报价参考',
        '· 问报价单缺哪些必填项',
        '',
        '拒绝问：',
        '· 写周报',
        '· 找人（用通讯录）',
        '· 写合同（用合同风险检测员）',
        '· 闲聊、编代码、翻译、生成图片',
        '',
        '当员工提交报价单以外的任何工作问题时判定 off_topic。',
      ].join('\n'),
      rejectionMessage: '抱歉，我是报价审核助手，只处理报价单审核相关问题。如需其他帮助，请回到「我的 AI 同事」或选择合适的企业专家。',
    },
    // 种子模板默认 disabled，管理员在目录页主动启用（避免"越权替客户开东西"）
    enabled: false,
  },
};

/** 5.2 客户情报分析师（lenient，audience=all） */
const CUSTOMER_ANALYST: OrgAgentTemplate = {
  templateId: 'template-customer-analyst',
  templateDescription: '给公司名，聚合工商公开信息 + 涉诉 + 新闻，输出一页客户档案',
  payload: {
    name: '客户情报分析师',
    avatar: 'sales',
    description: '给公司名，聚合工商公开信息、股权结构、涉诉记录、行业地位、最新新闻动态，输出一页客户档案。',
    starterPrompts: [
      '查一下厦门唯恩电气',
      'XX 公司最近有涉诉吗？',
      '帮我出 XX 公司的一页客户档案',
    ],
    instructions: [
      '你是一位客户尽调专家。收到销售同事询问某客户时，你按以下模板输出一页档案：',
      '1. 工商基本信息（成立时间、注册资本、法人、股权结构、参保人数）',
      '2. 经营风险（涉诉、被执行、失信、行政处罚、经营异常）',
      '3. 业务信号（近半年招投标、新增分支、招聘 JD、新闻动态）',
      '4. 我方历史（我方是否曾接触、是否是老客户、历史成交金额）',
      '5. 拜访建议（可谈的话题、需回避的话题、关键决策链）',
      '',
      '回答风格：一次性输出完整档案，不搞多轮。每条信息标注数据源（工商 / 涉诉 / 新闻 / 我方 CRM）。发现红旗（涉诉高发、失信）时用 🚩 标注。',
    ].join('\n'),
    allowedSkills: ['enterprise-info-fetcher', 'crm-customer-history'],
    audience: { exposure: 'all', usernames: [] },
    guardrail: {
      ...DEFAULT_GUARDRAIL_LENIENT,
      scopeDescription: [
        '职责：给定客户名，聚合工商公开信息、股权结构、涉诉记录、失信/被执行、行业地位、最新新闻动态，输出一页客户档案。',
        '',
        '允许问：',
        '· 给公司名让我查',
        '· 问某公司最近有没有诉讼',
        '· 问某公司老板是谁',
        '· 问某公司规模和行业地位',
        '· 要一份客户档案 PDF',
        '',
        '拒绝问：',
        '· 闲聊',
        '· 编代码',
        '· 写周报',
        '· 审报价单',
        '· 写合同',
        '· 生成非情报类图片',
        '· 给非公司主体做人肉搜索（如查个人手机号/家庭住址）',
      ].join('\n'),
      rejectionMessage: '抱歉，我是客户情报分析师，只做企业公开信息聚合与客户档案。个人隐私类问题我不能回答。其他工作请找对应的企业专家或个人 AI 同事。',
    },
    enabled: false,
  },
};

/** 5.3 合同风险检测员（strict，audience=allow_users 白名单） */
const CONTRACT_CHECKER: OrgAgentTemplate = {
  templateId: 'template-contract-checker',
  templateDescription: '审销售/采购合同、服务协议中的常见风险条款，标注高危并给整改建议',
  payload: {
    name: '合同风险检测员',
    avatar: 'boss',
    description: '审销售/采购合同/服务协议中的常见风险条款，标注高危并给整改建议。',
    starterPrompts: [
      '帮我审这份合同：[粘贴]',
      '对方要求付款期 90 天正常吗？',
      'SaaS 服务协议里保密条款该怎么写？',
    ],
    instructions: [
      '你是一位法务风控助手。收到销售/客服上传的合同 PDF/DOCX 时，你从以下 6 个维度扫描：',
      '1. 付款条款（账期、违约金、滞纳金）',
      '2. 交付条款（验收标准、延期赔偿）',
      '3. 知产条款（归属、授权范围）',
      '4. 保密条款（范围、期限）',
      '5. 违约与终止（违约金、退出机制）',
      '6. 争议解决（管辖、仲裁地）',
      '',
      '回答风格：先给风险等级总结（低 / 中 / 高），再列条款清单，每条：条款原文引用 + 风险点 + 修改建议。所有风险判定对照公司合同风险手册。',
    ].join('\n'),
    allowedSkills: [
      'pdf-invoice-parser',
      'contract-clause-extractor',
      'contract-risk-matcher',
      'legal-knowledge-search',
    ],
    // 合同审阅敏感度较高，默认走 allow_users 白名单（管理员启用时填 3 人：销售总监/法务/财务）
    audience: { exposure: 'allow_users', usernames: [] },
    guardrail: {
      ...DEFAULT_GUARDRAIL_STRICT,
      scopeDescription: [
        '职责：审核销售合同/采购合同/服务协议中的常见风险条款（付款期、违约金、知识产权归属、保密条款、终止条款、争议解决地、单方免责等），标注高危条款并给整改建议。',
        '',
        '允许问：',
        '· 粘贴一份合同让我审',
        '· 问某个具体条款有没有风险',
        '· 问 XX 类合同该注意什么',
        '· 问某类客户常见的合同陷阱',
        '',
        '拒绝问：',
        '· 写周报',
        '· 审报价单',
        '· 查客户情报',
        '· 闲聊、编代码',
        '· 翻译非合同文本',
        '· 写非合同类文档',
        '· 法律咨询以外的一般管理问题',
      ].join('\n'),
      rejectionMessage: '抱歉，我是合同风险检测员，只审合同条款风险。其他工作请找对应的企业专家或个人 AI 同事。特别提示：我的意见仅供参考，重大合同请务必让法律顾问签字确认。',
    },
    enabled: false,
  },
};

/** 3 个种子模板的正式清单（seed 顺序即目录默认排序） */
export const ORG_AGENT_SEED_TEMPLATES: readonly OrgAgentTemplate[] = [
  QUOTE_REVIEWER,
  CUSTOMER_ANALYST,
  CONTRACT_CHECKER,
];

/**
 * seed 结果，用于路由/日志层反馈
 * - `seeded`：本次成功写入的模板 templateId 列表
 * - `skipped`：因幂等跳过的模板 templateId 列表（同名已存在或整体已 seed 过）
 * - `errors`：单条 seed 异常，含 templateId + message（不阻断其他模板）
 */
export interface SeedOrgAgentTemplatesResult {
  tenantId: string;
  seeded: string[];
  skipped: string[];
  errors: Array<{ templateId: string; error: string }>;
}

/**
 * 已 seed 的判定策略：
 * 若同租户已存在任一记录（无论是否 template）则跳过全量 seed。
 * 这样"已有专家的老租户"永远不会被追加，避免向老租户重复 seed（任务要求）。
 * 新租户（0 条记录）才是 seed 的目标。
 */
export function shouldSkipTenantSeed(store: OrgAgentStore, tenantId: string): boolean {
  return store.listByTenant(tenantId).length > 0;
}

/**
 * 对指定租户 seed 3 个种子模板。
 *
 * 语义：
 * - 老租户（该租户下已有任一 org agent）→ 全量跳过（`skipped=all templateIds`）
 * - 新租户 → 逐条 create；`name` 已被同租户占用的条目跳过（保护管理员手动同名）
 * - 单条 create 失败不阻断其他条目
 *
 * 幂等：多次调用等价一次；即使中途某条 create 抛错，重试时会跳过已成功条目。
 *
 * @param actor seed 触发者（写入 record.createdBy）；租户 API 用 'system'，
 *              用户注册开通用 SIGNUP_ACTOR
 */
export async function seedOrgAgentTemplatesForTenant(
  store: OrgAgentStore,
  tenantId: string,
  actor: string,
): Promise<SeedOrgAgentTemplatesResult> {
  const result: SeedOrgAgentTemplatesResult = { tenantId, seeded: [], skipped: [], errors: [] };

  if (shouldSkipTenantSeed(store, tenantId)) {
    // 老租户全量跳过（防止向已有专家的租户重复 seed）
    for (const tpl of ORG_AGENT_SEED_TEMPLATES) result.skipped.push(tpl.templateId);
    return result;
  }

  const existingNames = new Set(store.listByTenant(tenantId).map((r) => r.name));

  for (const tpl of ORG_AGENT_SEED_TEMPLATES) {
    if (existingNames.has(tpl.payload.name)) {
      // 同名已存在（老租户的手动创建）→ 跳过，避免"报价审核助手"出现两条
      result.skipped.push(tpl.templateId);
      continue;
    }
    try {
      await store.create({ tenantId, ...tpl.payload }, actor);
      result.seeded.push(tpl.templateId);
      existingNames.add(tpl.payload.name);
    } catch (err) {
      result.errors.push({
        templateId: tpl.templateId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

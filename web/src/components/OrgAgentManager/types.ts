import type { OrgAgentAudience, OrgAgentRecord, OrgAgentRuntimePolicy } from '@agent/shared';

export type {
  OrgAgentAudience,
  OrgAgentExecutionTarget,
  OrgAgentGuardrailConfig,
  OrgAgentRuntimeContextModule,
  OrgAgentRuntimePolicy,
  OrgAgentRecord,
  OrgAgentSummary,
} from '@agent/shared';

/** 管理页只消费通过运行时校验、audience 非空的记录。 */
export type OrgAgentAdminRecord = Omit<OrgAgentRecord, 'audience'> & {
  audience: OrgAgentAudience;
};

type UnknownRecord = Record<string, unknown>;

function isObject(value: unknown): value is UnknownRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isBoundedStringArray(value: unknown, itemMaxLength: number, maxItems?: number): value is string[] {
  return Array.isArray(value)
    && (maxItems === undefined || value.length <= maxItems)
    && value.every(item => typeof item === 'string' && item.length >= 1 && item.length <= itemMaxLength);
}

function isAudience(value: unknown): value is OrgAgentAudience {
  if (!isObject(value)) return false;
  return (value.exposure === 'all' || value.exposure === 'allow_users' || value.exposure === 'deny_users')
    && isBoundedStringArray(value.usernames, 100)
    && (value.departmentIds === undefined || isBoundedStringArray(value.departmentIds, 64, 50))
    && (value.roles === undefined || isBoundedStringArray(value.roles, 64, 30));
}

function isGuardrail(value: unknown): boolean {
  if (!isObject(value)) return false;
  return typeof value.enabled === 'boolean'
    && typeof value.scopeDescription === 'string'
    && typeof value.rejectionMessage === 'string'
    && (value.strictness === 'strict' || value.strictness === 'lenient')
    && (value.mode === undefined || value.mode === 'off' || value.mode === 'shadow' || value.mode === 'enforce');
}

function isOrgAgentRecord(value: unknown): value is OrgAgentAdminRecord {
  if (!isObject(value)) return false;
  return typeof value.id === 'string'
    && typeof value.tenantId === 'string'
    && typeof value.name === 'string'
    && (value.avatar === undefined || typeof value.avatar === 'string')
    && (value.avatarVersion === undefined || typeof value.avatarVersion === 'number')
    && typeof value.description === 'string'
    && isStringArray(value.starterPrompts)
    && typeof value.instructions === 'string'
    && isStringArray(value.allowedSkills)
    && (value.allowedKnowledge === undefined || isStringArray(value.allowedKnowledge))
    && (value.runtime === undefined || isObject(value.runtime))
    && isAudience(value.audience)
    && isGuardrail(value.guardrail)
    && typeof value.enabled === 'boolean'
    && typeof value.createdAt === 'string'
    && typeof value.createdBy === 'string'
    && typeof value.updatedAt === 'string'
    && typeof value.updatedBy === 'string';
}

export interface OrgAgentDataIssue {
  key: string;
  resourceId?: string;
  message: string;
}

/**
 * 管理列表的数据合同边界。单条脏数据被隔离而不是拖垮整页；尤其 audience 无效时，
 * 绝不推断 exposure，也不让该资源进入启用、编辑或可见范围判断。
 */
export function parseOrgAgentAdminList(input: unknown): {
  agents: OrgAgentAdminRecord[];
  issues: OrgAgentDataIssue[];
} {
  if (!Array.isArray(input)) throw new Error('企业专家接口返回格式无效，请重试');
  const agents: OrgAgentAdminRecord[] = [];
  const issues: OrgAgentDataIssue[] = [];

  input.forEach((item, index) => {
    if (isOrgAgentRecord(item)) {
      agents.push(item);
      return;
    }
    const resourceId = isObject(item) && typeof item.id === 'string' ? item.id : undefined;
    const audienceInvalid = !isObject(item) || !isAudience(item.audience);
    issues.push({
      key: resourceId ?? `index-${index}`,
      ...(resourceId ? { resourceId } : {}),
      message: audienceInvalid
        ? '可见范围配置缺失或格式错误，已按安全策略隐藏'
        : '资源字段缺失或格式错误，已安全隔离',
    });
  });

  return { agents, issues };
}

/**
 * 门禁 UI 三档：
 * - off：不跑门禁
 * - shadow：跑门禁 + 全量落库，但判定不生效（新专家上线前观察 3-7 天）
 * - enforce：门禁生效 + 落库（正式上线）
 *
 * 兼容性：后端 `guardrail.enabled` 保留为 `mode !== 'off'`。shadow/enforce 的差异
 * 由后端读取 scopeDescription 前缀的 `<!--gate-slots:{...}-->` JSON 段辨认。
 * 前端不改 shared 类型，通过 scopeDescription 序列化承载结构化数据（allowExamples /
 * rejectExamples / mode），后端逐步接管后可切换到独立字段。
 */
export type OrgAgentGuardrailMode = 'off' | 'shadow' | 'enforce';

/** 表单草稿（创建/编辑共用；id 缺省 = 创建） */
export interface OrgAgentFormValues {
  name: string;
  /** emoji 草稿；图片头像不进此字段 */
  avatar: string;
  /** 当前图片头像预览 URL；null = 无图片（编辑时初始化自记录，上传/移除时更新） */
  avatarImageUrl: string | null;
  /** 治理定义保存的 emoji 或 org-agent-avatars/... 路径。 */
  avatarStoredPath: string;
  description: string;
  starterPromptsText: string;
  instructions: string;
  allowedSkills: string[];
  /** 每行一个知识资源 id；MVP 期间按 tenant-owned Skill id 注入。 */
  allowedKnowledgeText: string;
  audienceExposure: OrgAgentAudience['exposure'];
  audienceUserIds: string[];
  audienceGroupIds: string[];
  runtime: OrgAgentRuntimePolicy;
  /** 门禁 UI 三档；序列化时 off → enabled:false，shadow/enforce → enabled:true */
  guardrailMode: OrgAgentGuardrailMode;
  /** "允许问的问题类型"填空题（3-5 条示例） */
  guardrailAllowExamples: string[];
  /** "拒绝问的问题类型"填空题（3-5 条示例） */
  guardrailRejectExamples: string[];
  /** 门禁范围描述（保留字段作为兜底/自定义补充；填空题拼装后覆盖为完整 prompt） */
  guardrailScopeDescription: string;
  guardrailRejectionMessage: string;
  guardrailStrictness: 'strict' | 'lenient';
  enabled: boolean;
}

export const DEFAULT_REJECTION_MESSAGE = '这个问题超出了我的职责范围，暂时无法回答。';

/**
 * scopeDescription 中的结构化标记前缀。
 * 保存时：`<!--gate-slots:{"mode":"shadow","allowExamples":[...],"rejectExamples":[...]}-->` + 拼装的可读 prompt
 * 加载时：优先解析标记；无标记则作为兜底 raw scopeDescription 回填。
 */
const GATE_SLOTS_MARKER_START = '<!--gate-slots:';
const GATE_SLOTS_MARKER_END = '-->';

interface GateSlotsPayload {
  mode: OrgAgentGuardrailMode;
  allowExamples: string[];
  rejectExamples: string[];
}

export function parseGateSlots(scopeDescription: string): {
  slots: GateSlotsPayload | null;
  rawScope: string;
} {
  if (!scopeDescription.startsWith(GATE_SLOTS_MARKER_START)) {
    return { slots: null, rawScope: scopeDescription };
  }
  const end = scopeDescription.indexOf(GATE_SLOTS_MARKER_END);
  if (end < 0) return { slots: null, rawScope: scopeDescription };
  const jsonText = scopeDescription.slice(GATE_SLOTS_MARKER_START.length, end);
  try {
    const parsed = JSON.parse(jsonText) as Partial<GateSlotsPayload>;
    const mode: OrgAgentGuardrailMode =
      parsed.mode === 'off' || parsed.mode === 'shadow' || parsed.mode === 'enforce'
        ? parsed.mode
        : 'enforce';
    const allowExamples = Array.isArray(parsed.allowExamples)
      ? parsed.allowExamples.filter((item): item is string => typeof item === 'string')
      : [];
    const rejectExamples = Array.isArray(parsed.rejectExamples)
      ? parsed.rejectExamples.filter((item): item is string => typeof item === 'string')
      : [];
    return {
      slots: { mode, allowExamples, rejectExamples },
      rawScope: scopeDescription.slice(end + GATE_SLOTS_MARKER_END.length).trim(),
    };
  } catch {
    return { slots: null, rawScope: scopeDescription };
  }
}

/**
 * 前端拼装的 scopeDescription（三段填空题拼成结构化 prompt）：
 * <!--gate-slots:{"mode":"shadow","allowExamples":[...],"rejectExamples":[...]}-->
 * 【职责】{description}
 *
 * 【允许问】
 * · {allowExamples[0]}
 * ...
 *
 * 【拒绝问】
 * · {rejectExamples[0]}
 * ...
 *
 * 【拿不准时】拒答 | 放行并打标
 */
export function assembleScopeDescription(input: {
  mode: OrgAgentGuardrailMode;
  description: string;
  allowExamples: string[];
  rejectExamples: string[];
  strictness: 'strict' | 'lenient';
  rawScope?: string;
}): string {
  const marker = `${GATE_SLOTS_MARKER_START}${JSON.stringify({
    mode: input.mode,
    allowExamples: input.allowExamples,
    rejectExamples: input.rejectExamples,
  })}${GATE_SLOTS_MARKER_END}`;
  const lines: string[] = [];
  if (input.description.trim()) {
    lines.push(`【职责】${input.description.trim()}`);
    lines.push('');
  }
  if (input.allowExamples.length > 0) {
    lines.push('【允许问】');
    for (const item of input.allowExamples) lines.push(`· ${item}`);
    lines.push('');
  }
  if (input.rejectExamples.length > 0) {
    lines.push('【拒绝问】');
    for (const item of input.rejectExamples) lines.push(`· ${item}`);
    lines.push('');
  }
  lines.push(
    `【拿不准时】${input.strictness === 'strict' ? '拒答' : '放行并打标'}`,
  );
  if (input.rawScope && input.rawScope.trim()) {
    lines.push('');
    lines.push('【补充说明】');
    lines.push(input.rawScope.trim());
  }
  return `${marker}\n${lines.join('\n')}`.trim();
}

export function defaultOrgAgentRuntimePolicy(): OrgAgentRuntimePolicy {
  return {
    schemaVersion: 1,
    executionMode: 'direct',
    workerModel: { strategy: 'inherit' },
    context: { modules: null },
    model: { strategy: 'inherit' },
    memory: { scope: 'inherit' },
    limits: { maxTurns: null },
    capabilities: {
      shell: 'inherit',
      backgroundTasks: 'inherit',
      interaction: 'inherit',
      subagents: 'inherit',
      scheduling: 'inherit',
    },
    tools: { allowlist: null, denylist: [] },
    mcp: { serverAllowlist: null, toolAllowlist: null, denyServers: [], denyTools: [] },
    execution: { allowedTargets: null },
  };
}

export function emptyFormValues(): OrgAgentFormValues {
  return {
    name: '',
    avatar: '',
    avatarImageUrl: null,
    avatarStoredPath: '',
    description: '',
    starterPromptsText: '',
    instructions: '',
    allowedSkills: [],
    allowedKnowledgeText: '',
    audienceExposure: 'all',
    audienceUserIds: [],
    audienceGroupIds: [],
    runtime: defaultOrgAgentRuntimePolicy(),
    guardrailMode: 'off',
    guardrailAllowExamples: [],
    guardrailRejectExamples: [],
    guardrailScopeDescription: '',
    guardrailRejectionMessage: DEFAULT_REJECTION_MESSAGE,
    guardrailStrictness: 'strict',
    enabled: true,
  };
}

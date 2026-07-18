export type {
  OrgAgentAudience,
  OrgAgentGuardrailConfig,
  OrgAgentRecord,
  OrgAgentSummary,
} from '@agent/shared';

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
  description: string;
  starterPromptsText: string;
  instructions: string;
  allowedSkills: string[];
  audienceExposure: 'all' | 'allow_users';
  audienceUsernames: string[];
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

export function emptyFormValues(): OrgAgentFormValues {
  return {
    name: '',
    avatar: '',
    avatarImageUrl: null,
    description: '',
    starterPromptsText: '',
    instructions: '',
    allowedSkills: [],
    audienceExposure: 'all',
    audienceUsernames: [],
    guardrailMode: 'off',
    guardrailAllowExamples: [],
    guardrailRejectExamples: [],
    guardrailScopeDescription: '',
    guardrailRejectionMessage: DEFAULT_REJECTION_MESSAGE,
    guardrailStrictness: 'strict',
    enabled: true,
  };
}

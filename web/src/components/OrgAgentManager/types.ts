export type {
  OrgAgentAudience,
  OrgAgentGuardrailConfig,
  OrgAgentRecord,
  OrgAgentSummary,
} from '@agent/shared';

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
  guardrailEnabled: boolean;
  guardrailScopeDescription: string;
  guardrailRejectionMessage: string;
  guardrailStrictness: 'strict' | 'lenient';
  enabled: boolean;
}

export const DEFAULT_REJECTION_MESSAGE = '这个问题超出了我的职责范围，暂时无法回答。';

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
    guardrailEnabled: false,
    guardrailScopeDescription: '',
    guardrailRejectionMessage: DEFAULT_REJECTION_MESSAGE,
    guardrailStrictness: 'strict',
    enabled: true,
  };
}

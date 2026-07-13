export type {
  OrgAgentAudience,
  OrgAgentGuardrailConfig,
  OrgAgentRecord,
  OrgAgentSummary,
} from '@agent/shared';

/** 表单草稿（创建/编辑共用；id 缺省 = 创建） */
export interface OrgAgentFormValues {
  name: string;
  avatar: string;
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

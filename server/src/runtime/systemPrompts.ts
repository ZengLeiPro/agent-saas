import { GUARDRAIL_SYSTEM_PROMPT } from '../agent/guardrail.js';
import { TITLE_SYSTEM_PROMPT } from '../agent/titleGenerator.js';
import { loadPrompt } from './promptRenderer.js';
import { IMAGE_UNDERSTANDING_SYSTEM_PROMPT } from './imageUnderstanding.js';
import {
  EXPLORE_SYSTEM_PROMPT,
  GENERAL_SYSTEM_PROMPT,
} from './subagent/agentTypes.js';
import {
  SYSTEM_PROMPT_IDS,
  isSystemPromptId,
  type SystemPromptId,
  type SystemPromptOverrides,
} from '../systemPrompts/types.js';

export {
  SYSTEM_PROMPT_IDS,
  isSystemPromptId,
  type SystemPromptId,
  type SystemPromptOverrides,
} from '../systemPrompts/types.js';

export const MINIMAL_SYSTEM_PROMPT = '你是运行在开沿科技公司开发的 Agent 平台上的 AI 助理。';

export interface SystemPromptDefinition {
  id: SystemPromptId;
  category: 'main' | 'subagent' | 'utility';
  label: string;
  description: string;
  variables: string[];
  defaultContent: string;
}

export interface SystemPromptView extends SystemPromptDefinition {
  content: string;
  overridden: boolean;
}

const DEFINITIONS_META: ReadonlyArray<Omit<SystemPromptDefinition, 'defaultContent'>> = [
  {
    id: 'main.static',
    category: 'main',
    label: '主 Agent · 平台静态规则',
    description: '主 Agent 最稳定的公共前缀，覆盖语言、执行纪律、风险边界和工具使用原则。',
    variables: [],
  },
  {
    id: 'main.dynamicShared',
    category: 'main',
    label: '主 Agent · 组织上下文模板',
    description: '按组织渲染公司事实基础；这里只编辑模板，不在这里编辑具体组织资料。',
    variables: ['COMPANY_INFO'],
  },
  {
    id: 'main.runtimeMemory',
    category: 'main',
    label: '主 Agent · 记忆能力规则',
    description: '仅在当前运行具备记忆检索能力时注入。',
    variables: [],
  },
  {
    id: 'main.dynamicPersonal',
    category: 'main',
    label: '主 Agent · 用户与人格模板',
    description: '按用户、Persona、专职 Agent 和权限状态渲染的个人上下文。',
    variables: [
      'CURRENT_USER',
      'AGENT_NAME',
      'PERSONA',
      'USER_CWD',
      'IF_PERSONA',
      'IF_NO_PERSONA',
      'IF_NOT_ADMIN',
      'IF_ORG_AGENT',
      'ORG_AGENT_INSTRUCTIONS',
    ],
  },
  {
    id: 'main.minimal',
    category: 'main',
    label: '主 Agent · 最小提示语',
    description: '系统任务显式跳过完整系统提示语时使用的最小身份声明。',
    variables: [],
  },
  {
    id: 'subagent.general',
    category: 'subagent',
    label: '子 Agent · 通用执行者',
    description: 'general 子 Agent 的角色和工作纪律，不包含父会话历史。',
    variables: [],
  },
  {
    id: 'subagent.explore',
    category: 'subagent',
    label: '子 Agent · 只读侦察员',
    description: 'explore 子 Agent 的角色和只读侦察纪律。',
    variables: [],
  },
  {
    id: 'utility.title',
    category: 'utility',
    label: '辅助模型 · 会话标题',
    description: '会话自动标题生成模型的 system message。',
    variables: [],
  },
  {
    id: 'utility.guardrail',
    category: 'utility',
    label: '辅助模型 · 话题门禁',
    description: '专职 Agent 范围判断模型的 system message；输出契约与代码解析器必须保持一致。',
    variables: [],
  },
  {
    id: 'utility.imageUnderstanding',
    category: 'utility',
    label: '辅助模型 · 图片理解',
    description: '主模型不支持图片时，独立视觉模型使用的 system message。',
    variables: [],
  },
];

export class SystemPromptRegistry {
  private readonly definitions: ReadonlyMap<SystemPromptId, Omit<SystemPromptDefinition, 'defaultContent'>>;
  private readonly sharedDir: string;
  private overrides: SystemPromptOverrides;

  constructor(sharedDir: string, overrides: SystemPromptOverrides = {}) {
    this.sharedDir = sharedDir;
    this.definitions = new Map(DEFINITIONS_META.map((meta) => [meta.id, meta]));
    this.overrides = normalizeOverrides(overrides);
  }

  get(id: SystemPromptId): string {
    if (!this.definitions.has(id)) throw new Error(`未知系统提示语：${id}`);
    return this.overrides[id] ?? this.getDefault(id);
  }

  list(): SystemPromptView[] {
    return SYSTEM_PROMPT_IDS.map((id) => {
      const definition = this.definitions.get(id)!;
      return {
        ...definition,
        defaultContent: this.getDefault(id),
        content: this.get(id),
        overridden: Object.prototype.hasOwnProperty.call(this.overrides, id),
      };
    });
  }

  replaceOverrides(overrides: SystemPromptOverrides): void {
    this.overrides = normalizeOverrides(overrides);
  }

  private getDefault(id: SystemPromptId): string {
    switch (id) {
      case 'main.static': return loadPrompt(this.sharedDir, 'static');
      case 'main.dynamicShared': return loadPrompt(this.sharedDir, 'dynamic-shared');
      case 'main.runtimeMemory': return loadPrompt(this.sharedDir, 'runtime-memory');
      case 'main.dynamicPersonal': return loadPrompt(this.sharedDir, 'dynamic-personal');
      case 'main.minimal': return MINIMAL_SYSTEM_PROMPT;
      case 'subagent.general': return GENERAL_SYSTEM_PROMPT;
      case 'subagent.explore': return EXPLORE_SYSTEM_PROMPT;
      case 'utility.title': return TITLE_SYSTEM_PROMPT;
      case 'utility.guardrail': return GUARDRAIL_SYSTEM_PROMPT;
      case 'utility.imageUnderstanding': return IMAGE_UNDERSTANDING_SYSTEM_PROMPT;
    }
  }
}

function normalizeOverrides(overrides: SystemPromptOverrides): SystemPromptOverrides {
  return Object.fromEntries(
    Object.entries(overrides).flatMap(([id, content]) => (
      isSystemPromptId(id) && typeof content === 'string' && content.trim()
        ? [[id, content.trim()]]
        : []
    )),
  );
}

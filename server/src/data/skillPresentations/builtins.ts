import builtinPresentations from './builtins.zh-CN.json' with { type: 'json' };

export interface BuiltinSkillPresentation {
  skillId: string;
  displayName: string;
  summary: string;
}

export const BUILTIN_SKILL_PRESENTATIONS: readonly BuiltinSkillPresentation[] =
  builtinPresentations;

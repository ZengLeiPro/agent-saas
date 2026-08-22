export const SYSTEM_PROMPT_IDS = [
  'main.static',
  'main.staticV2',
  'main.dynamicShared',
  'main.dynamicTenant',
  'main.runtimeMemory',
  'main.dynamicPersonal',
  'main.taskboardExecution',
  'main.minimal',
  'subagent.general',
  'subagent.explore',
  'utility.title',
  'utility.guardrail',
  'utility.imageUnderstanding',
  'utility.compaction',
] as const;

export type SystemPromptId = typeof SYSTEM_PROMPT_IDS[number];
export type SystemPromptOverrides = Partial<Record<SystemPromptId, string>>;

export function isSystemPromptId(value: string): value is SystemPromptId {
  return (SYSTEM_PROMPT_IDS as readonly string[]).includes(value);
}

import type { SkillInfo } from '@agent/shared';

export function skillDisplayName(skill: SkillInfo): string {
  return skill.presentation?.displayName?.trim() || skill.name;
}

export function skillDisplaySummary(skill: SkillInfo): string {
  return skill.presentation?.summary?.trim() || skill.description;
}

export function skillPresentationRevision(skill: SkillInfo): number {
  return skill.presentation?.revision ?? 0;
}

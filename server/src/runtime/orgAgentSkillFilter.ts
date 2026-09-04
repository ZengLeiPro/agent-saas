import { resolveOrgAgentRuntimeSkillIds } from '../data/orgAgents/runtimePolicy.js';
import type { OrgAgentRecord } from '../data/orgAgents/types.js';
import type { ChannelContext } from '../types/index.js';
import type { SkillEntry } from '../agent/skillToolProvider.js';

type RuntimeSkillFilter = (skill: SkillEntry) => boolean;

export function buildOrgAgentSkillFilter(
  agent: Pick<OrgAgentRecord, 'allowedSkills' | 'allowedKnowledge'>,
): RuntimeSkillFilter {
  const allowed = new Set(resolveOrgAgentRuntimeSkillIds(agent));
  return (skill) => allowed.has(skill.id);
}

export function buildOrgAgentChannelSkillFilter(
  channel: ChannelContext['orgAgentChannel'],
): RuntimeSkillFilter {
  if (!channel) return () => true;
  const allowed = new Set(channel.allowedSkillIds);
  return (skill) => allowed.has(skill.id);
}

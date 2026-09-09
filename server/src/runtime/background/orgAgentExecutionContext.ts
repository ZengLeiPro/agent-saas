import { z } from 'zod';

import { agentRuntimeProfileConfigSchema } from '../../data/agentProfiles/types.js';
import {
  orgAgentRuntimePolicySchema,
  parseOrgAgentRuntimePolicy,
} from '../../data/orgAgents/runtimePolicy.js';
import type { OrgAgentRecord } from '../../data/orgAgents/types.js';
import type { OrgAgentChannelBinding } from '../../data/orgGroupAgents/types.js';
import type { ChannelContext } from '../../types/index.js';
import type { BoundAgentRuntimeProfile } from '../agentProfiles.js';
import type { OrgAgentSessionSnapshot } from '../sessionCatalog.js';

export const ORG_AGENT_EXECUTION_CONTEXT_VERSION = 1 as const;

const stringList = z.array(z.string().trim().min(1));
const executionContextSchema = z
  .object({
    version: z.literal(ORG_AGENT_EXECUTION_CONTEXT_VERSION),
    revisions: z
      .object({
        binding: z.number().int().min(1),
        agentUpdatedAt: z.string().min(1),
        profileVersionId: z.string().min(1).optional(),
        profileConfigDigest: z.string().min(1).optional(),
      })
      .strict(),
    agent: z
      .object({
        id: z.string().min(1),
        name: z.string(),
        instructions: z.string(),
        runtime: orgAgentRuntimePolicySchema,
      })
      .strict(),
    channel: z
      .object({
        bindingId: z.string().min(1),
        workConversationId: z.string().min(1),
        instructions: z.string(),
        systemContext: z.string(),
        memories: z.array(
          z
            .object({
              memoryId: z.string().min(1),
              scope: z.enum(['agent', 'conversation', 'task_checkpoint']),
              content: z.record(z.string(), z.unknown()),
              policyRevision: z.number().int().min(1),
              version: z.number().int().min(1),
            })
            .strict(),
        ),
      })
      .strict(),
    capabilities: z
      .object({
        toolNames: stringList,
        skillIds: stringList,
        sourceIds: stringList,
        dwsResourceIds: stringList,
        contextEnabled: z.boolean(),
      })
      .strict(),
    model: z
      .object({
        modelRef: z.string().min(1),
        profileConfig: agentRuntimeProfileConfigSchema.optional(),
      })
      .strict(),
    task: z.object({ goal: z.string().min(1), acceptance: z.array(z.string().min(1)) }).strict(),
  })
  .strict();

export type OrgAgentEffectiveExecutionContext = z.infer<typeof executionContextSchema>;

export function createOrgAgentEffectiveExecutionContext(input: {
  agent: OrgAgentRecord;
  binding: OrgAgentChannelBinding;
  channel: NonNullable<ChannelContext['orgAgentChannel']>;
  systemContext?: string;
  modelRef: string;
  profile?: BoundAgentRuntimeProfile;
  goal: string;
  acceptance: string[];
}): OrgAgentEffectiveExecutionContext {
  if (!input.channel.sharedContext) throw new Error('ORG_AGENT_EXECUTION_CONTEXT_INCOMPLETE');
  if (
    input.agent.tenantId !== input.binding.tenantId ||
    input.agent.id !== input.binding.agentId ||
    input.binding.bindingId !== input.channel.bindingId ||
    input.binding.revision !== input.channel.policyRevision
  )
    throw new Error('ORG_AGENT_EXECUTION_CONTEXT_IDENTITY_MISMATCH');
  return executionContextSchema.parse({
    version: ORG_AGENT_EXECUTION_CONTEXT_VERSION,
    revisions: {
      binding: input.binding.revision,
      agentUpdatedAt: input.agent.updatedAt,
      ...(input.profile
        ? {
            profileVersionId: input.profile.version.profileVersionId,
            profileConfigDigest: input.profile.version.configDigest,
          }
        : {}),
    },
    agent: {
      id: input.agent.id,
      name: input.agent.name,
      instructions: input.agent.instructions,
      runtime: parseOrgAgentRuntimePolicy(input.agent.runtime),
    },
    channel: {
      bindingId: input.binding.bindingId,
      workConversationId: input.channel.workConversationId,
      instructions: input.channel.sharedContext.instructions,
      systemContext: input.systemContext ?? '',
      memories: input.channel.sharedContext.memories,
    },
    capabilities: {
      toolNames: input.channel.allowedToolNames,
      skillIds: input.channel.allowedSkillIds,
      sourceIds: input.channel.allowedSourceIds,
      dwsResourceIds: input.channel.dwsResourceIds,
      contextEnabled: input.channel.contextEnabled,
    },
    model: {
      modelRef: input.modelRef,
      ...(input.profile ? { profileConfig: input.profile.version.config } : {}),
    },
    task: { goal: input.goal, acceptance: input.acceptance },
  });
}

export function parseOrgAgentEffectiveExecutionContext(
  policySnapshot: Record<string, unknown>,
): OrgAgentEffectiveExecutionContext {
  const parsed = executionContextSchema.safeParse(policySnapshot.executionContext);
  if (!parsed.success) throw new Error('ORG_AGENT_EXECUTION_CONTEXT_MISSING_OR_INVALID');
  return parsed.data;
}

export function executionContextSessionSnapshot(
  context: OrgAgentEffectiveExecutionContext,
): OrgAgentSessionSnapshot {
  return {
    name: context.agent.name,
    instructions: context.agent.instructions,
    allowedSkills: [...context.capabilities.skillIds],
    allowedKnowledge: [],
    runtime: context.agent.runtime,
  };
}

export function executionContextInstructions(context: OrgAgentEffectiveExecutionContext): string {
  return [context.agent.instructions, context.channel.instructions, context.channel.systemContext]
    .map((value) => value.trim())
    .filter(Boolean)
    .join('\n\n');
}

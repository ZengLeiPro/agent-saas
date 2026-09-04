import { z } from 'zod';

import type { OrgAgentEffectiveConfig } from '../data/orgGroupAgents/index.js';

export const groupWorkspaceQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const groupWorkspaceUpdateSchema = z
  .object({
    conversationId: z.string().trim().min(1).max(1024),
    expectedRevision: z.number().int().positive(),
    enabled: z.boolean(),
    policy: z
      .object({
        enabled: z.boolean(),
        membership: z.enum(['members', 'members_and_guests']),
        guest: z.enum(['deny', 'shared_read_only']),
        taskVisibility: z.enum(['conversation', 'requester_only']),
        completion: z.enum(['reply_to_work_conversation', 'silent']),
        liveDeny: z.boolean(),
      })
      .strict(),
    effectiveConfig: z
      .object({
        identity: z.object({ displayName: z.string().trim().min(1).max(80).optional() }).strict(),
        instructions: z
          .object({ system: z.string().trim().max(20_000) })
          .strict()
          .optional(),
        knowledge: z
          .object({
            contextEnabled: z.boolean(),
            sourceIds: z.array(z.string().min(1).max(200)).max(100),
          })
          .strict(),
        capabilities: z
          .object({
            skillIds: z.array(z.string().min(1).max(200)).max(100),
            toolNames: z.array(z.string().min(1).max(200)).max(100),
            dwsResourceIds: z
              .array(
                z
                  .string()
                  .trim()
                  .min(3)
                  .max(1_200)
                  .regex(/^[a-z][a-z0-9_-]{0,31}:.+$/, 'DWS 资源必须使用 <module>:<resourceId>'),
              )
              .max(200)
              .optional(),
          })
          .strict(),
        memory: z
          .object({
            readAgent: z.boolean(),
            readConversation: z.boolean(),
            adminWriteConversation: z.boolean(),
          })
          .strict()
          .optional(),
        access: z
          .object({
            triggerRoles: z.array(z.enum(['member', 'org_admin'])).max(2),
            approvalRoles: z.array(z.enum(['member', 'org_admin'])).max(2),
          })
          .strict(),
        speech: z.object({ proactive: z.boolean(), requireMention: z.boolean() }).strict(),
      })
      .strict(),
  })
  .strict();

export const deliveryReconcileSchema = z
  .object({
    outcome: z.enum(['confirmed_sent', 'confirmed_not_sent', 'indeterminate']),
    reason: z.string().trim().min(1).max(1000),
    evidence: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  })
  .strict();

export const memoryPromoteSchema = z
  .object({
    reason: z.string().trim().min(1).max(1000),
    policyRevision: z.number().int().positive(),
  })
  .strict();
export const memoryCreateSchema = z
  .object({
    bindingId: z.string().trim().min(1),
    workConversationId: z.string().trim().min(1).optional(),
    workOrderId: z.string().trim().min(1).optional(),
    memoryScope: z.enum(['conversation', 'task_checkpoint']),
    content: z.record(z.string(), z.unknown()),
    provenance: z.record(z.string(), z.unknown()),
    policyRevision: z.number().int().positive(),
  })
  .strict();
export const memoryStatusSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    status: z.enum(['revoked', 'deleted']),
  })
  .strict();
export const workOrderActionSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    action: z.enum([
      'cancel',
      'retry',
      'publish',
      'amend',
      'pause',
      'resume',
      'review',
      'reassign',
    ]),
    text: z.string().trim().min(1).max(20_000).optional(),
    workerType: z.enum(['general', 'explore']).optional(),
  })
  .strict();

export function mergeGroupWorkspaceEffectiveConfig(
  current: OrgAgentEffectiveConfig,
  patch: z.infer<typeof groupWorkspaceUpdateSchema>['effectiveConfig'],
): OrgAgentEffectiveConfig {
  return {
    ...patch,
    instructions: patch.instructions ?? current.instructions,
    capabilities: {
      ...patch.capabilities,
      dwsResourceIds: patch.capabilities.dwsResourceIds ?? current.capabilities.dwsResourceIds,
    },
    memory: patch.memory ?? current.memory,
  };
}

export function groupDwsCapabilityError(
  config: OrgAgentEffectiveConfig,
  enforce: boolean,
): string | undefined {
  if (!enforce) return undefined;
  if (
    config.capabilities.toolNames.includes('DwsBusiness') &&
    config.capabilities.dwsResourceIds.length === 0
  )
    return '启用群聊 DwsBusiness 必须显式配置可访问的 DWS 资源';
  if (config.capabilities.toolNames.includes('DwsBusiness')
    && !config.access.approvalRoles.includes('org_admin'))
    return '启用 DwsBusiness 时必须允许组织管理员审批';
  if (
    !config.capabilities.toolNames.includes('DwsBusiness') &&
    config.capabilities.dwsResourceIds.length > 0
  )
    return '配置 DWS 资源前必须先启用 DwsBusiness';
  return undefined;
}

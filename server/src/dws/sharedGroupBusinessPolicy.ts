import { z } from 'zod';

import type { ChannelContext } from '../types/index.js';
import {
  classifyDwsBusinessCommand,
  DwsCommandPolicyError,
  type ClassifiedDwsCommand,
} from './commandPolicy.js';

const sharedGroupInputSchema = z
  .object({
    args: z.array(z.string().min(1).max(1_000)).min(2).max(80),
    credentialMode: z.enum(['agent', 'requester']).default('agent'),
    confirmed: z.boolean().optional(),
  })
  .strict();

// 这是组织共享数据面的模块级上限；具体命令是否存在、读写风险及高影响拒绝仍只由
// classifyDwsBusinessCommand 的 CLI catalog 判定，避免在群策略里维护第二份命令表。
const SHARED_ORGANIZATION_MODULES: ReadonlySet<string> = new Set([
  'aitable',
  'axls',
  'devdoc',
  'doc',
  'drive',
  'kb',
  'markdown',
  'sheet',
  'table',
  'whiteboard',
  'wiki',
]);

type OrgAgentChannel = NonNullable<ChannelContext['orgAgentChannel']>;

export type SharedGroupDwsDecision =
  | { allowed: true; command: ClassifiedDwsCommand }
  | { allowed: false; reason: string; command?: ClassifiedDwsCommand };

export function decideSharedGroupDwsAction(input: {
  toolInput: unknown;
  channel: OrgAgentChannel;
  executionRole?: 'worker';
}): SharedGroupDwsDecision {
  if (input.executionRole === 'worker') {
    return { allowed: false, reason: 'organization Worker cannot use DwsBusiness' };
  }
  if (
    input.channel.externalActor.kind === 'service_event' ||
    input.channel.externalActorAssurance === 'service'
  ) {
    return { allowed: false, reason: 'service event cannot use DwsBusiness' };
  }
  const parsed = sharedGroupInputSchema.safeParse(input.toolInput);
  if (!parsed.success) return { allowed: false, reason: 'invalid DwsBusiness input' };
  if (parsed.data.credentialMode !== 'agent') {
    return { allowed: false, reason: 'shared group cannot use requester DWS credentials' };
  }
  let command: ClassifiedDwsCommand;
  try {
    command = classifyDwsBusinessCommand(parsed.data.args);
  } catch (error) {
    return {
      allowed: false,
      reason:
        error instanceof DwsCommandPolicyError
          ? 'DWS command is unknown, destructive, or outside the shared-group boundary'
          : 'DWS command classification failed',
    };
  }
  if (!SHARED_ORGANIZATION_MODULES.has(command.module)) {
    return {
      allowed: false,
      reason: 'personal or unscoped DWS data is unavailable in shared groups',
      command,
    };
  }
  if (command.risk === 'read') {
    if (!['mapped', 'unmapped'].includes(input.channel.externalActorAssurance)) {
      return {
        allowed: false,
        reason: 'external actor identity is not eligible for shared reads',
        command,
      };
    }
    return { allowed: true, command };
  }
  if (
    input.channel.externalActorAssurance !== 'mapped' ||
    input.channel.externalActor.assurance !== 'mapped' ||
    !input.channel.actorRole ||
    !input.channel.approvalRoles.includes(input.channel.actorRole) ||
    parsed.data.confirmed !== true
  ) {
    return {
      allowed: false,
      reason: 'shared-group DWS writes require a mapped approved actor and explicit confirmation',
      command,
    };
  }
  return { allowed: true, command };
}

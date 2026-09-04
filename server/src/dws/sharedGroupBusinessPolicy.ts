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

interface SharedResourceSelectorSchema {
  required: readonly string[];
}

// 群共享入口刻意只开放已逐条复核资源选择器的命令。命令风险目录只回答“能否调用”，
// 这里单独回答“资源边界能否被确定性证明”；未登记命令一律拒绝。
const SHARED_RESOURCE_SELECTORS_BY_COMMAND = new Map<string, SharedResourceSelectorSchema>([
  ['doc.info', { required: ['--node'] }],
  ['doc.read', { required: ['--node'] }],
  ['doc.list', { required: ['--folder'] }],
  ['doc.update', { required: ['--node'] }],
  ['doc.copy', { required: ['--node', '--folder'] }],
]);
const SHARED_RESOURCE_SELECTOR_FLAGS = new Set(['--node', '--folder', '--workspace']);

type OrgAgentChannel = NonNullable<ChannelContext['orgAgentChannel']>;

export type SharedGroupDwsDecision =
  | { allowed: true; command: ClassifiedDwsCommand }
  | { allowed: false; reason: string; command?: ClassifiedDwsCommand };

export function decideSharedGroupDwsAction(input: {
  toolInput: unknown;
  channel: OrgAgentChannel;
  resourceAllowlist?: readonly string[];
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
  const targetResourceIds = extractSharedGroupResourceIds(command, parsed.data.args);
  if (!targetResourceIds || targetResourceIds.length === 0) {
    return {
      allowed: false,
      reason: 'DWS command has no deterministic shared-group resource target',
      command,
    };
  }
  const allowedResources = new Set(input.resourceAllowlist ?? []);
  const deniedResource = targetResourceIds.find(
    (resourceId) => !allowedResources.has(`${command.module}:${resourceId}`),
  );
  if (deniedResource) {
    return {
      allowed: false,
      reason: 'DWS resource is not allowlisted for the current group binding',
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

function extractSharedGroupResourceIds(
  command: ClassifiedDwsCommand,
  args: readonly string[],
): string[] | null {
  const schema = SHARED_RESOURCE_SELECTORS_BY_COMMAND.get(command.commandPath);
  if (!schema) return null;
  const values = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith('--')) continue;
    const separator = arg.indexOf('=');
    const flag = separator >= 0 ? arg.slice(0, separator) : arg;
    if (SHARED_RESOURCE_SELECTOR_FLAGS.has(flag) && !schema.required.includes(flag)) return null;
    if (!schema.required.includes(flag)) continue;
    const rawValue = separator >= 0 ? arg.slice(separator + 1) : args[index + 1];
    if (!rawValue || rawValue.startsWith('-') || rawValue !== rawValue.trim()) return null;
    values.set(flag, [...(values.get(flag) ?? []), rawValue]);
    if (separator < 0) index += 1;
  }
  if (schema.required.some((flag) => (values.get(flag)?.length ?? 0) !== 1)) return null;
  return schema.required.map((flag) => values.get(flag)![0]!);
}

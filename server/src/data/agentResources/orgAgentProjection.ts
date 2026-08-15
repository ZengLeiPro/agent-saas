import { z } from 'zod';

import type { OrgAgentStore } from '../orgAgents/store.js';
import {
  DEFAULT_ORG_AGENT_RUNTIME_POLICY,
  orgAgentRuntimePolicySchema,
} from '../orgAgents/runtimePolicy.js';
import { normalizeGuardrailConfig } from '../orgAgents/types.js';
import type { PgAgentResourceStore } from './store.js';

const starterPromptsSchema = z.array(z.string().trim().min(1).max(200))
  .max(6)
  .refine(items => new Set(items).size === items.length, 'starter prompts must be unique');

const skillSchema = z.object({ id: z.string().min(1).max(200) }).strict();

const guardrailSchema = z.object({
  mode: z.enum(['off', 'shadow', 'enforce']).optional(),
  enabled: z.boolean().optional(),
  scopeDescription: z.string().max(2000).default(''),
  rejectionMessage: z.string().min(1).max(500).default('这个问题超出了我的职责范围，暂时无法回答。'),
  strictness: z.enum(['strict', 'lenient']).default('strict'),
}).strict();

export const managedOrgAgentDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().trim().min(1).max(30),
  avatar: z.string().max(300).optional(),
  description: z.string().trim().max(500).default(''),
  starterPrompts: starterPromptsSchema.default([]),
  instructions: z.string().max(8000).default(''),
  skills: z.array(skillSchema).max(200).default([])
    .refine(items => new Set(items.map(item => item.id)).size === items.length, 'skills must be unique'),
  knowledge: z.array(z.string().min(1).max(200)).max(20).default([]),
  runtime: orgAgentRuntimePolicySchema.default(DEFAULT_ORG_AGENT_RUNTIME_POLICY),
  guardrail: guardrailSchema.default({
    mode: 'off', enabled: false, scopeDescription: '',
    rejectionMessage: '这个问题超出了我的职责范围，暂时无法回答。', strictness: 'strict',
  }),
  source: z.enum(['governance', 'legacy_projection']).default('governance'),
}).strict();

export type ManagedOrgAgentDefinition = z.infer<typeof managedOrgAgentDefinitionSchema>;

const projectionPayloadSchema = z.object({
  tenantId: z.string().min(2).max(64),
  agentId: z.string().min(2).max(96),
  versionId: z.string().min(2).max(128),
  resourceRevision: z.number().int().positive(),
}).strict();

export async function projectManagedOrgAgentVersion(
  deps: {
    agents: Pick<PgAgentResourceStore, 'getForTenant' | 'getVersion'>;
    legacyAgents: OrgAgentStore;
  },
  payload: Record<string, unknown>,
): Promise<void> {
  const parsedPayload = projectionPayloadSchema.safeParse(payload);
  if (!parsedPayload.success) throw new Error('GOVERNANCE_PROJECTION_INVALID');
  const { tenantId, agentId, versionId, resourceRevision } = parsedPayload.data;
  const [resource, version] = await Promise.all([
    deps.agents.getForTenant(tenantId, agentId),
    deps.agents.getVersion(versionId),
  ]);
  if (
    !resource || resource.kind !== 'org_agent' || resource.currentVersionId !== versionId
    || resource.revision !== resourceRevision || resource.status === 'draft' || resource.status === 'archived'
    || !version || version.agentId !== agentId
  ) {
    throw new Error('GOVERNANCE_PROJECTION_INVALID');
  }
  const parsedDefinition = managedOrgAgentDefinitionSchema.safeParse(version.definition);
  if (!parsedDefinition.success) throw new Error('GOVERNANCE_PROJECTION_INVALID');
  const definition = parsedDefinition.data;
  const guardrail = normalizeGuardrailConfig(definition.guardrail);
  const existing = deps.legacyAgents.get(agentId);
  if (existing && existing.tenantId !== tenantId) throw new Error('GOVERNANCE_PROJECTION_INVALID');
  const projected = {
    name: definition.name,
    ...(definition.avatar !== undefined ? { avatar: definition.avatar } : {}),
    description: definition.description,
    starterPrompts: definition.starterPrompts,
    instructions: definition.instructions,
    allowedSkills: definition.skills.map(item => item.id),
    allowedKnowledge: definition.knowledge,
    runtime: definition.runtime,
    guardrail,
    enabled: resource.status === 'enabled',
  };
  if (existing) {
    const updated = await deps.legacyAgents.update(agentId, projected, 'system:governance-projection');
    if (!updated) throw new Error('GOVERNANCE_PROJECTION_INVALID');
    return;
  }
  await deps.legacyAgents.create({
    id: agentId,
    tenantId,
    ...projected,
    // 新资源在治理 Assignment 投影完成前必须 fail closed，避免保存后半段失败时短暂全员可见。
    audience: { exposure: 'allow_users', usernames: [] },
  }, 'system:governance-projection');
}

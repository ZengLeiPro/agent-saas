import { z } from 'zod';

const idSchema = z.string().trim().min(1).max(120);
const textSchema = z.string().trim().min(1).max(500);
const authoritySchema = z.enum(['agent_intent', 'platform', 'connector', 'simulation']);
const platformAuthoritySchema = z.enum(['platform', 'connector', 'simulation']);
const eventBaseSchema = z.object({
  schemaVersion: z.literal(1),
  id: idSchema,
  sequence: z.number().int().nonnegative(),
  workflowId: idSchema,
  instanceId: idSchema,
  authority: authoritySchema,
});

const outcomeSchema = z.object({
  text: z.string().trim().min(1).max(120),
  tone: z.enum(['ok', 'warn', 'fail']).optional(),
  stat: z.array(z.object({
    label: z.string().trim().min(1).max(20),
    value: z.string().trim().min(1).max(40),
  }).strict()).max(6).optional(),
}).strict();

const stepDefinitionSchema = z.object({
  id: idSchema,
  title: z.string().trim().min(1).max(200),
  activeForm: z.string().trim().min(1).max(200).optional(),
}).strict();

const entryEventSchema = eventBaseSchema.extend({
  type: z.literal('entry'),
  authority: z.enum(['platform', 'simulation']),
  entryKind: z.enum(['business_event', 'user_request', 'scheduled_trigger']),
  title: z.string().trim().min(1).max(80),
  content: textSchema,
}).strict();

const planEventSchema = eventBaseSchema.extend({
  type: z.literal('plan'),
  authority: z.enum(['agent_intent', 'platform', 'simulation']),
  steps: z.array(stepDefinitionSchema).min(1).max(50),
}).strict();

const stepEventSchema = eventBaseSchema.extend({
  type: z.literal('step'),
  authority: z.enum(['agent_intent', 'platform', 'simulation']),
  stepId: idSchema,
  status: z.enum(['pending', 'in_progress', 'waiting', 'blocked', 'completed', 'failed']),
  activeForm: z.string().trim().min(1).max(200).optional(),
  outcome: outcomeSchema.optional(),
  detail: z.array(z.unknown()).max(60).optional(),
  display: z.array(z.unknown()).max(40).optional(),
  evidenceRefs: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
}).strict();

const activityEventSchema = eventBaseSchema.extend({
  type: z.literal('activity'),
  authority: platformAuthoritySchema,
  stepId: idSchema,
  activityId: idSchema,
  title: z.string().trim().min(1).max(200),
  status: z.enum(['running', 'success', 'error', 'blocked', 'waiting']),
  system: z.string().trim().min(1).max(80).optional(),
  operation: z.string().trim().min(1).max(120).optional(),
  detail: z.array(z.unknown()).max(60).optional(),
}).strict();

const effectFieldSchema = z.object({
  label: z.string().trim().min(1).max(120),
  value: z.string().trim().min(1).max(500),
  before: z.string().trim().min(1).max(500).optional(),
  state: z.enum(['neutral', 'pending', 'active', 'success', 'warning']).optional(),
}).strict();

const effectEventSchema = eventBaseSchema.extend({
  type: z.literal('effect'),
  authority: platformAuthoritySchema,
  stepId: idSchema,
  effectId: idSchema,
  effectType: z.enum(['source', 'record', 'communication', 'artifact', 'metric', 'verification']),
  system: z.string().trim().min(1).max(80),
  operation: z.enum(['read', 'create', 'update', 'send', 'approve', 'reject', 'verify']),
  title: z.string().trim().min(1).max(200),
  summary: textSchema.optional(),
  entity: z.object({
    type: idSchema,
    id: idSchema.optional(),
  }).strict(),
  fields: z.array(effectFieldSchema).max(40).optional(),
  receipt: z.object({
    id: idSchema,
    system: z.string().trim().min(1).max(80),
  }).strict().optional(),
  verification: z.enum(['none', 'receipt', 'read_back', 'simulated']),
  evidenceRefs: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
}).strict().superRefine((event, ctx) => {
  if (event.authority === 'simulation' && event.verification !== 'simulated') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['verification'], message: 'simulation effect 必须标记 simulated' });
  }
  if (event.authority !== 'simulation' && event.verification === 'simulated') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['verification'], message: '真实 effect 不得标记 simulated' });
  }
  if (event.verification === 'receipt' && !event.receipt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['receipt'], message: 'receipt verification 必须提供真实回执' });
  }
  if (event.verification === 'read_back' && !event.evidenceRefs?.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['evidenceRefs'], message: 'read_back verification 必须引用核对证据' });
  }
  if (event.verification === 'none' && event.receipt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['verification'], message: '已有回执时必须标记 receipt verification' });
  }
});

const gateFactSchema = z.object({
  label: z.string().trim().min(1).max(120),
  value: z.string().trim().min(1).max(500),
}).strict();

const gateRequestedEventSchema = eventBaseSchema.extend({
  type: z.literal('gate_requested'),
  authority: z.enum(['platform', 'simulation']),
  stepId: idSchema,
  gateId: idSchema,
  title: z.string().trim().min(1).max(200),
  description: textSchema,
  facts: z.array(gateFactSchema).min(1).max(20),
  approveLabel: z.string().trim().min(1).max(80),
  rejectLabel: z.string().trim().min(1).max(80).optional(),
}).strict();

const gateResolvedEventSchema = eventBaseSchema.extend({
  type: z.literal('gate_resolved'),
  authority: z.enum(['platform', 'simulation']),
  stepId: idSchema,
  gateId: idSchema,
  decision: z.enum(['approved', 'rejected']),
  message: textSchema.optional(),
}).strict();

export const workflowTraceEventV1Schema = z.union([
  entryEventSchema,
  planEventSchema,
  stepEventSchema,
  activityEventSchema,
  effectEventSchema,
  gateRequestedEventSchema,
  gateResolvedEventSchema,
]);

export const workflowTraceV1Schema = z.object({
  schemaVersion: z.literal(1),
  workflowId: idSchema,
  instanceId: idSchema,
  events: z.array(workflowTraceEventV1Schema).min(1),
}).strict().superRefine((trace, ctx) => {
  const ids = new Set<string>();
  const sequences = new Set<number>();
  for (const [index, event] of trace.events.entries()) {
    if (event.workflowId !== trace.workflowId || event.instanceId !== trace.instanceId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['events', index], message: '事件必须属于同一 workflow instance' });
    }
    if (ids.has(event.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['events', index, 'id'], message: '事件 id 必须唯一' });
    }
    if (sequences.has(event.sequence)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['events', index, 'sequence'], message: '事件 sequence 必须唯一' });
    }
    ids.add(event.id);
    sequences.add(event.sequence);
  }
});

export type WorkflowTraceEventV1 = z.infer<typeof workflowTraceEventV1Schema>;
export type WorkflowTraceV1 = z.infer<typeof workflowTraceV1Schema>;
export type WorkflowTraceAuthority = z.infer<typeof authoritySchema>;
export type WorkflowTraceGateRequestedEventV1 = z.infer<typeof gateRequestedEventSchema>;

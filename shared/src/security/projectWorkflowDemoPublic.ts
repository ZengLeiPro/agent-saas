import { z } from "zod";

import { demoPublicEvidenceSchema } from "../schemas/workflowScenario.js";

const workflowDemoVerificationInputSchema = z.object({
  readBackVerified: z.literal(true),
  beforeObjectCount: z.number().int().nonnegative(),
  afterObjectCount: z.number().int().nonnegative(),
  eventCount: z.number().int().positive(),
  receiptCount: z.number().int().nonnegative(),
  verifiedAt: z.string().datetime(),
  evidenceHash: z.string().min(8),
}).strict();

const workflowDemoReplayInputSchema = demoPublicEvidenceSchema.extend({
  replayVersion: z.literal(1),
  status: z.literal("passed"),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  verification: workflowDemoVerificationInputSchema,
}).strict();

const workflowDemoPublicationInputSchema = z.object({
  replay: workflowDemoReplayInputSchema,
  replayId: z.string().optional(),
  integrity: z.object({
    contentHash: z.string().optional(),
    reviewedAt: z.string().datetime(),
    publishedAt: z.string().datetime(),
    independentlyReviewed: z.literal(true),
  }).strict(),
}).strict();

const customerStateSchema = z.object({
  object: z.string().trim().min(1).max(20_000),
  status: z.string().trim().min(1).max(20_000),
}).strict();

const customerTimelineSchema = z.object({
  sequence: z.number().int().positive(),
  event: z.string().trim().min(1).max(20_000),
  action: z.string().trim().min(1).max(20_000),
  result: z.string().trim().min(1).max(20_000),
  humanReview: z.boolean(),
  followUp: z.boolean(),
}).strict();

const customerEvidenceSchema = z.object({
  category: z.enum(["运行过程", "业务成果", "人工确认", "动作结果", "状态复查", "周期观察", "等待后续"]),
  evidence: z.string().trim().min(1).max(20_000),
  conclusion: z.string().trim().min(1).max(20_000),
}).strict();

/**
 * 公开回放只承载客户能理解的业务证据。运行标识、事件标识、hash、内部状态机、
 * 工具流水和租户信息均留在服务端审计记录中，不进入该 DTO。
 */
export const customerWorkflowReplayResponseSchema = z.object({
  workflow: z.object({
    title: z.string().trim().min(1).max(20_000),
    type: z.enum(["产出成果", "持续巡检", "会动系统", "持续闭环"]),
    environment: z.object({
      label: z.string().trim().min(1).max(20_000),
      data: z.enum(["合成演示数据", "脱敏演示数据", "公开数据"]),
      limitation: z.string().trim().min(1).max(20_000),
    }).strict(),
    before: z.array(customerStateSchema),
    timeline: z.array(customerTimelineSchema).min(1),
    after: z.array(customerStateSchema),
    evidence: z.array(customerEvidenceSchema).min(1),
  }).strict(),
  assurance: z.object({
    readBackVerified: z.literal(true),
    independentlyReviewed: z.literal(true),
    publishedAt: z.string().datetime(),
    businessEventCount: z.number().int().positive(),
    actionProofCount: z.number().int().nonnegative(),
    finalObjectCount: z.number().int().nonnegative(),
  }).strict(),
}).strict();

export type CustomerWorkflowReplayResponse = z.infer<typeof customerWorkflowReplayResponseSchema>;

const TYPE_LABELS = {
  CREATE: "产出成果",
  WATCH: "持续巡检",
  ACT: "会动系统",
  LOOP: "持续闭环",
} as const;

const DATA_LABELS = {
  synthetic: "合成演示数据",
  desensitized: "脱敏演示数据",
  public: "公开数据",
} as const;

const EVIDENCE_LABELS = {
  agent_run: "运行过程",
  artifact: "业务成果",
  approval: "人工确认",
  receipt: "动作结果",
  readback: "状态复查",
  cycle: "周期观察",
  resume: "等待后续",
} as const;

const INTERNAL_ASSIGNMENT = /(?:^|[；;,，\s])(?:runId|eventId|replayId|sourceEventId|workflowActionId|leadId|opportunityId|tenantId|ownerId|sessionId|messageRevision|evidenceDigest|actionDigest|contentHash|sourceSetHash|verificationDigest|impactDigest|approvedMessageDigest|deliveryReceiptId|receiptId|sourceSnapshotDigest|externalTransactionDigest)\s*[=:]\s*[^；;,，\s]+/giu;

const INTERNAL_TERMS: Array<[RegExp, string]> = [
  [/\b[A-Za-z0-9_]*(?:hash|digest)[A-Za-z0-9_]*\b/giu, "校验摘要"],
  [/\b[A-Za-z0-9_]*mutation[A-Za-z0-9_]*\b/giu, "业务写入"],
  [/\b[A-Za-z0-9_]*owner[A-Za-z0-9_]*\b/giu, "负责人状态"],
  [/\b[A-Za-z0-9_]*tenant[A-Za-z0-9_]*\b/giu, "客户组织"],
  [/\bmanifest\b/giu, "静态演示方案"],
  [/\bmutation\b/giu, "业务写入"],
  [/\breceipts?\b/giu, "动作回执"],
  [/\btenant\b/giu, "客户组织"],
  [/\bowner\b/giu, "负责人"],
  [/\baction binding digest\b/giu, "动作版本绑定"],
  [/\b(?:sha-?256|hash|digest)\b/giu, "校验摘要"],
  [/\bworkflowActionId\b/giu, "业务动作"],
  [/\bsourceEventId\b/giu, "来源事件"],
  [/\beventId\b/giu, "业务事件"],
  [/\b(?:runId|replayId|sessionId)\b/giu, "运行记录"],
  [/\b(?:leadId|opportunityId)\b/giu, "业务对象"],
  [/\bmessageRevision\b/giu, "消息版本"],
  [/\b(?:evidence|action|impact|content|sourceSet|verification)Digest\b/giu, "校验摘要"],
  [/\b(?:sourceSnapshot|externalTransaction)Digest\b/giu, "校验摘要"],
  [/\bownerRole(?:Id)?\b/giu, "负责人角色"],
];

const PUBLIC_REDLINE = /\b(?:runId|eventId|replayId|sessionId|tenant(?:Id)?|owner(?:Id|RoleId)?|manifest|mutation|workflowActionId|sourceEventId|leadId|opportunityId|messageRevision|evidenceDigest|actionDigest|impactDigest|contentHash|sourceSetHash|verificationDigest|sourceSnapshotDigest|externalTransactionDigest)\b/iu;

const STATE_WORDS: Record<string, string> = {
  ACCEPTED: "已接受",
  ACTIVE: "已生效",
  ANSWERED: "已答复",
  APPROVED: "已批准",
  BLOCKED: "已阻止",
  CANCELLED: "已取消",
  CLOSED: "已关闭",
  COMMITTED: "已确认",
  COMPLETED: "已完成",
  CONFIRMED: "已确认",
  CREATED: "已创建",
  CUSTOMER: "客户",
  DELIVERED: "已送达",
  EVIDENCE: "证据",
  FAILED: "未通过",
  HOLD: "已暂停",
  INTERNAL: "内部协作",
  OPEN: "已开放",
  OWNER: "负责人",
  PAYMENT: "来款",
  READY: "已就绪",
  RECEIVED: "已收到",
  RECORDED: "已登记",
  REJECTED: "未接受",
  RELEASED: "已放行",
  RESPONSE: "回复",
  RESUMED: "已继续",
  REVIEW: "复核",
  SENT: "已发送",
  SUBMITTED: "已提交",
  SUCCEEDED: "已完成",
  SUPPRESSED: "已停止触达",
  VERIFIED: "已复查确认",
  WAITING: "等待",
};

const SINGLE_STATE_TOKEN = /\b(?:ACCEPTED|ACTIVE|ANSWERED|APPROVED|BLOCKED|CANCELLED|CLOSED|COMMITTED|COMPLETED|CONFIRMED|CREATED|DELIVERED|FAILED|HOLD|OPEN|READY|RECEIVED|RECORDED|REJECTED|RELEASED|RESUMED|SENT|SUBMITTED|SUCCEEDED|SUPPRESSED|VERIFIED|WAITING)\b/gu;

export function projectWorkflowDemoPublic(input: unknown): CustomerWorkflowReplayResponse {
  const publication = workflowDemoPublicationInputSchema.parse(input);
  const { replay, integrity } = publication;
  const projected = customerWorkflowReplayResponseSchema.parse({
    workflow: {
      title: customerText(replay.title),
      type: TYPE_LABELS[replay.primaryType],
      environment: {
        label: customerText(replay.environmentLabel),
        data: DATA_LABELS[replay.environment.dataLabel],
        limitation: replay.environment.kind === "isolated_stateful"
          ? "本页记录来自专用隔离演示系统，不代表已接入任何未配置的客户系统。"
          : "本页仅展示已获授权并完成脱敏的运行结果。",
      },
      before: replay.before.map((item) => ({
        object: customerText(item.label),
        status: customerState(item.state),
      })),
      timeline: replay.timeline.map((item, index) => {
        const combined = `${item.label} ${item.summary} ${item.state}`;
        return {
          sequence: index + 1,
          event: customerText(item.label),
          action: customerText(item.summary),
          result: customerState(item.state),
          humanReview: /审批|批准|人审|复核|确认/iu.test(combined),
          followUp: /等待|恢复|继续|回复|复查|下次|周期|提醒|升级/iu.test(combined),
        };
      }),
      after: replay.after.map((item) => ({
        object: customerText(item.label),
        status: customerState(item.state),
      })),
      evidence: replay.evidence.map((item) => ({
        category: EVIDENCE_LABELS[item.kind],
        evidence: customerText(item.label),
        conclusion: customerText(item.summary),
      })),
    },
    assurance: {
      readBackVerified: true,
      independentlyReviewed: true,
      publishedAt: integrity.publishedAt,
      businessEventCount: replay.verification.eventCount,
      actionProofCount: replay.verification.receiptCount,
      finalObjectCount: replay.verification.afterObjectCount,
    },
  });
  const serialized = JSON.stringify(projected);
  const redline = serialized.match(PUBLIC_REDLINE)
    ?? serialized.match(/[A-Za-z0-9]*(?:hash|digest|mutation|owner|tenant)[A-Za-z0-9]*/iu);
  if (redline) {
    throw new Error(`公开回放仍包含内部运行字段：${redline[0]}`);
  }
  return projected;
}

function customerState(value: string): string {
  const withoutAssignments = value.replace(INTERNAL_ASSIGNMENT, " ");
  const translated = withoutAssignments
    .replace(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/gu, translateMachineState)
    .replace(SINGLE_STATE_TOKEN, (token) => STATE_WORDS[token] ?? token);
  return customerText(translated);
}

function translateMachineState(token: string): string {
  const parts = token.split("_");
  if (parts[0] === "WAITING") return "等待业务信息或确认";
  if (parts[0] === "RESUMED") return "已收到后续信息并继续处理";
  if (parts[0] === "NOT" || parts[0] === "NO" || parts.includes("NONE")) return "尚未发生";
  if (parts.includes("BLOCKED")) return "已按业务规则阻止";
  if (parts.includes("SUPPRESSED")) return "已按退订要求停止触达";
  if (parts.includes("REJECTED") || parts.includes("FAILED")) return "未通过业务校验";
  if (parts.includes("VERIFIED")) return "已完成并复查确认";
  if (parts.includes("APPROVED")) return "已批准";
  if (parts.includes("DELIVERED")) return "已送达";
  if (parts.includes("RELEASED")) return "已放行";
  if (parts.includes("COMPLETED") || parts.includes("SUCCEEDED")) return "已完成";
  if (parts.includes("CREATED")) return "已创建";
  if (parts.includes("RECEIVED")) return "已收到";
  if (parts.includes("RECORDED")) return "已登记";
  if (parts.includes("CONFIRMED") || parts.includes("COMMITTED")) return "已确认";
  if (parts.includes("ACTIVE")) return "已生效";
  if (parts.includes("OPEN") || parts.includes("READY")) return "已就绪";
  if (parts.length === 1 && STATE_WORDS[token]) return STATE_WORDS[token];
  return "业务状态已更新";
}

function customerText(value: string): string {
  let next = value.replace(INTERNAL_ASSIGNMENT, " ");
  for (const [pattern, replacement] of INTERNAL_TERMS) next = next.replace(pattern, replacement);
  next = next
    .replace(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/gu, translateMachineState)
    .replace(SINGLE_STATE_TOKEN, (token) => STATE_WORDS[token] ?? token);
  return next
    .replace(/[；;,，]\s*[；;,，]+/gu, "；")
    .replace(/\s{2,}/gu, " ")
    .replace(/^[；;,，\s]+|[；;,，\s]+$/gu, "")
    || "已按业务规则处理";
}

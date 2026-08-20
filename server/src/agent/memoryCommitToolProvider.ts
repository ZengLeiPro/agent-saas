/**
 * MemoryCommit：L2 记忆整合 run 专用的服务端语义提交工具（2026-07-29 批次）。
 *
 * 安全模型（GPT 5.6 Pro 报告 D3-5.8，经验收采纳）：
 *   - schema 不含 tenant/user/workspace/session/range/path/idempotencyKey——全部
 *     由 worker 预登记的 ConsolidationExecutionContext 派生；普通会话即使猜到
 *     工具名也拿不到 execution context，直接拒绝。
 *   - 逐条候选服务端校验：evidence eventId 必须在投影白名单内、quote 必须能在
 *     原文中定位、user_statement 必须引用 user 事件；不信任模型 JSON。
 *   - tombstone 检查：与未撤销 tombstone 匹配的候选拒绝（防「忘记后复活」）。
 *   - 敏感值与命令性文本拒绝（quarantine 语义记入 ledger，不落文件）。
 *   - 文件序列化由服务端固定模板完成：模型永远不提交路径与原始 Markdown。
 *   - 提交期持 per-user PG advisory lock（与 L1/L3 共用），原子 tmp+rename。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { getConsolidationExecutionContext } from '../memory/consolidation/engine.js';
import { checkMemoryTextSafety, normalizeFingerprint } from '../memory/consolidation/digest.js';
import { buildDailyFileNext, formatMemoryDate, materializeDailyOperations, sha256Text } from '../memory/consolidation/materialize.js';
import type { PgMemoryConsolidationStore } from '../memory/consolidation/store.js';
import type { MemoryCandidateOperation } from '../memory/consolidation/types.js';
import type { MemoryIndexService } from '../memory/index/service.js';
import { loadToolDescription } from './tools/descriptionLoader.js';
import type { AuthorizedToolCall, ToolCallContext, ToolDescriptor, ToolProvider, ToolResult } from './toolRuntime.js';

const MAX_TEXT_CHARS = 500;
const MAX_QUOTE_CHARS = 200;
const MAX_OPERATIONS = 20;

const evidenceSchema = z.object({
  eventId: z.string().min(1),
  sessionSequence: z.number().int().nonnegative(),
  sourceQuote: z.string().min(1).max(MAX_QUOTE_CHARS),
});

const operationSchema = z.object({
  target: z.literal('daily'),
  action: z.enum(['upsert', 'supersede', 'noop']),
  memoryKey: z.string().min(1).max(64),
  supersedesMemoryKey: z.string().min(1).max(64).optional(),
  text: z.string().min(1).max(MAX_TEXT_CHARS),
  attribution: z.enum(['user_statement', 'agent_inference', 'external_source']),
  evidence: z.array(evidenceSchema).min(1).max(5),
  observedAt: z.string().optional(),
});

const memoryCommitInputSchema = z.object({
  version: z.literal(1),
  operations: z.array(operationSchema).max(MAX_OPERATIONS),
  sensitiveSkipped: z.number().int().nonnegative().optional(),
});

type MemoryCommitInput = z.infer<typeof memoryCommitInputSchema>;

export const memoryCommitToolDescriptor: ToolDescriptor<MemoryCommitInput> = {
  id: 'MemoryCommit',
  name: 'MemoryCommit',
  displayName: 'Memory Commit',
  description: loadToolDescription('MemoryCommit'),
  schema: memoryCommitInputSchema,
  risk: 'workspace_write',
  approvalMode: 'never',
  auditCategory: 'memory.commit',
  category: 'memory',
  label: '提交记忆候选',
};

interface RejectedOperation {
  memoryKey: string;
  reason: string;
}

export class MemoryCommitToolProvider implements ToolProvider {
  constructor(
    private readonly options: {
      store: PgMemoryConsolidationStore;
      memoryIndexService?: MemoryIndexService | null;
      logger?: { info?: (msg: string) => void; warn?: (msg: string) => void };
    },
  ) {}

  list(): ToolDescriptor[] {
    return [memoryCommitToolDescriptor];
  }

  async invoke(call: AuthorizedToolCall, context: ToolCallContext): Promise<ToolResult | undefined> {
    if (call.toolId !== memoryCommitToolDescriptor.id) return undefined;

    const identity = context.channelContext.user ?? context.channelContext.sessionOwner;
    if (!identity?.id) {
      return { content: JSON.stringify({ status: 'rejected', reason: 'no identity' }) };
    }
    const execution = getConsolidationExecutionContext(identity.tenantId, identity.id);
    if (!execution) {
      // 普通会话（或无 worker 登记）调用一律拒绝——MemoryCommit 只服务 L2 隐藏 run。
      return {
        content: JSON.stringify({ status: 'rejected', reason: 'MemoryCommit 只能在平台记忆整合任务中使用' }),
      };
    }

    const parsed = memoryCommitInputSchema.safeParse(call.input);
    if (!parsed.success) {
      return {
        content: JSON.stringify({ status: 'rejected', reason: `schema: ${parsed.error.issues[0]?.message ?? 'invalid'}` }),
      };
    }
    const input = parsed.data;

    const accepted: MemoryCandidateOperation[] = [];
    const rejected: RejectedOperation[] = [];
    const tombstones = await this.options.store.listActiveTombstones(execution.tenantId, execution.userId);

    for (const op of input.operations) {
      if (op.action === 'noop') continue;
      const verdict = this.validateOperation(op, execution, tombstones);
      if (verdict === null) accepted.push(op);
      else rejected.push({ memoryKey: op.memoryKey, reason: verdict });
    }

    // 全部为空（模型判断无值得记录内容）→ noop 收口
    if (accepted.length === 0) {
      const status = input.operations.length === 0 || rejected.length === 0 ? 'noop' : 'rejected';
      await this.options.store.updateRun({
        idempotencyKey: execution.idempotencyKey,
        status,
        proposalJson: { operations: input.operations, rejected },
        finished: true,
      });
      execution.commitResult = { status, appliedCount: 0, rejectedCount: rejected.length };
      return { content: JSON.stringify({ status, applied: 0, rejected: rejected.length, reasons: rejected }) };
    }

    // ── 落盘：per-user PG commit lock + 原子写 ──
    const lock = await this.options.store.acquireCommitLock(execution.tenantId, execution.userId);
    if (!lock) {
      await this.options.store.updateRun({
        idempotencyKey: execution.idempotencyKey,
        status: 'retryable_failed',
        errorCode: 'commit_lock_timeout',
        finished: true,
      });
      execution.commitResult = { status: 'rejected', appliedCount: 0, rejectedCount: input.operations.length };
      return { content: JSON.stringify({ status: 'busy', reason: 'memory write lock timeout' }) };
    }
    try {
      const date = formatMemoryDate();
      const filePath = join(context.workspace.root, 'memory', `${date}.md`);
      const existing = await readFile(filePath, 'utf8').catch(() => '');
      const baseHash = sha256Text(existing);
      const postimageHash = sha256Text(buildDailyFileNext(existing, accepted, date));

      // 崩溃幂等（2026-07-29 P1 修复）：写文件**之前**先把 proposal + base/
      // postimage hash 持久化为 prepared——进程在写文件与标记 applied 之间
      // 崩溃时，恢复流程按当前文件 hash 判定（见 engine.recoverPreparedRun）：
      // 已是 postimage → 补账不重写；仍是 base → 服务端重放 accepted。
      await this.options.store.updateRun({
        idempotencyKey: execution.idempotencyKey,
        status: 'prepared',
        baseMemoryHash: baseHash,
        plannedPostimageHash: postimageHash,
        proposalJson: { date, operations: input.operations, accepted, rejected },
      });

      const materialized = await materializeDailyOperations({
        workspaceRoot: context.workspace.root,
        operations: accepted,
        date,
      });

      this.options.memoryIndexService?.enqueueSync(context.workspace.root, 'memory-commit');

      await this.options.store.updateRun({
        idempotencyKey: execution.idempotencyKey,
        status: 'applied',
        plannedPostimageHash: materialized.postimageHash,
        applied: true,
        finished: true,
      });
      const finalPostimageHash = materialized.postimageHash;
      execution.commitResult = {
        status: 'applied',
        appliedCount: accepted.length,
        rejectedCount: rejected.length,
        postimageHash: finalPostimageHash,
      };
      this.options.logger?.info?.(
        `[memory-commit] applied=${accepted.length} rejected=${rejected.length} user=${execution.userId} range=(${execution.fromSessionSequence},${execution.toSessionSequence}]`,
      );
      return {
        content: JSON.stringify({ status: 'applied', applied: accepted.length, rejected: rejected.length, reasons: rejected }),
      };
    } finally {
      await lock.release();
    }
  }

  /** 返回 null = 通过；返回字符串 = 拒绝原因。 */
  private validateOperation(
    op: MemoryCandidateOperation,
    execution: NonNullable<ReturnType<typeof getConsolidationExecutionContext>>,
    tombstones: Awaited<ReturnType<PgMemoryConsolidationStore['listActiveTombstones']>>,
  ): string | null {
    // 1. 证据白名单 + quote 定位
    let hasUserEvidence = false;
    for (const evidence of op.evidence) {
      const known = execution.evidenceIndex.get(evidence.eventId);
      if (!known) return `evidence ${evidence.eventId} 不在本次投影白名单`;
      if (known.sessionSequence !== evidence.sessionSequence) {
        return `evidence ${evidence.eventId} 的 sequence 与事实不符`;
      }
      if (!quoteMatches(known.text, evidence.sourceQuote)) {
        return `evidence ${evidence.eventId} 的 sourceQuote 无法在原文定位`;
      }
      if (known.role === 'user') {
        hasUserEvidence = true;
        // forget 是控制意图，不是可被重新物化的事实。即使提取模型违约，服务端也拒绝落盘。
        if (isExplicitForgetControl(known.text)) return 'explicit_forget_control';
      }
    }
    if (op.attribution === 'user_statement' && !hasUserEvidence) {
      return 'user_statement 必须至少引用一条 user 事件';
    }
    // 2. 归因标注硬要求
    if (op.attribution === 'agent_inference' && !op.text.includes('Agent推论')) {
      return 'agent_inference 的 text 缺少「Agent推论（非用户确认）」标注';
    }
    if (op.attribution === 'external_source' && !op.text.includes('外部资料')) {
      return 'external_source 的 text 缺少「外部资料结论」标注';
    }
    // 3/4. 敏感值与命令性/注入文本（与 L1 MemoryCommand 共用同一规则）
    const safety = checkMemoryTextSafety(op.text);
    if (safety) return safety;
    // 5. tombstone：防「忘记后复活」
    const fingerprint = normalizeFingerprint(op.text);
    for (const tombstone of tombstones) {
      if (tombstone.memoryKey && tombstone.memoryKey === op.memoryKey) return 'tombstone_blocked';
      if (tombstone.normalizedFingerprint
        && tombstone.normalizedFingerprint.length >= 6
        && (fingerprint.includes(tombstone.normalizedFingerprint)
          || tombstone.normalizedFingerprint.includes(fingerprint))) {
        return 'tombstone_blocked';
      }
    }
    return null;
  }
}

function isExplicitForgetControl(text: string): boolean {
  const normalized = text.trim();
  return /(?:^|[，。！？!?；;\s])(?:请|麻烦)?(?:帮我)?(?:你)?(?:忘记|删除|清除|移除|不要再记|别再记|别记住)/u.test(normalized)
    || /(?:^|[.!?;\s])(?:please\s+)?(?:forget|delete|remove)\b/iu.test(normalized);
}

/** quote 匹配：归一化空白后子串包含。 */
function quoteMatches(sourceText: string, quote: string): boolean {
  const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();
  const source = normalize(sourceText);
  const target = normalize(quote);
  if (target.length === 0) return false;
  return source.includes(target);
}



/**
 * MemoryCommand：L1 显式记忆控制工具（2026-07-29 记忆写入职责剥离批次）。
 *
 * 主 Agent 不再自由写记忆文件；用户明确「记住 / 忘记 / 纠正」时由本工具执行。
 * 语义理解由主 Agent（在完整上下文中）完成——它提炼 subject/value/userQuote；
 * 服务端只做不需要语义的事：身份绑定、候选匹配、tombstone、原子写、真实回执。
 *
 * forget 三档匹配（2026-07-29 曾磊确认）：
 *   1. MemorySearch 混合索引召回候选（向量+FTS，天然有语义能力，非 LLM 调用）；
 *   2. 唯一高置信命中 → 执行删除 + tombstone；
 *   3. 多候选/低置信 → needs_clarification 附候选清单，由主 Agent 反问用户裁决。
 * 原则：宁可多问一句，不可误删。
 */

import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';

import { z } from 'zod';

import { checkMemoryTextSafety, normalizeFingerprint } from '../memory/consolidation/safety.js';
import { readTrustedFile, relativeToTrustedRoot, writeTrustedFile } from '../security/trustedFile.js';
import type { PgMemoryConsolidationStore } from '../memory/consolidation/store.js';
import type { MemoryIndexService } from '../memory/index/service.js';
import { loadToolDescription } from './tools/descriptionLoader.js';
import type { AuthorizedToolCall, ToolCallContext, ToolDescriptor, ToolProvider, ToolResult } from './toolRuntime.js';

function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

const memoryCommandInputSchema = z.object({
  action: z.enum(['remember', 'forget', 'correct', 'question_answered', 'question_declined']),
  subject: z.string().min(1).max(300).describe('用户明确表达的目标；不得由 Agent 扩写为新事实。'),
  value: z.string().min(1).max(500).optional()
    .describe('remember/correct/question_answered 时的内容，优先逐字摘录用户表达。'),
  userQuote: z.string().min(1).max(300).describe('用户当前消息中的原话短摘录，用于核验。'),
  /** forget/correct 多候选澄清后的第二次调用：用户选定的候选编号（1 起）。 */
  candidateChoice: z.number().int().positive().optional(),
});

type MemoryCommandInput = z.infer<typeof memoryCommandInputSchema>;

export const memoryCommandToolDescriptor: ToolDescriptor<MemoryCommandInput> = {
  id: 'MemoryCommand',
  name: 'MemoryCommand',
  displayName: 'Memory Command',
  description: loadToolDescription('MemoryCommand'),
  schema: memoryCommandInputSchema,
  risk: 'workspace_write',
  approvalMode: 'never',
  auditCategory: 'memory.command',
  category: 'memory',
  label: '记忆指令',
};

interface MatchCandidate {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  /** 候选行区间原文 hash（缓存时计算；执行删除前持锁重读复核，防行号漂移误删）。 */
  lineContentHash: string;
}

export class MemoryCommandToolProvider implements ToolProvider {
  /** forget/correct 的待澄清候选缓存：user key → 候选列表（5 分钟过期）。 */
  private readonly pendingChoices = new Map<string, { candidates: MatchCandidate[]; expiresAtMs: number; action: string; subject: string }>();

  constructor(
    private readonly options: {
      store: PgMemoryConsolidationStore;
      memoryIndexService?: MemoryIndexService | null;
      logger?: { info?: (msg: string) => void; warn?: (msg: string) => void };
    },
  ) {}

  list(): ToolDescriptor[] {
    return [memoryCommandToolDescriptor];
  }

  async invoke(call: AuthorizedToolCall, context: ToolCallContext): Promise<ToolResult | undefined> {
    if (call.toolId !== memoryCommandToolDescriptor.id) return undefined;

    const identity = context.channelContext.user ?? context.channelContext.sessionOwner;
    if (!identity?.id) {
      return reply({ status: 'rejected', reason: '无用户身份' }, true);
    }
    // 后台系统 run（L2/L3/维护 hook）禁止冒充用户发起显式记忆指令
    if (context.channelContext.systemContext) {
      return reply({ status: 'rejected', reason: '后台任务不能调用 MemoryCommand' }, true);
    }

    const parsed = memoryCommandInputSchema.safeParse(call.input);
    if (!parsed.success) {
      return reply({ status: 'rejected', reason: `参数无效: ${parsed.error.issues[0]?.message ?? 'invalid'}` }, true);
    }
    const input = parsed.data;
    const tenantId = identity.tenantId;
    const userId = identity.id;
    const userKey = `${tenantId ?? '__none'}:${userId}`;

    // 写入内容安全（2026-07-29 P1 修复）：显式指令与 L2 共用同一规则——
    // 用户要求记住的内容若含密钥/凭据或命令性文本，明确拒绝并说明原因，
    // 不写入可被索引与未来会话注入的记忆文件。
    if (input.action === 'remember' || input.action === 'correct' || input.action === 'question_answered') {
      const unsafe = checkMemoryTextSafety(input.value ?? input.subject);
      if (unsafe) return reply({ status: 'rejected', reason: unsafe }, true);
    }

    try {
      switch (input.action) {
        case 'remember':
          return await this.handleRemember(input, context, tenantId, userId);
        case 'forget':
        case 'correct':
          return await this.handleForgetOrCorrect(input, context, tenantId, userId, userKey);
        case 'question_answered':
        case 'question_declined':
          return await this.handleQuestion(input, context, tenantId, userId);
        default:
          return reply({ status: 'rejected', reason: 'unknown action' }, true);
      }
    } catch (err) {
      this.options.logger?.warn?.(`[memory-command] error: ${err instanceof Error ? err.message : String(err)}`);
      return reply({ status: 'error', reason: '记忆操作失败，请稍后重试' }, true);
    }
  }

  private async handleRemember(
    input: MemoryCommandInput,
    context: ToolCallContext,
    tenantId: string | undefined,
    userId: string,
  ): Promise<ToolResult> {
    const value = input.value ?? input.subject;
    const lock = await this.options.store.acquireCommitLock(tenantId ?? '__none', userId);
    if (!lock) return reply({ status: 'busy', reason: '记忆写入锁忙，请稍后重试' }, true);
    try {
      // 新的用户显式证据可撤销匹配的 tombstone（「重新记住」语义）
      const fingerprint = normalizeFingerprint(value);
      const tombstones = await this.options.store.listActiveTombstones(tenantId ?? '__none', userId);
      for (const tombstone of tombstones) {
        if (tombstone.normalizedFingerprint
          && tombstone.normalizedFingerprint.length >= 6
          && (fingerprint.includes(tombstone.normalizedFingerprint)
            || tombstone.normalizedFingerprint.includes(fingerprint))) {
          await this.options.store.revokeTombstone(tombstone.id, tombstone.tenantId, tombstone.userId);
        }
      }
      const date = formatDate();
      const line = `- [用户要求记住] ${date}｜用户原话：${value}`;
      await appendToDailyFile(context.workspace.root, date, line);
      this.options.memoryIndexService?.enqueueSync(context.workspace.root, 'memory-command-remember');
      return reply({ status: 'applied', detail: `已记住：${value.slice(0, 80)}` });
    } finally {
      await lock.release();
    }
  }

  private async handleForgetOrCorrect(
    input: MemoryCommandInput,
    context: ToolCallContext,
    tenantId: string | undefined,
    userId: string,
    userKey: string,
  ): Promise<ToolResult> {
    // 第二次调用：用户已在澄清中选定候选
    let target: MatchCandidate | undefined;
    if (input.candidateChoice !== undefined) {
      const pending = this.pendingChoices.get(userKey);
      if (!pending || pending.expiresAtMs < Date.now()) {
        return reply({ status: 'needs_clarification', reason: '候选已过期，请重新发起' }, true);
      }
      // P2 修复：并行会话可能覆盖候选缓存——二次调用必须与缓存的意图一致
      if (pending.action !== input.action || pending.subject !== input.subject) {
        this.pendingChoices.delete(userKey);
        return reply({ status: 'needs_clarification', reason: '候选与当前请求不匹配（可能有并行操作），请重新发起' }, true);
      }
      target = pending.candidates[input.candidateChoice - 1];
      if (!target) return reply({ status: 'rejected', reason: `候选编号 ${input.candidateChoice} 不存在` }, true);
      this.pendingChoices.delete(userKey);
    } else {
      // 三档匹配：索引召回 → 唯一高置信执行 / 多候选澄清 / 0 命中仅 tombstone
      const candidates = await this.searchCandidates(context.workspace.root, input.subject);
      if (candidates.length === 0) {
        if (input.action === 'forget') {
          const lock = await this.options.store.acquireCommitLock(tenantId ?? '__none', userId);
          if (!lock) return reply({ status: 'busy', reason: '记忆写入锁忙' }, true);
          try {
            await this.options.store.insertTombstone({
              tenantId: tenantId ?? '__none', userId,
              workspaceId: context.workspace.root,
              normalizedFingerprint: normalizeFingerprint(input.subject),
              subjectText: input.subject,
              scope: 'subject',
              source: 'explicit_user_forget',
              reason: input.userQuote.slice(0, 200),
            });
          } finally {
            await lock.release();
          }
          return reply({
            status: 'removed',
            detail: '当前记忆文件中未找到该内容；已登记忘记标记，后台记忆进程此后不会再记录它',
          });
        }
        return reply({ status: 'needs_clarification', reason: '未找到要更正的记忆条目，请确认表述' });
      }
      const [top, second] = candidates;
      const uniqueConfident = candidates.length === 1
        || (top!.score >= 0.6 && (second === undefined || top!.score - second.score >= 0.15));
      if (!uniqueConfident) {
        this.pendingChoices.set(userKey, {
          candidates: candidates.slice(0, 4),
          expiresAtMs: Date.now() + 5 * 60_000,
          action: input.action,
          subject: input.subject,
        });
        return reply({
          status: 'needs_clarification',
          reason: '匹配到多条候选，请与用户确认要处理哪一条，然后带 candidateChoice 重新调用',
          candidates: candidates.slice(0, 4).map((candidate, index) => ({
            choice: index + 1,
            path: candidate.path,
            snippet: candidate.snippet.slice(0, 160),
          })),
        });
      }
      target = top;
    }

    const lock = await this.options.store.acquireCommitLock(tenantId ?? '__none', userId);
    if (!lock) return reply({ status: 'busy', reason: '记忆写入锁忙' }, true);
    try {
      // P2 修复：持锁后重读文件复核候选行区间 hash——候选产生到用户确认之间
      // 文件可能被 L2/L3/其他会话改写，行号漂移时绝不按旧行号硬删。
      const current = await readLineRange(context.workspace.root, target!);
      if (current === null || sha256Text(current) !== target!.lineContentHash) {
        this.pendingChoices.delete(userKey);
        return reply({
          status: 'needs_clarification',
          reason: '记忆文件在确认期间发生了变化，为避免误删已中止；请重新发起本次操作',
        }, true);
      }
      const removedText = await removeLineRange(context.workspace.root, target!);
      await this.options.store.insertTombstone({
        tenantId: tenantId ?? '__none', userId,
        workspaceId: context.workspace.root,
        normalizedFingerprint: normalizeFingerprint(removedText || input.subject),
        subjectText: input.subject,
        scope: 'item',
        source: input.action === 'forget' ? 'explicit_user_forget' : 'explicit_user_correction',
        reason: input.userQuote.slice(0, 200),
      });
      if (input.action === 'correct') {
        const value = input.value ?? input.subject;
        const date = formatDate();
        await appendToDailyFile(
          context.workspace.root, date,
          `- [用户更正] ${date}｜用户原话：${value}（替代原「${(removedText || input.subject).slice(0, 60)}…」）`,
        );
      }
      this.options.memoryIndexService?.enqueueSync(context.workspace.root, `memory-command-${input.action}`);
      return reply({
        status: input.action === 'forget' ? 'removed' : 'corrected',
        detail: input.action === 'forget'
          ? `已删除并登记忘记标记：${target!.path}`
          : '已更正并登记替代关系',
      });
    } finally {
      await lock.release();
    }
  }

  private async handleQuestion(
    input: MemoryCommandInput,
    context: ToolCallContext,
    tenantId: string | undefined,
    userId: string,
  ): Promise<ToolResult> {
    const lock = await this.options.store.acquireCommitLock(tenantId ?? '__none', userId);
    if (!lock) return reply({ status: 'busy', reason: '记忆写入锁忙' }, true);
    try {
      const date = formatDate();
      const relativePath = assertMemoryPath(context.workspace.root, 'memory/questions.md');
      const existing = await readMemoryFileIfPresent(context.workspace.root, relativePath) ?? '# 提问记录\n';
      const line = input.action === 'question_answered'
        ? `- [已回答 ${date}] ${input.subject}：${input.value ?? input.userQuote}`
        : `- [拒绝回答 ${date}] ${input.subject}`;
      const next = `${existing.replace(/\n*$/, '\n')}${line}\n`;
      await writeTrustedFile(context.workspace.root, relativePath, next, { encoding: 'utf8', createParents: true });
      this.options.memoryIndexService?.enqueueSync(context.workspace.root, 'memory-command-question');
      return reply({ status: 'applied', detail: '提问状态已更新' });
    } finally {
      await lock.release();
    }
  }

  private async searchCandidates(workspaceRoot: string, subject: string): Promise<MatchCandidate[]> {
    const service = this.options.memoryIndexService;
    if (!service) return [];
    const indexer = service.getIndexer(workspaceRoot);
    await indexer.syncIfStale({ maxWaitMs: 1_500, emptyIndexMaxWaitMs: 3_000, manifestCheckIntervalMs: 60_000 });
    const response = await indexer.search(subject, { maxResults: 5, keywords: subject });
    const candidates: MatchCandidate[] = [];
    for (const result of response.results) {
      const lineText = await readLineRange(workspaceRoot, {
        path: result.path, startLine: result.startLine, endLine: result.endLine,
      });
      if (lineText === null) continue; // 索引指向的文件/区间已不存在，跳过
      candidates.push({
        path: result.path,
        startLine: result.startLine,
        endLine: result.endLine,
        score: result.score,
        snippet: result.snippet,
        lineContentHash: sha256Text(lineText),
      });
    }
    return candidates;
  }
}

// ── 文件操作（受信 FD；路径守卫防越界与 symlink/rename 竞态）──────

function assertMemoryPath(workspaceRoot: string, candidatePath: string): string {
  const root = resolve(workspaceRoot);
  const target = isAbsolute(candidatePath) ? resolve(candidatePath) : resolve(root, candidatePath);
  const relativePath = relativeToTrustedRoot(root, target).split('\\').join('/');
  const allowed = relativePath === 'MEMORY.md'
    || (relativePath.startsWith('memory/') && relativePath.endsWith('.md'));
  if (!allowed) throw new Error(`MemoryCommand 路径越界: ${candidatePath}`);
  return relativePath;
}

async function readMemoryFileIfPresent(workspaceRoot: string, relativePath: string): Promise<string | null> {
  try {
    return await readTrustedFile(workspaceRoot, relativePath, 'utf8') as string;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function appendToDailyFile(workspaceRoot: string, date: string, line: string): Promise<void> {
  const relativePath = assertMemoryPath(workspaceRoot, `memory/${date}.md`);
  const existing = await readMemoryFileIfPresent(workspaceRoot, relativePath) ?? '';
  const next = existing.length > 0
    ? `${existing.replace(/\n*$/, '\n')}${line}\n`
    : `# ${date}\n\n${line}\n`;
  await writeTrustedFile(workspaceRoot, relativePath, next, { encoding: 'utf8', createParents: true });
}

/** 读候选行区间原文；文件不存在或区间越界返回 null。 */
async function readLineRange(
  workspaceRoot: string,
  candidate: { path: string; startLine: number; endLine: number },
): Promise<string | null> {
  let relativePath: string;
  try {
    relativePath = assertMemoryPath(workspaceRoot, candidate.path);
  } catch {
    return null;
  }
  const existing = await readMemoryFileIfPresent(workspaceRoot, relativePath);
  if (existing === null) return null;
  const lines = existing.split('\n');
  const start = Math.max(0, candidate.startLine - 1);
  const end = Math.min(lines.length, candidate.endLine);
  if (start >= end) return null;
  return lines.slice(start, end).join('\n');
}

/** 删除候选的行区间；返回被删除的文本（tombstone 指纹用）。 */
async function removeLineRange(workspaceRoot: string, candidate: MatchCandidate): Promise<string> {
  const relativePath = assertMemoryPath(workspaceRoot, candidate.path);
  const existing = await readMemoryFileIfPresent(workspaceRoot, relativePath) ?? '';
  if (!existing) return '';
  const lines = existing.split('\n');
  const start = Math.max(0, candidate.startLine - 1);
  const end = Math.min(lines.length, candidate.endLine);
  const removed = lines.slice(start, end).join('\n');
  const next = [...lines.slice(0, start), ...lines.slice(end)].join('\n');
  await writeTrustedFile(workspaceRoot, relativePath, next, { encoding: 'utf8' });
  return removed;
}

function reply(payload: Record<string, unknown>, _isError = false): ToolResult {
  return { content: JSON.stringify(payload) };
}

function formatDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

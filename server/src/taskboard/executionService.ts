import { randomUUID } from 'node:crypto';

import type {
  TaskBoardComment,
  TaskBoardExecution,
  TaskBoardExecutionStartInput,
  TaskBoardExecutionStartResult,
} from '../../../shared/src/types/taskboard.js';
import { resolveExecutionTarget, type ExecutionConfig } from '../runtime/executionConfig.js';
import type { RunRecord } from '../runtime/runStore.js';
import type { RuntimeScheduler } from '../runtime/scheduler.js';
import {
  createRuntimeSessionRecord,
  type SessionCatalog,
} from '../runtime/sessionCatalog.js';
import type { EventStore, PlatformEvent } from '../runtime/types.js';
import { deriveStableWorkspaceId } from '../runtime/workspaceIdentity.js';
import { resolveUserCwd } from '../workspace/resolver.js';
import { TaskboardExecutionUnavailableError } from './types.js';
import type {
  TaskboardExecutionContext,
  TaskboardExecutionService,
  TaskboardExecutionStore,
  TaskboardIdentity,
} from './types.js';

interface DefaultModelResolution {
  ref: string;
}

export interface TaskboardExecutionCoordinatorOptions {
  store: TaskboardExecutionStore;
  scheduler: Pick<RuntimeScheduler, 'enqueue'>;
  sessionCatalog: SessionCatalog;
  eventStore: EventStore;
  agentCwd: string;
  executionConfig: ExecutionConfig;
  resolveDefaultModel: (tenantId?: string) => DefaultModelResolution | null;
  logger?: {
    info(message: string): void;
    warn(message: string): void;
  };
}

export class TaskboardExecutionCoordinator implements TaskboardExecutionService {
  constructor(private readonly options: TaskboardExecutionCoordinatorOptions) {}

  listExecutions(identity: TaskboardIdentity, taskId: string): Promise<TaskBoardExecution[]> {
    return this.options.store.listExecutions(identity, taskId);
  }

  async startExecution(
    identity: TaskboardIdentity,
    taskId: string,
    input: TaskBoardExecutionStartInput,
  ): Promise<TaskBoardExecutionStartResult> {
    const model = this.options.resolveDefaultModel(identity.tenantId);
    if (!model) throw new TaskboardExecutionUnavailableError('当前组织没有可用的默认模型');
    const executionDecision = resolveExecutionTarget({
      user: { role: identity.userRole, tenantId: identity.tenantId },
      config: this.options.executionConfig,
    });
    if (!executionDecision.ok) throw new TaskboardExecutionUnavailableError(executionDecision.reason);

    const executionId = randomUUID();
    const sessionId = `taskboard-${randomUUID()}`;
    const runId = `taskboard-${Date.now()}-${randomUUID()}`;
    const claimed = await this.options.store.claimExecution(identity, taskId, {
      ...input,
      executionId,
      sessionId,
      runId,
    });
    const workspaceUser = {
      id: identity.ownerUserId,
      username: identity.username,
      role: identity.userRole ?? 'user' as const,
      tenantId: identity.tenantId,
    };
    const cwd = resolveUserCwd(this.options.agentCwd, workspaceUser);
    const workspaceId = deriveStableWorkspaceId(workspaceUser, sessionId);
    const session = createRuntimeSessionRecord({
      sessionId,
      userId: identity.ownerUserId,
      username: identity.username,
      userRole: identity.userRole,
      tenantId: identity.tenantId,
      channel: 'web',
      cwd,
      modelRef: model.ref,
      executionTarget: executionDecision.target,
      workspaceId,
      status: 'running',
    });

    try {
      await this.options.sessionCatalog.upsert(session);
      await this.options.scheduler.enqueue({
        runId,
        sessionId,
        userId: identity.ownerUserId,
        tenantId: identity.tenantId,
        model: model.ref,
        channel: 'taskboard',
        idempotencyKey: `taskboard-execution:${executionId}`,
        executionTarget: executionDecision.target,
        workspaceId,
        metadata: {
          taskboardExecution: true,
          taskboardExecutionId: executionId,
          taskboardTaskId: taskId,
          cwd,
          transcriptPath: session.transcriptPath,
          wakeMessage: {
            channel: 'web',
            chatId: sessionId,
            content: '正在读取任务看板中的最新任务与评论。',
            senderId: identity.ownerUserId,
            senderName: identity.username,
            metadata: {
              taskboardExecution: true,
              taskboardExecutionId: executionId,
              taskboardTaskId: taskId,
            },
          },
        },
      });
      this.options.logger?.info(`Taskboard execution queued: task=${taskId} run=${runId}`);
      return claimed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.options.sessionCatalog.markStatus(sessionId, 'error').catch(() => undefined);
      await this.options.store.completeExecution(runId, {
        status: 'failed',
        error: message,
        commentBody: limitComment(`Agent 启动失败\n\n${message}`),
      }).catch((finalizeError) => {
        this.options.logger?.warn(
          `Taskboard execution start rollback failed: run=${runId} error=${finalizeError instanceof Error ? finalizeError.message : String(finalizeError)}`,
        );
      });
      throw new TaskboardExecutionUnavailableError(message);
    }
  }

  async prepareWake(record: RunRecord): Promise<RunRecord> {
    if (record.metadata?.taskboardExecution !== true) return record;
    const context = await this.options.store.getExecutionContextByRunId(record.runId);
    if (!context) throw new Error(`任务看板执行记录不存在：${record.runId}`);
    if (isTerminalExecution(context.execution)) {
      throw new Error(`任务看板执行已终止：${context.execution.status}`);
    }
    const started = await this.options.store.setExecutionStatus(record.runId, 'running');
    if (!started) {
      throw new Error(`任务看板执行已终止：${record.runId}`);
    }
    return {
      ...record,
      metadata: {
        ...record.metadata,
        wakeMessage: {
          channel: 'web',
          chatId: record.sessionId,
          content: buildExecutionPrompt(context),
          senderId: context.identity.ownerUserId,
          metadata: {
            taskboardExecution: true,
            taskboardExecutionId: context.execution.id,
            taskboardTaskId: context.task.id,
          },
        },
      },
    };
  }

  async handleRuntimeEvent(event: PlatformEvent): Promise<void> {
    const runId = 'runId' in event && typeof event.runId === 'string' ? event.runId : undefined;
    if (!runId) return;
    if (event.type === 'run_started') {
      await this.options.store.setExecutionStatus(runId, 'running');
      return;
    }
    if (event.type === 'run_state_changed') {
      if (event.status === 'waiting_user' || event.status === 'waiting_approval') {
        await this.options.store.setExecutionStatus(runId, event.status);
        return;
      }
      if (event.status === 'failed' || event.status === 'orphaned' || event.status === 'cancelled') {
        const status = event.status === 'cancelled' ? 'cancelled' : 'failed';
        const reason = event.reason || `Runtime 状态：${event.status}`;
        await this.options.store.completeExecution(runId, {
          status,
          error: reason,
          commentBody: limitComment(`Agent 执行${status === 'cancelled' ? '已取消' : '失败'}\n\n${reason}`),
        });
      }
      return;
    }
    if (event.type !== 'run_finished') return;
    if (event.subtype === 'success') {
      const context = await this.options.store.getExecutionContextByRunId(runId);
      if (!context) return;
      const events = this.options.eventStore.listByRun
        ? await this.options.eventStore.listByRun(event.sessionId, runId)
        : (await this.options.eventStore.list(event.sessionId)).filter((item) => (
            'runId' in item && item.runId === runId
          ));
      const output = finalAssistantText(events) || 'Agent 执行完成，但没有返回文本交付。';
      await this.options.store.completeExecution(runId, {
        status: 'succeeded',
        commentBody: limitComment(`Agent 交付\n\n${output}`),
      });
      return;
    }
    const reason = event.error || 'Agent 执行失败';
    await this.options.store.completeExecution(runId, {
      status: 'failed',
      error: reason,
      commentBody: limitComment(`Agent 执行失败\n\n${reason}`),
    });
  }
}

function buildExecutionPrompt(context: TaskboardExecutionContext): string {
  const task = context.task;
  const recentComments = context.comments.slice(-50);
  const comments = recentComments.length > 0
    ? recentComments.map(formatComment).join('\n\n')
    : '（暂无评论）';
  return [
    '你正在执行一条由用户明确交给 Agent 的任务看板任务。',
    '执行前输入已从服务端重新读取；以下任务和评论是当前最新事实。',
    '',
    `任务：${task.identifier} · ${task.title}`,
    `优先级：${task.priority}`,
    `标签：${task.labels.length > 0 ? task.labels.join('、') : '无'}`,
    `截止时间：${task.dueAt ?? '无'}`,
    '',
    '任务正文：',
    task.description || '（无正文）',
    '',
    `最近评论（${recentComments.length}/${context.comments.length}）：`,
    comments,
    '',
    '执行要求：',
    '1. 直接完成任务，必要时使用可用工具；不要只给计划。',
    '2. 尊重当前工作区与安全边界，不 push、不部署、不对外发送，除非任务正文明确授权。',
    '3. 完成后自行检查结果。你的最终回复将作为任务的 Agent 交付回执。',
    '4. 不要自行把任务标记为“已完成”；系统只会将成功结果送到“待复核”，由用户验收。',
  ].join('\n');
}

function formatComment(comment: TaskBoardComment): string {
  return `[${comment.createdAt}] ${comment.authorName}（${comment.authorType}）\n${comment.body}`;
}

function finalAssistantText(events: PlatformEvent[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'assistant_message' || event.incomplete) continue;
    const content = event.content?.trim();
    if (content) return content;
  }
  return '';
}

function limitComment(value: string): string {
  const normalized = value.trim();
  if (normalized.length <= 20_000) return normalized;
  return `${normalized.slice(0, 19_950)}\n\n[回执内容过长，已截断]`;
}

function isTerminalExecution(execution: TaskBoardExecution): boolean {
  return execution.status === 'succeeded'
    || execution.status === 'failed'
    || execution.status === 'cancelled';
}

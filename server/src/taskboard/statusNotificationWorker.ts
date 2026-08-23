import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

import type { WebPushService } from '../webPush/service.js';
import { createLogger } from '../utils/logger.js';

const KEY_STATUSES = {
  blocked: '已阻塞',
  done: '已完成',
  canceled: '已取消',
} as const;
const MAX_ATTEMPTS = 5;

type PgPool = Pool;
type KeyStatus = keyof typeof KEY_STATUSES;

interface ClaimedNotification {
  id: string;
  taskId: string;
  fromStatus: string;
  toStatus: KeyStatus;
  attemptCount: number;
  leaseId: string;
}

interface NotificationTask {
  id: string;
  boardId: string;
  identifier: string;
  title: string;
  tenantId: string;
  creatorUserId?: string;
  responsibleUserId?: string;
  summary?: string;
}

export interface TaskboardStatusNotificationWorkerOptions {
  pool: PgPool;
  tasksTable: string;
  boardsTable: string;
  commentsTable: string;
  executionsTable: string;
  watchersTable: string;
  outboxTable: string;
  service: WebPushService;
  pollIntervalMs?: number;
}

export class TaskboardStatusNotificationWorker {
  private readonly logger = createLogger('TaskboardStatusNotification');
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly options: TaskboardStatusNotificationWorkerOptions) {}

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.options.pollIntervalMs ?? 2_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async runOnce(): Promise<boolean> {
    const claimed = await this.claim();
    if (!claimed) return false;
    try {
      const task = await this.loadTask(claimed.taskId);
      if (task) await this.deliver(claimed, task);
      await this.finish(claimed, 'delivered');
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.finish(claimed, claimed.attemptCount >= MAX_ATTEMPTS ? 'failed' : 'pending', detail);
      this.logger.warn(`任务状态通知失败 outbox=${claimed.id} attempt=${claimed.attemptCount}: ${detail}`);
    }
    return true;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (await this.runOnce()) {
        // 单次唤醒清空当前积压；claim 使用 SKIP LOCKED，可安全多进程并行。
      }
    } catch (error) {
      this.logger.warn(`任务状态通知轮询失败: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running = false;
    }
  }

  private async claim(): Promise<ClaimedNotification | null> {
    const leaseId = randomUUID();
    const result = await this.options.pool.query<Record<string, unknown>>(`
      WITH candidate AS (
        SELECT id
        FROM ${this.options.outboxTable}
        WHERE (state='pending' AND available_at<=now())
           OR (state='processing' AND lease_expires_at<now())
        ORDER BY id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE ${this.options.outboxTable} o
         SET state='processing', lease_id=$1, lease_expires_at=now()+interval '2 minutes',
             attempt_count=o.attempt_count+1
        FROM candidate
       WHERE o.id=candidate.id
      RETURNING o.id::text,o.task_id,o.from_status,o.to_status,o.attempt_count
    `, [leaseId]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: String(row.id),
      taskId: String(row.task_id),
      fromStatus: String(row.from_status),
      toStatus: String(row.to_status) as KeyStatus,
      attemptCount: Number(row.attempt_count),
      leaseId,
    };
  }

  private async loadTask(taskId: string): Promise<NotificationTask | null> {
    const result = await this.options.pool.query<Record<string, unknown>>(`
      SELECT t.id,t.board_id,t.identifier,t.title,t.creator_user_id,b.tenant_id,
        (SELECT e.requested_by FROM ${this.options.executionsTable} e
          WHERE e.task_id=t.id ORDER BY e.created_at DESC LIMIT 1) AS responsible_user_id,
        (SELECT c.body FROM ${this.options.commentsTable} c
          WHERE c.task_id=t.id AND c.author_type='agent'
          ORDER BY c.created_at DESC LIMIT 1) AS summary
      FROM ${this.options.tasksTable} t
      JOIN ${this.options.boardsTable} b ON b.id=t.board_id
      WHERE t.id=$1 AND t.deleted_at IS NULL
    `, [taskId]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: String(row.id),
      boardId: String(row.board_id),
      identifier: String(row.identifier),
      title: String(row.title),
      tenantId: String(row.tenant_id),
      ...(row.creator_user_id ? { creatorUserId: String(row.creator_user_id) } : {}),
      ...(row.responsible_user_id ? { responsibleUserId: String(row.responsible_user_id) } : {}),
      ...(row.summary ? { summary: String(row.summary) } : {}),
    };
  }

  private async deliver(claimed: ClaimedNotification, task: NotificationTask): Promise<void> {
    const watchers = await this.options.pool.query<{ user_id: string }>(
      `SELECT user_id FROM ${this.options.watchersTable} WHERE task_id=$1 ORDER BY user_id`,
      [task.id],
    );
    const recipients = uniqueRecipients([
      task.creatorUserId,
      task.responsibleUserId,
      ...watchers.rows.map((row) => row.user_id),
    ]);
    const status = buildTaskboardStatusBody(claimed.toStatus, task.summary);
    const url = `/cron?view=board&boardId=${encodeURIComponent(task.boardId)}&taskId=${encodeURIComponent(task.id)}`;

    for (const userId of recipients) {
      const result = await this.options.service.send({
        tenantId: task.tenantId,
        userId,
        eventKey: `taskboard:${claimed.id}:${claimed.toStatus}`,
        taskName: `${task.identifier} · ${task.title}`,
        status,
        url,
      });
      if (result.failed > 0) throw new Error(`${result.failed} 个浏览器订阅投递失败`);
    }
  }

  private async finish(
    claimed: ClaimedNotification,
    state: 'pending' | 'delivered' | 'failed',
    error?: string,
  ): Promise<void> {
    const retryDelaySeconds = Math.min(60, 2 ** Math.max(0, claimed.attemptCount - 1));
    await this.options.pool.query(`
      UPDATE ${this.options.outboxTable}
         SET state=$3, lease_id=NULL, lease_expires_at=NULL,
             available_at=CASE WHEN $3='pending' THEN now()+($4::int * interval '1 second') ELSE available_at END,
             delivered_at=CASE WHEN $3='delivered' THEN now() ELSE delivered_at END,
             last_error=$5
       WHERE id=$1::bigint AND lease_id=$2
    `, [claimed.id, claimed.leaseId, state, retryDelaySeconds, error?.slice(0, 1_000) ?? null]);
  }
}

export function buildTaskboardStatusBody(status: KeyStatus, summary?: string): string {
  const label = KEY_STATUSES[status];
  const normalized = summarizeComment(summary);
  return normalized ? `${label}：${normalized}` : `${label}，点击查看任务详情`;
}

export function uniqueRecipients(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function summarizeComment(value?: string): string {
  if (!value) return '';
  const line = value.split(/\r?\n/).map((item) => item.trim()).find(Boolean) ?? '';
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[#>*_`\-\s]+/, '')
    .replace(/\s+/g, ' ')
    .slice(0, 88);
}

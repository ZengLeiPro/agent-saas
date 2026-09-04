import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

import type { UserStore } from '../data/users/store.js';
import type { WebPushService } from '../webPush/service.js';
import { createLogger } from '../utils/logger.js';

const KEY_STATUSES = {
  blocked: '已阻塞',
  done: '已完成',
  canceled: '已取消',
} as const;
const MAX_ATTEMPTS = 5;
const WEB_PUSH_RETRY_DELAY_SECONDS = 65;

class WebPushDeliveryDeferredError extends Error {}

type KeyStatus = keyof typeof KEY_STATUSES;

interface ClaimedNotification {
  id: string;
  taskId: string;
  boardId: string;
  tenantId: string;
  taskIdentifier: string;
  taskTitle: string;
  fromStatus: string;
  toStatus: KeyStatus;
  recipientUserIds: string[];
  summary?: string;
  attemptCount: number;
  leaseId: string;
}

interface CurrentTaskAccess {
  tenantId: string;
  ownerUserId: string;
  visibility: 'personal' | 'organization';
}

export interface TaskboardStatusNotificationWorkerOptions {
  pool: Pool;
  tasksTable: string;
  boardsTable: string;
  outboxTable: string;
  service: WebPushService;
  userStore?: UserStore;
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
      const access = await this.loadCurrentAccess(claimed);
      if (access) await this.deliver(claimed, access);
      await this.finish(claimed, 'delivered');
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const deferred = error instanceof WebPushDeliveryDeferredError;
      await this.finish(claimed, !deferred && claimed.attemptCount >= MAX_ATTEMPTS ? 'failed' : 'pending', detail, deferred);
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
      RETURNING o.id::text,o.task_id,o.board_id,o.tenant_id,o.task_identifier,o.task_title,
                o.from_status,o.to_status,o.recipient_user_ids,o.event_summary,o.attempt_count
    `, [leaseId]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: String(row.id),
      taskId: String(row.task_id),
      boardId: String(row.board_id),
      tenantId: String(row.tenant_id),
      taskIdentifier: String(row.task_identifier),
      taskTitle: String(row.task_title),
      fromStatus: String(row.from_status),
      toStatus: String(row.to_status) as KeyStatus,
      recipientUserIds: parseRecipientIds(row.recipient_user_ids),
      ...(row.event_summary ? { summary: String(row.event_summary) } : {}),
      attemptCount: Number(row.attempt_count),
      leaseId,
    };
  }

  private async loadCurrentAccess(claimed: ClaimedNotification): Promise<CurrentTaskAccess | null> {
    const result = await this.options.pool.query<Record<string, unknown>>(`
      SELECT b.tenant_id,b.owner_user_id,b.visibility
      FROM ${this.options.tasksTable} t
      JOIN ${this.options.boardsTable} b ON b.id=t.board_id
      WHERE t.id=$1 AND t.board_id=$2 AND t.deleted_at IS NULL
    `, [claimed.taskId, claimed.boardId]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      tenantId: String(row.tenant_id),
      ownerUserId: String(row.owner_user_id),
      visibility: String(row.visibility) as CurrentTaskAccess['visibility'],
    };
  }

  private async deliver(claimed: ClaimedNotification, access: CurrentTaskAccess): Promise<void> {
    this.options.userStore?.reload();
    const recipients = claimed.recipientUserIds.filter((userId) => this.canReadCurrentTask(userId, access));
    const status = buildTaskboardStatusBody(claimed.toStatus, claimed.summary);
    // 新通知直接使用任务看板独立路由；Web 仍兼容已发送的旧 /cron?view=board 深链。
    const url = `/taskboard?boardId=${encodeURIComponent(claimed.boardId)}&taskId=${encodeURIComponent(claimed.taskId)}`;

    const failures: string[] = [];
    let deferredCount = 0;
    for (const userId of recipients) {
      try {
        const result = await this.options.service.send({
          tenantId: access.tenantId,
          userId,
          eventKey: `taskboard:${claimed.id}:${claimed.toStatus}`,
          taskName: `${claimed.taskIdentifier} · ${claimed.taskTitle}`,
          status,
          url,
        });
        if (result.failed > 0) failures.push(`${userId}: ${result.failed} 个浏览器订阅投递失败`);
        deferredCount += result.deferred;
      } catch (error) {
        failures.push(`${userId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures.length > 0) throw new Error(failures.join('; '));
    if (deferredCount > 0) throw new WebPushDeliveryDeferredError(`${deferredCount} 个浏览器订阅等待重试`);
  }

  private canReadCurrentTask(userId: string, access: CurrentTaskAccess): boolean {
    if (access.visibility !== 'organization' && userId !== access.ownerUserId) return false;
    const user = this.options.userStore?.findById(userId);
    return !this.options.userStore || Boolean(user && user.tenantId === access.tenantId && !user.disabled);
  }

  private async finish(
    claimed: ClaimedNotification,
    state: 'pending' | 'delivered' | 'failed',
    error?: string,
    deferred = false,
  ): Promise<void> {
    await this.options.pool.query(`
      UPDATE ${this.options.outboxTable}
         SET state=$3, lease_id=NULL, lease_expires_at=NULL,
             available_at=CASE WHEN $3='pending' THEN now()+($4::int * interval '1 second') ELSE available_at END,
             delivered_at=CASE WHEN $3='delivered' THEN now() ELSE delivered_at END,
             attempt_count=CASE WHEN $6::boolean THEN GREATEST(attempt_count-1,0) ELSE attempt_count END,
             last_error=$5
       WHERE id=$1::bigint AND lease_id=$2
    `, [claimed.id, claimed.leaseId, state, WEB_PUSH_RETRY_DELAY_SECONDS, error?.slice(0, 1_000) ?? null, deferred]);
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

function parseRecipientIds(value: unknown): string[] {
  return uniqueRecipients(Array.isArray(value) ? value.map((item) => String(item)) : []);
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

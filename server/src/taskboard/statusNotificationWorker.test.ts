import { describe, expect, it, vi } from 'vitest';

import { TaskboardStatusNotificationWorker, buildTaskboardStatusBody, uniqueRecipients } from './statusNotificationWorker.js';

describe('TaskboardStatusNotificationWorker', () => {
  it('向创建者、最近执行发起者与关注者去重发送，并携带任务深链和结果摘要', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        id: '42', task_id: 'task-1', from_status: 'in_review', to_status: 'done', attempt_count: 1,
      }] })
      .mockResolvedValueOnce({ rows: [{
        id: 'task-1', board_id: 'board-1', identifier: 'TASK-86', title: '关键通知',
        creator_user_id: 'creator', responsible_user_id: 'owner', tenant_id: 'tenant-1',
        summary: '## 已完成实现\n其余详情',
      }] })
      .mockResolvedValueOnce({ rows: [{ user_id: 'watcher' }, { user_id: 'creator' }] })
      .mockResolvedValue({ rows: [] });
    const send = vi.fn().mockResolvedValue({ sent: 1, failed: 0, skipped: 0 });
    const worker = new TaskboardStatusNotificationWorker({
      pool: { query } as never,
      tasksTable: 'tasks', boardsTable: 'boards', commentsTable: 'comments', executionsTable: 'executions',
      watchersTable: 'watchers', outboxTable: 'outbox', service: { send } as never,
    });

    await expect(worker.runOnce()).resolves.toBe(true);

    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls.map(([message]) => message.userId).sort()).toEqual(['creator', 'owner', 'watcher']);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-1', eventKey: 'taskboard:42:done', taskName: 'TASK-86 · 关键通知',
      status: '已完成：已完成实现', url: '/cron?view=board&boardId=board-1&taskId=task-1',
    }));
    expect(String(query.mock.calls.at(-1)?.[0])).toContain("state=$3");
    expect(query.mock.calls.at(-1)?.[1]?.[2]).toBe('delivered');
  });

  it('投递失败会保留 outbox 重试，而不是丢失状态事件', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        id: '43', task_id: 'task-2', from_status: 'in_progress', to_status: 'blocked', attempt_count: 1,
      }] })
      .mockResolvedValueOnce({ rows: [{
        id: 'task-2', board_id: 'board-2', identifier: 'TASK-2', title: '失败任务',
        creator_user_id: 'creator', tenant_id: 'tenant-1', summary: '缺少生产凭据',
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValue({ rows: [] });
    const worker = new TaskboardStatusNotificationWorker({
      pool: { query } as never,
      tasksTable: 'tasks', boardsTable: 'boards', commentsTable: 'comments', executionsTable: 'executions',
      watchersTable: 'watchers', outboxTable: 'outbox',
      service: { send: vi.fn().mockResolvedValue({ sent: 0, failed: 1, skipped: 0 }) } as never,
    });

    await expect(worker.runOnce()).resolves.toBe(true);
    expect(query.mock.calls.at(-1)?.[1]?.[2]).toBe('pending');
    expect(query.mock.calls.at(-1)?.[1]?.[4]).toContain('投递失败');
  });
});

describe('任务状态通知文案', () => {
  it('清理 Markdown、限制摘要并对收件人去重', () => {
    expect(buildTaskboardStatusBody('blocked', '  [凭据说明](https://example.com) 不完整  ')).toBe('已阻塞：凭据说明 不完整');
    expect(buildTaskboardStatusBody('canceled')).toBe('已取消，点击查看任务详情');
    expect(uniqueRecipients(['a', ' a ', undefined, '', 'b'])).toEqual(['a', 'b']);
  });
});

import { describe, expect, it, vi } from 'vitest';

import { TaskboardStatusNotificationWorker, buildTaskboardStatusBody, uniqueRecipients } from './statusNotificationWorker.js';

function claimRow(patch: Record<string, unknown> = {}) {
  return {
    id: '42', task_id: 'task-1', board_id: 'board-1', tenant_id: 'tenant-1',
    task_identifier: 'TASK-86', task_title: '关键通知', from_status: 'in_review', to_status: 'done',
    recipient_user_ids: ['creator', 'owner', 'watcher'], event_summary: '## 已完成实现\n其余详情',
    attempt_count: 1, ...patch,
  };
}

function workerWith(query: ReturnType<typeof vi.fn>, send: ReturnType<typeof vi.fn>, userStore?: object) {
  return new TaskboardStatusNotificationWorker({
    pool: { query } as never,
    tasksTable: 'tasks', boardsTable: 'boards', outboxTable: 'outbox', service: { send } as never,
    userStore: userStore as never,
  });
}

describe('TaskboardStatusNotificationWorker', () => {
  it('使用状态事件快照向创建者、负责人和关注者发送对应摘要', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [claimRow()] })
      .mockResolvedValueOnce({ rows: [{ tenant_id: 'tenant-1', owner_user_id: 'board-owner', visibility: 'organization' }] })
      .mockResolvedValue({ rows: [] });
    const send = vi.fn().mockResolvedValue({ sent: 1, failed: 0, skipped: 0, deferred: 0 });

    await expect(workerWith(query, send).runOnce()).resolves.toBe(true);

    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls.map(([message]) => message.userId).sort()).toEqual(['creator', 'owner', 'watcher']);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-1', eventKey: 'taskboard:42:done', taskName: 'TASK-86 · 关键通知',
      status: '已完成：已完成实现', url: '/cron?view=board&boardId=board-1&taskId=task-1',
    }));
    expect(query.mock.calls.map(([sql]) => String(sql)).join('\n')).not.toContain('FROM comments');
    expect(query.mock.calls.at(-1)?.[1]?.[2]).toBe('delivered');
  });

  it('failed 后 delivery claim 暂缓时继续保留 outbox，不误标 delivered', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [claimRow({ id: '43', to_status: 'blocked', attempt_count: 1 })] })
      .mockResolvedValueOnce({ rows: [{ tenant_id: 'tenant-1', owner_user_id: 'creator', visibility: 'personal' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [claimRow({ id: '43', to_status: 'blocked', attempt_count: 2 })] })
      .mockResolvedValueOnce({ rows: [{ tenant_id: 'tenant-1', owner_user_id: 'creator', visibility: 'personal' }] })
      .mockResolvedValue({ rows: [] });
    const send = vi.fn()
      .mockResolvedValueOnce({ sent: 0, failed: 1, skipped: 0, deferred: 0 })
      .mockResolvedValueOnce({ sent: 0, failed: 0, skipped: 0, deferred: 1 });
    const worker = workerWith(query, send);

    await expect(worker.runOnce()).resolves.toBe(true);
    await expect(worker.runOnce()).resolves.toBe(true);

    const finishes = query.mock.calls.filter(([sql]) => String(sql).includes('SET state=$3'));
    expect(finishes).toHaveLength(2);
    expect(finishes.map(([, params]) => params[2])).toEqual(['pending', 'pending']);
    expect(finishes.map(([, params]) => params[3])).toEqual([65, 65]);
    expect(finishes.map(([, params]) => params[5])).toEqual([false, true]);
  });

  it('单个收件人失败时仍继续尝试其余收件人', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [claimRow({ recipient_user_ids: ['first', 'second'] })] })
      .mockResolvedValueOnce({ rows: [{ tenant_id: 'tenant-1', owner_user_id: 'owner', visibility: 'organization' }] })
      .mockResolvedValue({ rows: [] });
    const send = vi.fn()
      .mockResolvedValueOnce({ sent: 0, failed: 1, skipped: 0, deferred: 0 })
      .mockResolvedValueOnce({ sent: 1, failed: 0, skipped: 0, deferred: 0 });

    await workerWith(query, send).runOnce();

    expect(send).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.at(-1)?.[1]?.[2]).toBe('pending');
  });

  it('组织看板投递前刷新用户并过滤已禁用或已迁出租户的收件人', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [claimRow({ recipient_user_ids: ['valid', 'disabled', 'moved'] })] })
      .mockResolvedValueOnce({ rows: [{ tenant_id: 'tenant-1', owner_user_id: 'owner', visibility: 'organization' }] })
      .mockResolvedValue({ rows: [] });
    const send = vi.fn().mockResolvedValue({ sent: 1, failed: 0, skipped: 0, deferred: 0 });
    const users = new Map([
      ['valid', { id: 'valid', tenantId: 'tenant-1' }],
      ['disabled', { id: 'disabled', tenantId: 'tenant-1', disabled: false }],
      ['moved', { id: 'moved', tenantId: 'tenant-2' }],
    ]);
    const reload = vi.fn(() => { users.set('disabled', { id: 'disabled', tenantId: 'tenant-1', disabled: true }); });

    await workerWith(query, send, { reload, findById: (id: string) => users.get(id) }).runOnce();

    expect(reload).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ userId: 'valid' }));
  });

  it('组织看板改为个人后不再向历史关注者发送', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [claimRow({ recipient_user_ids: ['board-owner', 'old-watcher', 'disabled'] })] })
      .mockResolvedValueOnce({ rows: [{ tenant_id: 'tenant-1', owner_user_id: 'board-owner', visibility: 'personal' }] })
      .mockResolvedValue({ rows: [] });
    const send = vi.fn().mockResolvedValue({ sent: 1, failed: 0, skipped: 0, deferred: 0 });
    const users = new Map([
      ['board-owner', { id: 'board-owner', tenantId: 'tenant-1' }],
      ['old-watcher', { id: 'old-watcher', tenantId: 'tenant-1' }],
      ['disabled', { id: 'disabled', tenantId: 'tenant-1', disabled: true }],
    ]);

    const reload = vi.fn();
    await workerWith(query, send, { reload, findById: (id: string) => users.get(id) }).runOnce();

    expect(reload).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ userId: 'board-owner' }));
  });
});

describe('任务状态通知文案', () => {
  it('清理 Markdown、限制摘要并对收件人去重', () => {
    expect(buildTaskboardStatusBody('blocked', '  [凭据说明](https://example.com) 不完整  ')).toBe('已阻塞：凭据说明 不完整');
    expect(buildTaskboardStatusBody('canceled')).toBe('已取消，点击查看任务详情');
    expect(uniqueRecipients(['a', ' a ', undefined, '', 'b'])).toEqual(['a', 'b']);
  });
});

import { describe, expect, it, vi } from 'vitest';

import { OrgAgentControlCommandUnsettledError } from '../runtime/background/orgAgentControlCommandSettlement.js';
import { item, now, setup, workOrder } from './dwsOrgGroupMessageRouterFixtures.js';

describe('AgentDwsMessageRouter fast control recovery', () => {
  it('控制命令未完成失败结算时不单独保存错误回复', async () => {
    const routed = workOrder({ shortId: 'W-123456ABCDEF' });
    const backgroundTasks = {
      get: vi.fn().mockResolvedValue({ status: 'running' }),
      cancel: vi.fn(),
      controlWorkOrder: vi
        .fn()
        .mockRejectedValue(
          new OrgAgentControlCommandUnsettledError(
            new Error('INJECTED_STOP_FAILURE'),
            new Error('INJECTED_SETTLEMENT_FAILURE'),
          ),
        ),
    };
    const test = setup({
      claimedSequence: [],
      controlClaimed: {
        ...item,
        content: '暂停 W-123456ABCDEF',
        workConversationId: 'workconv-route-a',
      },
      shortWorkOrder: routed,
      workOrders: [routed],
      backgroundTasks,
    });

    test.router.start();
    await vi.waitFor(() => expect(test.messageStore.fail).toHaveBeenCalledOnce());
    expect(test.messageStore.saveDispatchResult).not.toHaveBeenCalled();
    expect(test.messageStore.markReplyAttemptStarted).not.toHaveBeenCalled();
    expect(test.sender.send).not.toHaveBeenCalled();
    await test.router.stop();
  });

  it('控制回复已随任务 mutation 持久化时，重领只发送回复且不重复执行控制', async () => {
    const routed = workOrder({ shortId: 'W-123456ABCDEF' });
    const backgroundTasks = {
      get: vi.fn(),
      cancel: vi.fn(),
      controlWorkOrder: vi.fn(),
    };
    const persisted = '任务 W-123456ABCDEF 已暂停。';
    const test = setup({
      claimedSequence: [],
      controlClaimed: {
        ...item,
        content: '暂停 W-123456ABCDEF',
        state: 'reply_pending',
        replyKind: 'normal',
        responseText: persisted,
        replyStartedAt: now,
        attempt: 2,
        leaseFence: 2,
        workConversationId: 'workconv-route-a',
      },
      shortWorkOrder: routed,
      workOrders: [routed],
      backgroundTasks,
    });

    test.router.start();
    await vi.waitFor(() =>
      expect(test.sender.send).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(Object),
        persisted,
        expect.any(String),
        expect.any(Function),
      ),
    );
    expect(backgroundTasks.controlWorkOrder).not.toHaveBeenCalled();
    expect(test.messageStore.saveDispatchResult).not.toHaveBeenCalled();
    expect(test.messageStore.complete).toHaveBeenCalledWith('inbox-a', 'agent-dws-control', 2);
    await test.router.stop();
  });
});

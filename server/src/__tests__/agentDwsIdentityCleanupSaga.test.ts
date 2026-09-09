import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentDwsAccountRecord,
  AgentDwsAccountStore,
} from '../data/agentDwsAccounts/index.js';
import { AgentDwsAuthFlowService } from '../dws/agentAuthFlow.js';

const previous = {
  profileId: 'corp-a:old',
  corpId: 'corp-a',
  dingtalkUserId: 'old',
  identityUpdatedAt: '2026-09-08T00:00:00.000Z',
};
const base: AgentDwsAccountRecord = {
  accountId: 'account-a',
  tenantId: 'tenant-a',
  agentId: 'agent-a',
  displayName: '员工',
  loginId: 'employee-a',
  profileId: 'corp-a:new',
  corpId: 'corp-a',
  dingtalkUserId: 'new',
  identityUpdatedAt: '2026-09-08T01:00:00.000Z',
  status: 'active',
  runtimeStatus: 'stopped',
  eventKinds: ['at_me'],
  revision: 3,
  createdAt: '2026-09-08T00:00:00.000Z',
  createdBy: 'admin',
  updatedAt: '2026-09-08T01:00:00.000Z',
  updatedBy: 'system',
  identityCleanupPending: { previous, streamStopped: false, contextInvalidated: false },
};

function service(input: {
  state: { account: AgentDwsAccountRecord };
  stop?: () => Promise<void>;
  invalidate?: () => Promise<void>;
  connect?: () => Promise<void>;
}) {
  const markIdentityCleanupStep = vi.fn(
    async (
      _tenant: string,
      _account: string,
      _epoch: string,
      step: 'stream_stopped' | 'context_invalidated',
    ) => {
      input.state.account =
        step === 'stream_stopped'
          ? {
              ...input.state.account,
              identityCleanupPending: {
                ...input.state.account.identityCleanupPending!,
                streamStopped: true,
              },
            }
          : { ...input.state.account, identityCleanupPending: undefined };
      return input.state.account;
    },
  );
  const result = new AgentDwsAuthFlowService({
    agentCwd: '/tmp/not-used',
    authSessionStore: {} as never,
    runner: {} as never,
    accountStore: {
      listRunnable: vi.fn(async () => [input.state.account]),
      markIdentityCleanupStep,
    } as unknown as AgentDwsAccountStore,
    stopPreviousIdentity: input.stop,
    invalidatePreviousIdentityContext: input.invalidate,
    onConnected: input.connect ?? vi.fn(async () => undefined),
  });
  return { result, markIdentityCleanupStep };
}

describe('Agent DWS 身份 cleanup durable saga', () => {
  afterEach(() => vi.useRealTimers());

  it('stop 失败不推进状态，重启后只推进成功步骤，context 失败后再次恢复完成', async () => {
    const state = { account: structuredClone(base) };
    const first = service({
      state,
      stop: vi.fn(async () => {
        throw new Error('stop transient');
      }),
      invalidate: vi.fn(async () => undefined),
    });
    await expect(first.result.recoverPendingIdentityCleanup()).rejects.toThrow(
      'Agent DWS identity cleanup incomplete',
    );
    expect(first.markIdentityCleanupStep).not.toHaveBeenCalled();

    const stopAfterRestart = vi.fn(async () => undefined);
    const second = service({
      state,
      stop: stopAfterRestart,
      invalidate: vi.fn(async () => {
        throw new Error('context transient');
      }),
    });
    await expect(second.result.recoverPendingIdentityCleanup()).rejects.toThrow(
      'Agent DWS identity cleanup incomplete',
    );
    expect(second.markIdentityCleanupStep).toHaveBeenCalledTimes(1);
    expect(state.account.identityCleanupPending?.streamStopped).toBe(true);

    const stopFinal = vi.fn(async () => undefined);
    const invalidateFinal = vi.fn(async () => undefined);
    const third = service({ state, stop: stopFinal, invalidate: invalidateFinal });
    await third.result.recoverPendingIdentityCleanup();
    expect(stopFinal).not.toHaveBeenCalled();
    expect(invalidateFinal).toHaveBeenCalledWith(expect.objectContaining(previous));
    expect(state.account.identityCleanupPending).toBeUndefined();
  });

  it('pending cleanup 缺少对应 callback 时 fail closed 且不推进步骤', async () => {
    const stopMissing = service({
      state: { account: structuredClone(base) },
      invalidate: vi.fn(async () => undefined),
    });
    await expect(stopMissing.result.recoverPendingIdentityCleanup()).rejects.toThrow(
      'Agent DWS identity cleanup incomplete',
    );
    expect(stopMissing.markIdentityCleanupStep).not.toHaveBeenCalled();

    const contextMissingState = {
      account: {
        ...structuredClone(base),
        identityCleanupPending: { ...base.identityCleanupPending!, streamStopped: true },
      },
    };
    const contextMissing = service({
      state: contextMissingState,
      stop: vi.fn(async () => undefined),
    });
    await expect(contextMissing.result.recoverPendingIdentityCleanup()).rejects.toThrow(
      'Agent DWS identity cleanup incomplete',
    );
    expect(contextMissing.markIdentityCleanupStep).not.toHaveBeenCalled();
  });

  it('pending cleanup 缺少 epoch 或持久化步骤能力时 fail closed', async () => {
    const missingEpochState = {
      account: {
        ...structuredClone(base),
        identityUpdatedAt: undefined,
      },
    };
    const missingEpoch = service({
      state: missingEpochState,
      stop: vi.fn(async () => undefined),
      invalidate: vi.fn(async () => undefined),
    });
    await expect(missingEpoch.result.recoverPendingIdentityCleanup()).rejects.toThrow(
      'Agent DWS identity cleanup incomplete',
    );
    expect(missingEpoch.markIdentityCleanupStep).not.toHaveBeenCalled();
    expect(missingEpochState.account.identityCleanupPending).toBeDefined();

    const markMissingState = { account: structuredClone(base) };
    const stop = vi.fn(async () => undefined);
    const markMissing = new AgentDwsAuthFlowService({
      agentCwd: '/tmp/not-used',
      authSessionStore: {} as never,
      runner: {} as never,
      accountStore: {
        listRunnable: vi.fn(async () => [markMissingState.account]),
      } as unknown as AgentDwsAccountStore,
      stopPreviousIdentity: stop,
      invalidatePreviousIdentityContext: vi.fn(async () => undefined),
      onConnected: vi.fn(async () => undefined),
    });
    await expect(markMissing.recoverPendingIdentityCleanup()).rejects.toThrow(
      'Agent DWS identity cleanup incomplete',
    );
    expect(stop).not.toHaveBeenCalled();
    expect(markMissingState.account.identityCleanupPending).toBeDefined();
  });

  it('在线恢复缺少 onConnected 时不失效 context 且不清除 pending', async () => {
    const state = {
      account: {
        ...structuredClone(base),
        identityCleanupPending: { ...base.identityCleanupPending!, streamStopped: true },
      },
    };
    const invalidate = vi.fn(async () => undefined);
    const markIdentityCleanupStep = vi.fn();
    const result = new AgentDwsAuthFlowService({
      agentCwd: '/tmp/not-used',
      authSessionStore: {} as never,
      runner: {} as never,
      accountStore: {
        listRunnable: vi.fn(async () => [state.account]),
        markIdentityCleanupStep,
      } as unknown as AgentDwsAccountStore,
      stopPreviousIdentity: vi.fn(async () => undefined),
      invalidatePreviousIdentityContext: invalidate,
    });

    await expect(result.recoverPendingIdentityCleanup()).rejects.toThrow(
      'Agent DWS identity cleanup incomplete',
    );
    expect(invalidate).not.toHaveBeenCalled();
    expect(markIdentityCleanupStep).not.toHaveBeenCalled();
    expect(state.account.identityCleanupPending).toBeDefined();
  });

  it('在线 retry 隔离单账号失败并在 stop 后取消后续调度', async () => {
    vi.useFakeTimers();
    const accounts = new Map([
      ['account-a', structuredClone(base)],
      [
        'account-b',
        {
          ...structuredClone(base),
          accountId: 'account-b',
          identityCleanupPending: {
            ...base.identityCleanupPending!,
            previous: {
              ...previous,
              dingtalkUserId: 'old-b',
              profileId: 'corp-a:old-b',
            },
          },
        },
      ],
    ]);
    let failAOnce = true;
    const stopPreviousIdentity = vi.fn(async (old: AgentDwsAccountRecord) => {
      if (old.accountId === 'account-a' && failAOnce) {
        failAOnce = false;
        throw new Error('account-a transient');
      }
    });
    const markIdentityCleanupStep = vi.fn(
      async (
        _tenant: string,
        accountId: string,
        _epoch: string,
        step: 'stream_stopped' | 'context_invalidated',
      ) => {
        const current = accounts.get(accountId)!;
        const updated =
          step === 'stream_stopped'
            ? {
                ...current,
                identityCleanupPending: {
                  ...current.identityCleanupPending!,
                  streamStopped: true,
                },
              }
            : { ...current, identityCleanupPending: undefined };
        accounts.set(accountId, updated);
        return updated;
      },
    );
    const onConnected = vi.fn(async () => undefined);
    const result = new AgentDwsAuthFlowService({
      agentCwd: '/tmp/not-used',
      authSessionStore: {} as never,
      runner: {} as never,
      accountStore: {
        listRunnable: vi.fn(async () => [...accounts.values()]),
        markIdentityCleanupStep,
      } as unknown as AgentDwsAccountStore,
      stopPreviousIdentity,
      invalidatePreviousIdentityContext: vi.fn(async () => undefined),
      onConnected,
    });

    result.startIdentityCleanupRecovery(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(accounts.get('account-b')?.identityCleanupPending).toBeUndefined();
    expect(accounts.get('account-a')?.identityCleanupPending).toBeDefined();
    await vi.advanceTimersByTimeAsync(100);
    expect(accounts.get('account-a')?.identityCleanupPending).toBeUndefined();
    expect(onConnected).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'account-a' }));

    const callsBeforeStop = stopPreviousIdentity.mock.calls.length;
    await result.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(stopPreviousIdentity).toHaveBeenCalledTimes(callsBeforeStop);
  });
});

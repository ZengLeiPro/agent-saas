import { describe, expect, it, vi } from 'vitest';

import { publishAdminCommittedConfigIdentity } from './audioTranscribeAdminRoute.js';

describe('publishAdminCommittedConfigIdentity', () => {
  it('精确文本仍胜出时同步撤销旧 observation，且不强制刷新', async () => {
    let summaryStatus = 'consistent';
    const runtime = {
      acknowledgeSharedConfigApplied: vi.fn((text: string) => text === 'winner-text'),
      invalidateSharedConfigIdentity: vi.fn(() => { summaryStatus = 'not_collected'; }),
      notifySharedConfigChanged: vi.fn(() => { summaryStatus = 'not_collected'; }),
      refreshSharedConfig: vi.fn(async () => true),
    };

    const published = publishAdminCommittedConfigIdentity(runtime, 'winner-text');

    expect(runtime.acknowledgeSharedConfigApplied).toHaveBeenCalledWith('winner-text');
    expect(runtime.notifySharedConfigChanged).toHaveBeenCalledOnce();
    expect(runtime.invalidateSharedConfigIdentity).not.toHaveBeenCalled();
    expect(summaryStatus).toBe('not_collected');
    expect(runtime.refreshSharedConfig).not.toHaveBeenCalled();
    await published;
  });

  it('并发胜出时不确认本请求候选，先撤销 observation 再强制刷新胜出版本', async () => {
    const calls: string[] = [];
    const runtime = {
      acknowledgeSharedConfigApplied: vi.fn((text: string) => {
        calls.push(`ack:${text}`);
        return false;
      }),
      invalidateSharedConfigIdentity: vi.fn(() => { calls.push('invalidate'); }),
      notifySharedConfigChanged: vi.fn(() => { calls.push('notify'); }),
      refreshSharedConfig: vi.fn(async (force?: boolean) => {
        calls.push(`refresh:${String(force)}`);
        return true;
      }),
    };

    await publishAdminCommittedConfigIdentity(runtime, 'losing-candidate-text');

    expect(calls).toEqual([
      'ack:losing-candidate-text',
      'invalidate',
      'refresh:true',
      'notify',
    ]);
  });

  it('并发胜出版本强制刷新失败时 fail closed', async () => {
    let summaryStatus = 'consistent';
    const runtime = {
      acknowledgeSharedConfigApplied: vi.fn(() => false),
      invalidateSharedConfigIdentity: vi.fn(() => { summaryStatus = 'not_collected'; }),
      notifySharedConfigChanged: vi.fn(() => { summaryStatus = 'not_collected'; }),
      refreshSharedConfig: vi.fn(async () => false),
    };

    await expect(
      publishAdminCommittedConfigIdentity(runtime, 'losing-candidate-text'),
    ).rejects.toThrow('配置文件被并发改写且重载失败');
    expect(summaryStatus).toBe('not_collected');
    expect(runtime.notifySharedConfigChanged).not.toHaveBeenCalled();
  });
});

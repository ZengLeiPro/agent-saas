import { describe, expect, it, vi } from 'vitest';

import { createRuntimeWebPushAssembly } from '../app/runtimeWebPush.js';
import { notifyWebPushForRuntimeEvent } from '../webPush/runtimeEventNotifier.js';

vi.mock('../webPush/runtimeEventNotifier.js', () => ({
  notifyWebPushForRuntimeEvent: vi.fn(),
}));

vi.mock('../webPush/service.js', () => ({
  isWebPushConfigured: vi.fn(() => true),
  WebPushService: class WebPushService {
    constructor(..._args: unknown[]) {}
  },
}));

vi.mock('../webPush/store.js', () => ({
  PgWebPushStore: class PgWebPushStore {
    constructor(..._args: unknown[]) {}
    async init() {}
  },
}));

describe('Runtime Web Push 投递', () => {
  it('等待后台任务完成通知投递，避免事件订阅提前确认', async () => {
    let release!: () => void;
    vi.mocked(notifyWebPushForRuntimeEvent).mockReturnValueOnce(new Promise<void>((resolve) => {
      release = resolve;
    }));
    const logger = { warn: vi.fn() };
    const assembly = createRuntimeWebPushAssembly({
      config: {
        webPush: {
          enabled: true,
          publicKey: 'public-key',
          privateKey: 'private-key',
          subject: 'mailto:test@example.com',
        },
      } as never,
      getSessionStore: () => ({}) as never,
      logger: logger as never,
    });
    await assembly.initialize({ pool: {} } as never);

    let settled = false;
    const delivery = assembly.deliverRuntimeEvent({ type: 'background_task_finished' } as never)
      .then(() => { settled = true; });
    await Promise.resolve();

    expect(notifyWebPushForRuntimeEvent).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    release();
    await delivery;
    expect(settled).toBe(true);
  });

  it('记录并传播投递错误，让事件订阅保留重试机会', async () => {
    const error = new Error('session store unavailable');
    vi.mocked(notifyWebPushForRuntimeEvent).mockRejectedValueOnce(error);
    const logger = { warn: vi.fn() };
    const assembly = createRuntimeWebPushAssembly({
      config: {
        webPush: {
          enabled: true,
          publicKey: 'public-key',
          privateKey: 'private-key',
          subject: 'mailto:test@example.com',
        },
      } as never,
      getSessionStore: () => ({}) as never,
      logger: logger as never,
    });
    await assembly.initialize({ pool: {} } as never);

    await expect(assembly.deliverRuntimeEvent({ type: 'background_task_finished' } as never))
      .rejects.toThrow('session store unavailable');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('event=background_task_finished'));
  });
});

/**
 * 壳内安装实例单一来源（WP4 Phase A 遗留 §6-1：消除壳内两次 `/api/systems/mine`）。
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { MySystemInstallation } from '@/lib/systemsApi';
import {
  __setMySystemsLoaderForTests,
  findInstallation,
  getMySystemsSnapshot,
  loadMySystems,
  subscribeMySystems,
} from './mySystemsSource';

function installation(overrides: Partial<MySystemInstallation> = {}): MySystemInstallation {
  return {
    installationId: 'inst-1',
    systemId: 'crm',
    name: '客户管理',
    icon: '📦',
    origin: 'https://t1-crm.apps.example.com',
    state: 'enabled',
    externalLinkHosts: [],
    ...overrides,
  };
}

afterEach(() => {
  __setMySystemsLoaderForTests(null);
});

describe('单飞与共享快照', () => {
  it('并发的多个消费者只触发一次取数', async () => {
    let calls = 0;
    __setMySystemsLoaderForTests(async () => {
      calls += 1;
      return { installations: [installation()] };
    });
    await Promise.all([loadMySystems(), loadMySystems(), loadMySystems()]);
    expect(calls).toBe(1);
    expect(getMySystemsSnapshot().status).toBe('ready');
  });

  it('已就绪后不再重复取数，force 才重新拉', async () => {
    let calls = 0;
    __setMySystemsLoaderForTests(async () => {
      calls += 1;
      return { installations: [installation({ name: `第 ${calls} 次` })] };
    });
    await loadMySystems();
    await loadMySystems();
    expect(calls).toBe(1);
    await loadMySystems({ force: true });
    expect(calls).toBe(2);
    expect(getMySystemsSnapshot().installations[0].name).toBe('第 2 次');
  });

  it('订阅者拿到同一份快照', async () => {
    const seen: string[] = [];
    __setMySystemsLoaderForTests(async () => ({ installations: [installation()] }));
    const unsubscribeA = subscribeMySystems((snapshot) => seen.push(`A:${snapshot.status}`));
    const unsubscribeB = subscribeMySystems((snapshot) => seen.push(`B:${snapshot.status}`));
    await loadMySystems();
    expect(seen).toEqual(['A:ready', 'B:ready']);
    unsubscribeA();
    unsubscribeB();
  });

  it('一个订阅者抛错不影响其它订阅者', async () => {
    const seen: string[] = [];
    __setMySystemsLoaderForTests(async () => ({ installations: [installation()] }));
    subscribeMySystems(() => {
      throw new Error('订阅者炸了');
    });
    subscribeMySystems((snapshot) => seen.push(snapshot.status));
    await loadMySystems();
    expect(seen).toEqual(['ready']);
  });
});

describe('失败与重试', () => {
  it('失败置 failed 并把异常抛给调用方；已有快照不被清空', async () => {
    let attempt = 0;
    __setMySystemsLoaderForTests(async () => {
      attempt += 1;
      if (attempt === 1) return { installations: [installation()] };
      throw new Error('HTTP 500');
    });
    await loadMySystems();
    await expect(loadMySystems({ force: true })).rejects.toThrow('HTTP 500');
    const snapshot = getMySystemsSnapshot();
    expect(snapshot.status).toBe('failed');
    // 退回空列表会让左栏整块消失，比「保留旧列表 + 重试」更糟
    expect(snapshot.installations).toHaveLength(1);
  });

  it('失败后 force 重试可以恢复 ready', async () => {
    let attempt = 0;
    __setMySystemsLoaderForTests(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('HTTP 500');
      return { installations: [installation()] };
    });
    await expect(loadMySystems()).rejects.toThrow();
    await loadMySystems({ force: true });
    expect(getMySystemsSnapshot().status).toBe('ready');
  });
});

describe('findInstallation', () => {
  it('命中返回实例，未命中/空参返回 null', async () => {
    __setMySystemsLoaderForTests(async () => ({ installations: [installation()] }));
    await loadMySystems();
    expect(findInstallation('inst-1')?.origin).toBe('https://t1-crm.apps.example.com');
    expect(findInstallation('inst-404')).toBeNull();
    expect(findInstallation(null)).toBeNull();
    expect(findInstallation(undefined)).toBeNull();
  });
});

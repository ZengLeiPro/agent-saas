import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => new Map<string, string>());

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => storage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: async (key: string) => {
      storage.delete(key);
    },
    getAllKeys: async () => [...storage.keys()],
    multiRemove: async (keys: string[]) => {
      for (const key of keys) storage.delete(key);
    },
  },
}));

vi.mock('expo-constants', () => ({
  default: {
    deviceName: 'Leo 的 iPhone',
    expoConfig: { version: '1.2.3', ios: { buildNumber: '85' } },
  },
}));

import {
  PUSH_BINDING_KEY_BASE,
  clearAllPushBindings,
  currentAppVersion,
  currentPushEnvironment,
  describeDevice,
  formatAppVersion,
  formatDeviceName,
  hashPushToken,
  normalizePushDeviceStatus,
  pushBindingStorageKey,
  readPushBinding,
  writePushBinding,
} from './pushDevices';

const alice = { tenantId: 't1', userId: 'u1' };
const bob = { tenantId: 't1', userId: 'u2' };

describe('推送设备本机绑定', () => {
  beforeEach(() => {
    storage.clear();
  });

  it('令牌指纹稳定且随令牌变化', () => {
    expect(hashPushToken('abcd')).toBe(hashPushToken('abcd'));
    expect(hashPushToken('abcd')).not.toBe(hashPushToken('abce'));
    expect(hashPushToken('abcd')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('存储键按租户与用户作用域，无身份时拒绝落盘', () => {
    expect(pushBindingStorageKey(null)).toBeNull();
    expect(pushBindingStorageKey(alice)).not.toBe(pushBindingStorageKey(bob));
    expect(pushBindingStorageKey(alice)?.startsWith(PUSH_BINDING_KEY_BASE)).toBe(true);
    expect(pushBindingStorageKey({ tenantId: 'a/b', userId: 'c' })).toContain('a%2Fb');
  });

  it('绑定读写按身份隔离，无身份时读写都是空操作', async () => {
    await writePushBinding(alice, { id: 'dev_1', tokenHash: 'h1' });
    expect(await readPushBinding(alice)).toEqual({ id: 'dev_1', tokenHash: 'h1' });
    expect(await readPushBinding(bob)).toBeNull();

    await writePushBinding(null, { id: 'dev_x', tokenHash: 'hx' });
    expect(storage.size).toBe(1);
    expect(await readPushBinding(null)).toBeNull();

    await writePushBinding(alice, null);
    expect(await readPushBinding(alice)).toBeNull();
  });

  it('损坏的绑定记录 fail closed', async () => {
    const key = pushBindingStorageKey(alice) as string;
    storage.set(key, '{not json');
    expect(await readPushBinding(alice)).toBeNull();
    storage.set(key, JSON.stringify({ id: 'dev_1' }));
    expect(await readPushBinding(alice)).toBeNull();
  });

  it('登出清理本机所有身份的绑定，且只动自己的键', async () => {
    await writePushBinding(alice, { id: 'dev_1', tokenHash: 'h1' });
    await writePushBinding(bob, { id: 'dev_2', tokenHash: 'h2' });
    storage.set('agentChat.other', 'keep');
    await clearAllPushBindings();
    expect([...storage.keys()]).toEqual(['agentChat.other']);
  });
});

describe('推送注册元数据', () => {
  it('设备名带系统版本，缺系统设备名时按平台兜底', () => {
    expect(formatDeviceName('Leo 的 iPhone', 'iOS 18')).toBe('Leo 的 iPhone · iOS 18');
    expect(formatDeviceName(null, 'iOS 18')).toBe('iPhone · iOS 18');
    expect(formatDeviceName('  ', 'iOS 18')).toBe('iPhone · iOS 18');
    expect(formatDeviceName('长'.repeat(200), 'iOS 18').length).toBeLessThanOrEqual(120);
  });

  it('应用版本合并 marketing 版本与构建号，两段都缺时返回 null', () => {
    expect(formatAppVersion('1.2.3', '85')).toBe('1.2.3 (85)');
    expect(formatAppVersion('1.2.3', null)).toBe('1.2.3');
    expect(formatAppVersion(null, '85')).toBe('build 85');
    expect(formatAppVersion(null, null)).toBeNull();
    expect(formatAppVersion(undefined, undefined)).toBeNull();
  });

  it('从 expo-constants 读出本机描述与版本', () => {
    expect(describeDevice()).toBe('Leo 的 iPhone · iOS 18.0');
    expect(currentAppVersion()).toBe('1.2.3 (85)');
  });

  describe('推送环境跟随构建档位', () => {
    const originalProfile = process.env.EXPO_PUBLIC_V1_PROFILE;
    afterEach(() => {
      if (originalProfile === undefined) delete process.env.EXPO_PUBLIC_V1_PROFILE;
      else process.env.EXPO_PUBLIC_V1_PROFILE = originalProfile;
    });

    it('只有 production 档位使用生产网关', () => {
      process.env.EXPO_PUBLIC_V1_PROFILE = 'production';
      expect(currentPushEnvironment()).toBe('production');
      process.env.EXPO_PUBLIC_V1_PROFILE = 'preview';
      expect(currentPushEnvironment()).toBe('sandbox');
      process.env.EXPO_PUBLIC_V1_PROFILE = 'development';
      expect(currentPushEnvironment()).toBe('sandbox');
    });
  });
});

describe('normalizePushDeviceStatus', () => {
  it('丢弃形状不符的条目并归一化缺省字段', () => {
    expect(
      normalizePushDeviceStatus({
        configured: true,
        devices: [
          {
            id: 'a',
            deviceName: 'iPhone',
            environment: 'production',
            appVersion: '1.0.0 (1)',
            createdAt: 'c',
            updatedAt: 'u',
          },
          { id: 'b' },
          { deviceName: '无 id' },
          null,
        ],
      }),
    ).toEqual({
      configured: true,
      devices: [
        {
          id: 'a',
          deviceName: 'iPhone',
          environment: 'production',
          appVersion: '1.0.0 (1)',
          createdAt: 'c',
          updatedAt: 'u',
        },
        {
          id: 'b',
          deviceName: '未命名设备',
          environment: 'sandbox',
          appVersion: null,
          createdAt: '',
          updatedAt: '',
        },
      ],
    });
  });

  it('响应体缺失或形状不符时按未配置处理', () => {
    expect(normalizePushDeviceStatus(null)).toEqual({ configured: false, devices: [] });
    expect(normalizePushDeviceStatus({ configured: 'yes', devices: 'nope' })).toEqual({
      configured: false,
      devices: [],
    });
  });
});

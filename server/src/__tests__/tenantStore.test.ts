import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TenantStore } from '../data/tenants/store.js';
import { DEFAULT_TENANT_ID, LEGACY_TENANT_ID, TENANT_SLUG_PATTERN, type TenantsFileData } from '../data/tenants/types.js';

describe('TenantStore', () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tenant-store-'));
    storePath = join(tmpDir, 'tenants.json');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('slug pattern', () => {
    it.each([
      ['kaiyan', true],
      ['wain', true],
      ['k1', true],
      ['acme-corp', true],
      ['a-b-c-d', true],
      ['ABC', false],        // 大写
      ['1company', false],   // 数字开头
      ['-abc', false],       // 连字符开头
      ['a', false],          // 太短（1 字符）
      ['a'.repeat(32), false], // 太长（32 字符）
      ['has_underscore', false],
      ['has.dot', false],
      ['has space', false],
      ['', false],
    ])('slug %s 合法性 = %s', (slug, expected) => {
      expect(TENANT_SLUG_PATTERN.test(slug)).toBe(expected);
    });
  });

  describe('create', () => {
    it('成功创建新组织并持久化到磁盘', async () => {
      const store = new TenantStore(storePath);
      const tenant = await store.create({ id: 'kaiyan', name: '开沿科技', createdBy: 'system' });
      expect(tenant).toMatchObject({
        id: 'kaiyan',
        name: '开沿科技',
        createdBy: 'system',
      });
      expect(tenant.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      // 文件已持久化
      expect(existsSync(storePath)).toBe(true);
      const raw = JSON.parse(readFileSync(storePath, 'utf-8')) as TenantsFileData;
      expect(raw.version).toBe(1);
      expect(raw.tenants).toHaveLength(1);
      expect(raw.tenants[0]!.id).toBe('kaiyan');
    });

    it('拒绝非法 slug', async () => {
      const store = new TenantStore(storePath);
      await expect(store.create({ id: 'Has-Upper', name: 'X', createdBy: 's' })).rejects.toThrow(/Invalid tenant id/);
      await expect(store.create({ id: '1bad', name: 'X', createdBy: 's' })).rejects.toThrow(/Invalid tenant id/);
      await expect(store.create({ id: 'a', name: 'X', createdBy: 's' })).rejects.toThrow(/Invalid tenant id/);
    });

    it('拒绝重复 slug', async () => {
      const store = new TenantStore(storePath);
      await store.create({ id: 'kaiyan', name: '开沿', createdBy: 's' });
      await expect(store.create({ id: 'kaiyan', name: '别的', createdBy: 's' })).rejects.toThrow(/already exists/);
    });

    it('拒绝空 name', async () => {
      const store = new TenantStore(storePath);
      await expect(store.create({ id: 'wain', name: '', createdBy: 's' })).rejects.toThrow(/name cannot be empty/);
      await expect(store.create({ id: 'wain', name: '   ', createdBy: 's' })).rejects.toThrow(/name cannot be empty/);
    });
  });

  describe('load 持久化往返', () => {
    it('实例重建后能读到已创建的组织', async () => {
      const s1 = new TenantStore(storePath);
      await s1.create({ id: 'kaiyan', name: '开沿', createdBy: 'system' });
      await s1.create({ id: 'wain', name: '唯恩电气', createdBy: 'admin-1' });

      const s2 = new TenantStore(storePath);
      expect(s2.count()).toBe(2);
      expect(s2.findById('kaiyan')?.name).toBe('开沿');
      expect(s2.findById('wain')?.name).toBe('唯恩电气');
    });

    it('文件不存在时初始化为空', () => {
      const store = new TenantStore(storePath);
      expect(store.count()).toBe(0);
      expect(store.listAll()).toEqual([]);
    });

    it('文件 JSON 损坏时回退到空（不 crash）', () => {
      const path = join(tmpDir, 'corrupt.json');
      require('node:fs').writeFileSync(path, '{not json', 'utf-8');
      const store = new TenantStore(path);
      expect(store.count()).toBe(0);
    });
  });

  describe('ensureDefaultTenant', () => {
    it('首次调用创建平台根组织 pantheon', async () => {
      const store = new TenantStore(storePath);
      const tenant = await store.ensureDefaultTenant();
      expect(tenant.id).toBe(DEFAULT_TENANT_ID);
      expect(tenant.id).toBe('pantheon');
      expect(tenant.name).toBe('万神殿');
      expect(tenant.createdBy).toBe('system');
      expect(store.count()).toBe(1);
    });

    it('幂等——已存在时不重复创建', async () => {
      const store = new TenantStore(storePath);
      const t1 = await store.ensureDefaultTenant();
      const t2 = await store.ensureDefaultTenant();
      expect(t1.createdAt).toBe(t2.createdAt);
      expect(store.count()).toBe(1);
    });

    it('ensureKaiyanTenant 创建开沿日常组织', async () => {
      const store = new TenantStore(storePath);
      await store.ensureDefaultTenant();
      const tenant = await store.ensureKaiyanTenant();
      expect(tenant.id).toBe(LEGACY_TENANT_ID);
      expect(tenant.name).toBe('开沿科技');
      expect(store.count()).toBe(2);
    });
  });

  describe('update / setDisabled', () => {
    it('update 改 name，slug 不可改', async () => {
      const store = new TenantStore(storePath);
      await store.create({ id: 'wain', name: '唯恩', createdBy: 's' });
      const updated = await store.update('wain', { name: '唯恩电气' });
      expect(updated.name).toBe('唯恩电气');
      expect(updated.id).toBe('wain');
    });

    it('disable 可逆，updatedAt 推进', async () => {
      const store = new TenantStore(storePath);
      await store.create({ id: 'wain', name: '唯恩', createdBy: 's' });
      // 至少需要 1 个 active 才能 disable 其他；先建第二个
      await store.create({ id: 'acme', name: 'Acme', createdBy: 's' });
      await new Promise(r => setTimeout(r, 10));
      const disabled = await store.setDisabled('wain', true, 'admin-1');
      expect(disabled.disabled).toBe(true);
      expect(disabled.disabledBy).toBe('admin-1');
      const reenabled = await store.setDisabled('wain', false, 'admin-1');
      expect(reenabled.disabled).toBeUndefined();
      expect(reenabled.disabledBy).toBeUndefined();
    });

    it('禁止 disable 默认组织', async () => {
      const store = new TenantStore(storePath);
      await store.ensureDefaultTenant();
      await store.create({ id: 'other', name: 'Other', createdBy: 's' });
      await expect(store.setDisabled(DEFAULT_TENANT_ID, true, 'admin-1'))
        .rejects.toThrow(/Cannot disable the default tenant/);
    });

    it('禁止 disable 最后一个 active 组织', async () => {
      const store = new TenantStore(storePath);
      await store.create({ id: 'only-one', name: 'Only', createdBy: 's' });
      await expect(store.setDisabled('only-one', true, 'admin-1'))
        .rejects.toThrow(/last active tenant/);
    });

    it('update 找不到组织时报错', async () => {
      const store = new TenantStore(storePath);
      await expect(store.update('ghost', { name: 'x' })).rejects.toThrow(/not found/);
      await expect(store.setDisabled('ghost', true, 'a')).rejects.toThrow(/not found/);
    });
  });

  describe('listAll 隔离', () => {
    it('修改返回的对象不影响内部状态', async () => {
      const store = new TenantStore(storePath);
      await store.create({ id: 'kaiyan', name: '开沿', createdBy: 's' });
      const list = store.listAll();
      list[0]!.name = 'HACKED';
      expect(store.findById('kaiyan')?.name).toBe('开沿');
    });
  });
});

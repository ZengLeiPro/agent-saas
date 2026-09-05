import { describe, expect, it } from 'vitest';
import { InMemorySkillPresentationStore, SkillPresentationConflictError } from './index.js';

const platformKey = {
  resourceScope: 'platform' as const,
  resourceTenantId: '',
  skillId: 'weekly-report',
  audienceTenantId: '',
  locale: 'zh-CN',
};

describe('InMemorySkillPresentationStore', () => {
  it('按平台默认和组织覆盖解析有效展示信息', async () => {
    const store = new InMemorySkillPresentationStore();
    await store.upsert({
      ...platformKey,
      displayName: '周报助手',
      summary: '平台默认说明',
      expectedRevision: 0,
      updatedBy: 'platform-admin',
    });
    await store.upsert({
      ...platformKey,
      audienceTenantId: 'tenant-a',
      displayName: '甲组织周报',
      summary: '组织覆盖说明',
      expectedRevision: 0,
      updatedBy: 'tenant-admin',
    });

    expect(
      (await store.listEffectivePlatform(['weekly-report'])).get('weekly-report')?.displayName,
    ).toBe('周报助手');
    expect(
      (await store.listEffectivePlatform(['weekly-report'], 'tenant-a')).get('weekly-report')
        ?.displayName,
    ).toBe('甲组织周报');
    expect(
      (await store.listEffectivePlatform(['weekly-report'], 'tenant-b')).get('weekly-report')
        ?.displayName,
    ).toBe('周报助手');
  });

  it('更新和删除均校验修订号', async () => {
    const store = new InMemorySkillPresentationStore();
    const created = await store.upsert({
      ...platformKey,
      displayName: '周报助手',
      summary: '平台默认说明',
      expectedRevision: 0,
      updatedBy: 'platform-admin',
    });
    await expect(
      store.upsert({
        ...platformKey,
        displayName: '旧页面提交',
        summary: '不应写入',
        expectedRevision: 0,
        updatedBy: 'other-admin',
      }),
    ).rejects.toBeInstanceOf(SkillPresentationConflictError);
    await expect(store.delete(platformKey, created.revision + 1)).rejects.toBeInstanceOf(
      SkillPresentationConflictError,
    );
    await store.delete(platformKey, created.revision);
    expect(await store.getExact(platformKey)).toBeNull();
  });
});

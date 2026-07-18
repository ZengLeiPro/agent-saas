import { beforeEach, describe, expect, it, vi } from 'vitest';

// 只 mock 网络边界 authFetch；被测的所有 skillsApi 函数都是真实实现。
vi.mock('./authFetch', () => ({
  authFetch: vi.fn(),
}));

import { authFetch } from './authFetch';
import {
  fetchMySkills,
  updateMySelections,
  deleteMySkill,
  fetchUserSkills,
  updateUserSelections,
  fetchSkillPool,
  updatePoolVisibility,
  updatePoolSkillSettings,
  fetchTenantSkillPool,
  updateTenantSkillSelections,
  updateTenantSkillSettings,
  fetchCustomSkills,
  promoteSkill,
  fetchCustomSkillDocument,
  updateCustomSkillDocument,
  deleteCustomSkill,
  syncSkills,
  importMySkill,
  importPoolSkill,
  importTenantSkill,
  fetchTenantOwnSkills,
  updateTenantOwnSkillSettings,
  fetchTenantOwnSkillDocument,
  updateTenantOwnSkillDocument,
  deleteTenantOwnSkill,
  promoteSkillToTenant,
  promoteTenantSkillToPool,
} from './skillsApi';

const mockAuthFetch = vi.mocked(authFetch);

// 构造成功响应：res.ok=true + json 返回给定 body
function ok(jsonBody: unknown = {}): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(jsonBody),
  } as unknown as Response;
}

// 构造失败响应：res.ok=false + 可选 json body（用于 error 字段提取）
function fail(status: number, jsonBody?: unknown): Response {
  return {
    ok: false,
    status,
    json:
      jsonBody === undefined
        ? vi.fn().mockRejectedValue(new Error('no body'))
        : vi.fn().mockResolvedValue(jsonBody),
  } as unknown as Response;
}

// 断言最近一次 authFetch 调用的 URL、method、body
function lastCall() {
  const [url, init] = mockAuthFetch.mock.calls[mockAuthFetch.mock.calls.length - 1];
  return { url, init: (init ?? {}) as RequestInit };
}

describe('skillsApi', () => {
  beforeEach(() => {
    mockAuthFetch.mockReset();
  });

  // ── 用户自助 ──────────────────────────────────────────────

  describe('fetchMySkills', () => {
    it('GET /api/skills/me 并返回解析后的 body', async () => {
      const body = { skills: [], selectedSkills: [] };
      mockAuthFetch.mockResolvedValue(ok(body));

      await expect(fetchMySkills()).resolves.toEqual(body);
      expect(lastCall().url).toBe('/api/skills/me');
    });

    it('非 2xx 抛错', async () => {
      mockAuthFetch.mockResolvedValue(fail(500));
      await expect(fetchMySkills()).rejects.toThrow('获取我的技能失败：500');
    });
  });

  describe('updateMySelections', () => {
    it('PUT 并把 selectedSkills 拼进 body', async () => {
      mockAuthFetch.mockResolvedValue(ok());
      await updateMySelections(['a', 'b']);

      const { url, init } = lastCall();
      expect(url).toBe('/api/skills/me/selections');
      expect(init.method).toBe('PUT');
      expect(init.body).toBe(JSON.stringify({ selectedSkills: ['a', 'b'] }));
    });

    it('非 2xx 抛错', async () => {
      mockAuthFetch.mockResolvedValue(fail(400));
      await expect(updateMySelections([])).rejects.toThrow('更新技能选择失败：400');
    });
  });

  describe('deleteMySkill', () => {
    it('DELETE 且 skillId 被 encode 进路径', async () => {
      mockAuthFetch.mockResolvedValue(ok());
      await deleteMySkill('skill/1');

      const { url, init } = lastCall();
      expect(url).toBe('/api/skills/me/skills/skill%2F1');
      expect(init.method).toBe('DELETE');
    });

    it('失败时优先抛出 body.error', async () => {
      mockAuthFetch.mockResolvedValue(fail(403, { error: '无权删除' }));
      await expect(deleteMySkill('s1')).rejects.toThrow('无权删除');
    });

    it('失败但 body 解析失败时抛默认信息', async () => {
      mockAuthFetch.mockResolvedValue(fail(500));
      await expect(deleteMySkill('s1')).rejects.toThrow('删除自定义技能失败：500');
    });
  });

  describe('fetchUserSkills', () => {
    it('GET /api/skills/users/:username（encode）', async () => {
      const body = { skills: [] };
      mockAuthFetch.mockResolvedValue(ok(body));

      await expect(fetchUserSkills('bob smith')).resolves.toEqual(body);
      expect(lastCall().url).toBe('/api/skills/users/bob%20smith');
    });

    it('非 2xx 抛错', async () => {
      mockAuthFetch.mockResolvedValue(fail(404));
      await expect(fetchUserSkills('x')).rejects.toThrow('获取用户技能失败：404');
    });
  });

  describe('updateUserSelections', () => {
    it('PUT 到 :username/selections，body 带 selectedSkills', async () => {
      mockAuthFetch.mockResolvedValue(ok());
      await updateUserSelections('alice', ['s1']);

      const { url, init } = lastCall();
      expect(url).toBe('/api/skills/users/alice/selections');
      expect(init.method).toBe('PUT');
      expect(init.body).toBe(JSON.stringify({ selectedSkills: ['s1'] }));
    });

    it('非 2xx 抛错', async () => {
      mockAuthFetch.mockResolvedValue(fail(400));
      await expect(updateUserSelections('a', [])).rejects.toThrow('更新用户技能选择失败：400');
    });
  });

  // ── Admin 管理 ────────────────────────────────────────────

  describe('fetchSkillPool', () => {
    it('GET /api/skills/pool', async () => {
      const body = { skills: [] };
      mockAuthFetch.mockResolvedValue(ok(body));
      await expect(fetchSkillPool()).resolves.toEqual(body);
      expect(lastCall().url).toBe('/api/skills/pool');
    });

    it('非 2xx 抛错', async () => {
      mockAuthFetch.mockResolvedValue(fail(403));
      await expect(fetchSkillPool()).rejects.toThrow('获取技能池失败：403');
    });
  });

  describe('updatePoolVisibility', () => {
    it('PATCH /api/skills/pool/visibility，body 为 visibility map', async () => {
      mockAuthFetch.mockResolvedValue(ok());
      await updatePoolVisibility({ s1: true });

      const { url, init } = lastCall();
      expect(url).toBe('/api/skills/pool/visibility');
      expect(init.method).toBe('PATCH');
      expect(init.body).toBe(JSON.stringify({ s1: true }));
    });

    it('非 2xx 抛错', async () => {
      mockAuthFetch.mockResolvedValue(fail(400));
      await expect(updatePoolVisibility({})).rejects.toThrow('更新技能池可见范围失败：400');
    });
  });

  describe('updatePoolSkillSettings', () => {
    it('PATCH /api/skills/pool/settings', async () => {
      mockAuthFetch.mockResolvedValue(ok());
      await updatePoolSkillSettings({ s1: {} as never });
      expect(lastCall().url).toBe('/api/skills/pool/settings');
      expect(lastCall().init.method).toBe('PATCH');
    });

    it('非 2xx 抛错', async () => {
      mockAuthFetch.mockResolvedValue(fail(500));
      await expect(updatePoolSkillSettings({})).rejects.toThrow('更新技能池设置失败：500');
    });
  });

  describe('fetchTenantSkillPool', () => {
    it('GET tenants/:tenantId/pool（encode）', async () => {
      const body = { skills: [] };
      mockAuthFetch.mockResolvedValue(ok(body));
      await expect(fetchTenantSkillPool('t/1')).resolves.toEqual(body);
      expect(lastCall().url).toBe('/api/skills/tenants/t%2F1/pool');
    });

    it('非 2xx 抛错', async () => {
      mockAuthFetch.mockResolvedValue(fail(404));
      await expect(fetchTenantSkillPool('t1')).rejects.toThrow('获取组织技能池失败：404');
    });
  });

  describe('updateTenantSkillSelections', () => {
    it('PUT pool/selections，body 带 enabledSkills', async () => {
      mockAuthFetch.mockResolvedValue(ok());
      await updateTenantSkillSelections('t1', ['s1', 's2']);

      const { url, init } = lastCall();
      expect(url).toBe('/api/skills/tenants/t1/pool/selections');
      expect(init.method).toBe('PUT');
      expect(init.body).toBe(JSON.stringify({ enabledSkills: ['s1', 's2'] }));
    });

    it('非 2xx 抛错', async () => {
      mockAuthFetch.mockResolvedValue(fail(400));
      await expect(updateTenantSkillSelections('t1', [])).rejects.toThrow('更新组织技能选择失败：400');
    });
  });

  describe('updateTenantSkillSettings', () => {
    it('PUT pool/settings', async () => {
      mockAuthFetch.mockResolvedValue(ok());
      await updateTenantSkillSettings('t1', {});
      expect(lastCall().url).toBe('/api/skills/tenants/t1/pool/settings');
      expect(lastCall().init.method).toBe('PUT');
    });

    it('非 2xx 抛错', async () => {
      mockAuthFetch.mockResolvedValue(fail(500));
      await expect(updateTenantSkillSettings('t1', {})).rejects.toThrow('更新组织技能设置失败：500');
    });
  });

  describe('fetchCustomSkills', () => {
    it('GET /api/skills/custom', async () => {
      const body = { skills: [] };
      mockAuthFetch.mockResolvedValue(ok(body));
      await expect(fetchCustomSkills()).resolves.toEqual(body);
      expect(lastCall().url).toBe('/api/skills/custom');
    });

    it('非 2xx 抛错', async () => {
      mockAuthFetch.mockResolvedValue(fail(403));
      await expect(fetchCustomSkills()).rejects.toThrow('获取自定义技能失败：403');
    });
  });

  describe('promoteSkill', () => {
    it('POST custom/:skillId/promote，body 带 sourceUser', async () => {
      mockAuthFetch.mockResolvedValue(ok());
      await promoteSkill('sk 1', 'alice');

      const { url, init } = lastCall();
      expect(url).toBe('/api/skills/custom/sk%201/promote');
      expect(init.method).toBe('POST');
      expect(init.body).toBe(JSON.stringify({ sourceUser: 'alice' }));
    });

    it('非 2xx 抛错', async () => {
      mockAuthFetch.mockResolvedValue(fail(500));
      await expect(promoteSkill('s1', 'u')).rejects.toThrow('发布技能失败：500');
    });
  });

  describe('fetchCustomSkillDocument', () => {
    it('GET custom/:username/:skillId/document（双 encode）', async () => {
      const body = { content: 'doc' };
      mockAuthFetch.mockResolvedValue(ok(body));
      await expect(fetchCustomSkillDocument('u/1', 's/2')).resolves.toEqual(body);
      expect(lastCall().url).toBe('/api/skills/custom/u%2F1/s%2F2/document');
    });

    it('非 2xx 抛错', async () => {
      mockAuthFetch.mockResolvedValue(fail(404));
      await expect(fetchCustomSkillDocument('u', 's')).rejects.toThrow('获取自定义技能文档失败：404');
    });
  });

  describe('updateCustomSkillDocument', () => {
    it('PUT document，body 带 content', async () => {
      mockAuthFetch.mockResolvedValue(ok());
      await updateCustomSkillDocument('u', 's', 'hi');

      const { url, init } = lastCall();
      expect(url).toBe('/api/skills/custom/u/s/document');
      expect(init.method).toBe('PUT');
      expect(init.body).toBe(JSON.stringify({ content: 'hi' }));
    });

    it('失败时优先抛 body.error', async () => {
      mockAuthFetch.mockResolvedValue(fail(400, { error: '内容非法' }));
      await expect(updateCustomSkillDocument('u', 's', 'x')).rejects.toThrow('内容非法');
    });
  });

  describe('deleteCustomSkill', () => {
    it('DELETE custom/:username/:skillId', async () => {
      mockAuthFetch.mockResolvedValue(ok());
      await deleteCustomSkill('u', 's');
      expect(lastCall().url).toBe('/api/skills/custom/u/s');
      expect(lastCall().init.method).toBe('DELETE');
    });

    it('非 2xx 抛错', async () => {
      mockAuthFetch.mockResolvedValue(fail(500));
      await expect(deleteCustomSkill('u', 's')).rejects.toThrow('删除自定义技能失败：500');
    });
  });

  describe('syncSkills', () => {
    it('无 username 时 POST /api/skills/sync', async () => {
      mockAuthFetch.mockResolvedValue(ok());
      await syncSkills();
      expect(lastCall().url).toBe('/api/skills/sync');
      expect(lastCall().init.method).toBe('POST');
    });

    it('带 username 时拼 query（encode）', async () => {
      mockAuthFetch.mockResolvedValue(ok());
      await syncSkills('bob smith');
      expect(lastCall().url).toBe('/api/skills/sync?username=bob%20smith');
    });

    it('非 2xx 抛错', async () => {
      mockAuthFetch.mockResolvedValue(fail(500));
      await expect(syncSkills()).rejects.toThrow('同步技能失败：500');
    });
  });

  // ── 导入（FormData） ─────────────────────────────────────

  describe('import*Skill', () => {
    function makeFile(name: string): File {
      return new File(['x'], name, { type: 'text/plain' });
    }

    it('importMySkill POST 到 me/import 且 body 为 FormData', async () => {
      const body = { imported: 1 };
      mockAuthFetch.mockResolvedValue(ok(body));
      await expect(importMySkill([makeFile('a.md')])).resolves.toEqual(body);

      const { url, init } = lastCall();
      expect(url).toBe('/api/skills/me/import');
      expect(init.method).toBe('POST');
      expect(init.body).toBeInstanceOf(FormData);
    });

    it('importPoolSkill POST 到 pool/import', async () => {
      mockAuthFetch.mockResolvedValue(ok({}));
      await importPoolSkill([makeFile('a.md')]);
      expect(lastCall().url).toBe('/api/skills/pool/import');
    });

    it('importTenantSkill POST 到 tenants/:id/import（encode）', async () => {
      mockAuthFetch.mockResolvedValue(ok({}));
      await importTenantSkill('t/1', [makeFile('a.md')]);
      expect(lastCall().url).toBe('/api/skills/tenants/t%2F1/import');
    });

    it('导入失败时优先抛 body.error', async () => {
      mockAuthFetch.mockResolvedValue(fail(400, { error: '文件太大' }));
      await expect(importMySkill([makeFile('a.md')])).rejects.toThrow('文件太大');
    });
  });

  // ── 组织自有 skill 管理 ──────────────────────────────────

  describe('fetchTenantOwnSkills', () => {
    it('GET tenants/:id/skills', async () => {
      const body = { skills: [] };
      mockAuthFetch.mockResolvedValue(ok(body));
      await expect(fetchTenantOwnSkills('t1')).resolves.toEqual(body);
      expect(lastCall().url).toBe('/api/skills/tenants/t1/skills');
    });

    it('非 2xx 抛错', async () => {
      mockAuthFetch.mockResolvedValue(fail(404));
      await expect(fetchTenantOwnSkills('t1')).rejects.toThrow('获取组织自有技能失败：404');
    });
  });

  describe('updateTenantOwnSkillSettings', () => {
    it('PUT skills/settings', async () => {
      mockAuthFetch.mockResolvedValue(ok());
      await updateTenantOwnSkillSettings('t1', {});
      expect(lastCall().url).toBe('/api/skills/tenants/t1/skills/settings');
      expect(lastCall().init.method).toBe('PUT');
    });

    it('非 2xx 抛错', async () => {
      mockAuthFetch.mockResolvedValue(fail(500));
      await expect(updateTenantOwnSkillSettings('t1', {})).rejects.toThrow('更新组织自有技能设置失败：500');
    });
  });

  describe('fetchTenantOwnSkillDocument', () => {
    it('GET skills/:skillId/document', async () => {
      const body = { content: 'doc' };
      mockAuthFetch.mockResolvedValue(ok(body));
      await expect(fetchTenantOwnSkillDocument('t1', 's/2')).resolves.toEqual(body);
      expect(lastCall().url).toBe('/api/skills/tenants/t1/skills/s%2F2/document');
    });

    it('非 2xx 抛错', async () => {
      mockAuthFetch.mockResolvedValue(fail(404));
      await expect(fetchTenantOwnSkillDocument('t1', 's')).rejects.toThrow('获取组织技能文档失败：404');
    });
  });

  describe('updateTenantOwnSkillDocument', () => {
    it('PUT document，body 带 content', async () => {
      mockAuthFetch.mockResolvedValue(ok());
      await updateTenantOwnSkillDocument('t1', 's', 'body');

      const { url, init } = lastCall();
      expect(url).toBe('/api/skills/tenants/t1/skills/s/document');
      expect(init.method).toBe('PUT');
      expect(init.body).toBe(JSON.stringify({ content: 'body' }));
    });

    it('失败时优先抛 body.error', async () => {
      mockAuthFetch.mockResolvedValue(fail(400, { error: '文档冲突' }));
      await expect(updateTenantOwnSkillDocument('t1', 's', 'x')).rejects.toThrow('文档冲突');
    });
  });

  describe('deleteTenantOwnSkill', () => {
    it('DELETE skills/:skillId', async () => {
      mockAuthFetch.mockResolvedValue(ok());
      await deleteTenantOwnSkill('t1', 's');
      expect(lastCall().url).toBe('/api/skills/tenants/t1/skills/s');
      expect(lastCall().init.method).toBe('DELETE');
    });

    it('非 2xx 抛错', async () => {
      mockAuthFetch.mockResolvedValue(fail(500));
      await expect(deleteTenantOwnSkill('t1', 's')).rejects.toThrow('删除组织技能失败：500');
    });
  });

  describe('promoteSkillToTenant', () => {
    it('POST tenants/:id/promote，body 带 skillId+sourceUser', async () => {
      mockAuthFetch.mockResolvedValue(ok());
      await promoteSkillToTenant('t1', 's1', 'alice');

      const { url, init } = lastCall();
      expect(url).toBe('/api/skills/tenants/t1/promote');
      expect(init.method).toBe('POST');
      expect(init.body).toBe(JSON.stringify({ skillId: 's1', sourceUser: 'alice' }));
    });

    it('失败时优先抛 body.error', async () => {
      mockAuthFetch.mockResolvedValue(fail(403, { error: '无权发布' }));
      await expect(promoteSkillToTenant('t1', 's', 'u')).rejects.toThrow('无权发布');
    });
  });

  describe('promoteTenantSkillToPool', () => {
    it('POST skills/:skillId/promote', async () => {
      mockAuthFetch.mockResolvedValue(ok());
      await promoteTenantSkillToPool('t1', 's/2');

      const { url, init } = lastCall();
      expect(url).toBe('/api/skills/tenants/t1/skills/s%2F2/promote');
      expect(init.method).toBe('POST');
    });

    it('失败但 body 解析失败时抛默认信息', async () => {
      mockAuthFetch.mockResolvedValue(fail(500));
      await expect(promoteTenantSkillToPool('t1', 's')).rejects.toThrow('发布组织技能到技能池失败：500');
    });
  });
});

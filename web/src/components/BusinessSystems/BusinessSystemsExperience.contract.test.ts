import { describe, expect, it } from 'vitest';
import platformSource from './PlatformSystemsPage.tsx?raw';
import organizationSource from './OrganizationSystemsPage.tsx?raw';
import installationSource from './InstallationDetail.tsx?raw';
import settingsSource from './SystemConnectionSettings.tsx?raw';

describe('业务系统配置体验契约', () => {
  it('平台详情只保留系统配置和组织接入两个一级页签', () => {
    expect(platformSource.match(/<TabsTrigger\b/g)).toHaveLength(2);
    expect(platformSource).toContain('系统配置');
    expect(platformSource).toContain('组织接入');
  });

  it('组织实例只保留接入概览和访问授权两个一级页签', () => {
    expect(installationSource.match(/<TabsTrigger\b/g)).toHaveLength(2);
    expect(installationSource).toContain('接入概览');
    expect(installationSource).toContain('访问授权');
    expect(installationSource).not.toContain('KyAppTenantUsagePanel');
    expect(installationSource).not.toContain('预计可用天数');
  });

  it('组织列表使用搜索和状态筛选，不再使用四个并列页签', () => {
    expect(organizationSource).toContain('搜索业务系统');
    expect(organizationSource).toContain('状态筛选');
    expect(organizationSource).not.toContain('role="tablist"');
  });

  it('组织列表把搜索、状态和游标交给服务端，不静默截断前 100 条', () => {
    expect(organizationSource).toContain("limit: '50'");
    expect(organizationSource).toContain('{ businessStatus: filter }');
    expect(organizationSource).toContain('{ query: appliedQuery }');
    expect(organizationSource).toContain('{ cursor }');
    expect(organizationSource).toContain('resource.data.nextCursor');
    expect(organizationSource).not.toContain("limit: '100'");
  });

  it('诊断参数由能力 Schema 生成字段，不要求管理员手写 JSON', () => {
    expect(settingsSource).toContain('DiagnosticInputFields');
    expect(settingsSource).not.toContain('诊断参数（JSON）');
  });
});

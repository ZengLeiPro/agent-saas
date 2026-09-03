import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => readFile(path.join(root, relativePath), 'utf8');

const [desktop, mobile, shell, workspace, registry, organizationContent] = await Promise.all([
  read('src/layouts/DesktopLayout.tsx'),
  read('src/layouts/MobileLayout.tsx'),
  read('src/components/ManagementShell/ManagementShell.tsx'),
  read('src/components/ManagementShell/ManagementWorkspaceContent.tsx'),
  read('src/lib/managementNavigation.ts'),
  read('src/components/OrganizationManagement/OrganizationManagementContent.tsx'),
]);

for (const [name, source] of [
  ['DesktopLayout', desktop],
  ['MobileLayout', mobile],
]) {
  for (const forbidden of [
    '<UserManager',
    '<TenantAdminShell',
    '<PlatformAdminShell',
    '<GovernanceConsole',
  ]) {
    assert.equal(source.includes(forbidden), false, `${name} 不得再直接挂载 ${forbidden.slice(1)}`);
  }
  assert.equal(
    (source.match(/<ManagementWorkspaceContent\b/g) ?? []).length,
    1,
    `${name} 只能挂载一个统一管理工作区`,
  );
}

assert.equal(
  (shell.match(/overflow-y-auto/g) ?? []).length,
  1,
  'ManagementShell 只能有一个纵向滚动容器',
);
assert.equal(workspace.includes('<UserManager'), false, '统一管理工作区不得复活旧 UserManager');
assert.equal(
  organizationContent.includes('OrganizationManagementLocalNav'),
  false,
  '统一管理工作区不得复活旧局部侧栏',
);

for (const placeholder of ['敬请期待', '尚未接入', '能力未开放', '不会展示模拟数据']) {
  assert.equal(
    registry.includes(placeholder),
    false,
    `已注册管理页不得包含占位文案：${placeholder}`,
  );
}

assert.equal(
  (registry.match(/surface:\s*'config',\s*area:\s*'organization'/g) ?? []).length,
  17,
  '组织配置页必须是 17 项',
);
assert.equal(
  (registry.match(/surface:\s*'config',\s*area:\s*'platform'/g) ?? []).length,
  12,
  '平台配置页必须是 12 项',
);
assert.equal(
  (registry.match(/surface:\s*'analytics',\s*area:\s*'organization'/g) ?? []).length,
  4,
  '组织分析页必须是 4 项',
);
assert.equal(
  (registry.match(/surface:\s*'analytics',\s*area:\s*'platform'/g) ?? []).length,
  8,
  '平台分析页必须是 8 项',
);

console.log('管理后台契约检查通过：单壳、单滚动、无旧成员入口、41 个真实管理页面。');

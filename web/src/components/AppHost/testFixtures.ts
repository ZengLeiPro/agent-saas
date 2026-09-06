/**
 * AppHost 测试共用夹具。放在生产目录而不是 `src/test/`，是为了跟被测代码同进同出：
 * `MySystemInstallation` 加字段时这里第一时间报错。
 */
import type { MySystemInstallation } from '@/lib/systemsApi';

export function installationFixture(
  overrides: Partial<MySystemInstallation> = {},
): MySystemInstallation {
  return {
    installationId: 'inst-1',
    systemId: 'crm',
    name: '客户管理',
    icon: '📦',
    origin: 'https://crm.example.com',
    state: 'enabled',
    externalLinkHosts: [],
    ...overrides,
  };
}

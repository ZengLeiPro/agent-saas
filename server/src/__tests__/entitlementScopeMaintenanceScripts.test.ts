import { describe, expect, it } from 'vitest';

import { parseAuditArgs } from '../../scripts/audit-entitlement-resource-scopes.mjs';
import { parseRepairArgs } from '../../scripts/repair-entitlement-resource-scopes.mjs';

describe('Entitlement 范围生产审计与修复脚本', () => {
  it('审计脚本只有只读参数，不接受 apply', () => {
    expect(parseAuditArgs(['--tenant=tenant-a', '--table-prefix=governance'])).toMatchObject({
      tenantId: 'tenant-a',
      tablePrefix: 'governance',
    });
    expect(() => parseAuditArgs(['--apply'])).toThrow('未知参数');
  });

  it('修复脚本默认 dry-run，实际清理必须绑定组织、版本、原因和目录快照', () => {
    expect(
      parseRepairArgs([
        '--tenant=tenant-a',
        '--reason=清理已退出目录资源',
        '--remove-stale-id=model:ark-agents/glm-5.2',
        '--catalog-file=/tmp/catalog.json',
      ]),
    ).toMatchObject({
      apply: false,
      tenantId: 'tenant-a',
      remove: { resourceType: 'model', resourceId: 'ark-agents/glm-5.2' },
    });
    expect(() =>
      parseRepairArgs([
        '--apply',
        '--tenant=tenant-a',
        '--reason=清理旧资源',
        '--remove-stale-id=model:ark-agents/glm-5.2',
        '--catalog-file=/tmp/catalog.json',
      ]),
    ).toThrow('--confirm-tenant');
    expect(() =>
      parseRepairArgs([
        '--apply',
        '--tenant=tenant-a',
        '--confirm-tenant=tenant-a',
        '--reason=清理旧资源',
        '--remove-stale-id=model:ark-agents/glm-5.2',
        '--catalog-file=/tmp/catalog.json',
      ]),
    ).toThrow('--expected-version');
  });

  it('基线补齐必须显式限定单个组织，不能无边界全量执行', () => {
    expect(() => parseRepairArgs(['--fill-missing', '--reason=补齐范围'])).toThrow('--tenant');
    expect(
      parseRepairArgs(['--fill-missing', '--tenant=tenant-a', '--reason=补齐缺失的六类范围']),
    ).toMatchObject({ apply: false, fillMissing: true, tenantId: 'tenant-a' });
  });
});

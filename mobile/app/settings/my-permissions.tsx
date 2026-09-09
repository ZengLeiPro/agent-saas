/**
 * 我的权限（`settings/my-permissions`）—— 对齐 Web `MyPermissionsSection`
 * 的信息结构：只展示当前账号已经可使用的业务能力。
 *
 * 契约（服务端权威，客户端不本地推导、不失败降级放行）：
 *   GET   /api/governance/effective-resources（shared `fetchEffectiveResources`）
 * 普通用户页面不展示内部资源 ID、判定因素、访问原因、执行就绪或原始错误；
 * 详细诊断能力保留在管理员治理入口。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchEffectiveResources } from '@agent/shared/lib/governanceApi';
import type { EffectiveResourceView } from '@agent/shared/types/governance';
import { ListRow } from '../../src/components/ui/ListRow';
import { SettingsGroup, SettingsScrollView } from '../../src/components/settings/SettingsSections';
import { groupEffectiveResources } from '../../src/lib/settings/effectiveResourceGroups';

export default function MyPermissionsScreen() {
  const [resources, setResources] = useState<EffectiveResourceView[]>([]);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      setResources(await fetchEffectiveResources());
    } catch {
      setResources([]);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const groups = useMemo(() => groupEffectiveResources(resources), [resources]);

  return (
    <SettingsScrollView
      testID="my-permissions-screen"
      accessibilityLabel="我的权限"
      refreshing={loading}
      onRefresh={() => { void load(); }}
    >
      {failed ? (
        <SettingsGroup title="我的权限" footnote="下拉页面可重新加载。">
          <ListRow title="暂时无法加载我的权限" />
        </SettingsGroup>
      ) : groups.length ? (
        groups.map((group) => (
          <SettingsGroup key={group.domain} title={group.label}>
            {group.rows.map((row) => (
              <ListRow
                key={row.key}
                title={row.displayName}
                value="可使用"
              />
            ))}
          </SettingsGroup>
        ))
      ) : (
        <SettingsGroup title="我的权限">
          <ListRow
            title={loading ? '正在加载我的权限…' : '当前没有可展示的有效权限'}
          />
        </SettingsGroup>
      )}
    </SettingsScrollView>
  );
}

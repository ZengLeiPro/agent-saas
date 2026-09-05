/**
 * 我的权限（`settings/my-permissions`）—— 对齐 Web `MyPermissionsSection`
 * 的信息结构：个人调试模式开关 + 服务端权威有效资源清单（按治理 domain 分组）。
 *
 * 契约（服务端权威，客户端不本地推导、不失败降级放行）：
 *   GET   /api/governance/effective-resources（shared `fetchEffectiveResources`）
 *   PATCH /api/auth/me/debug-mode
 *
 * 与 Web 的差异：Web 还渲染 `PermissionWhyPanel`（七层链路逐层展开），
 * 移动端本轮只把「决定因素 / 访问判定 / 执行就绪」三行放在资源行的副标题里，
 * 完整链路仍在桌面控制台看。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert } from 'react-native';
import { authFetch, isDebugModeAvailable } from '@agent/shared';
import { fetchEffectiveResources } from '@agent/shared/lib/governanceApi';
import type { EffectiveResourceView } from '@agent/shared/types/governance';
import { useAuth } from '../../src/contexts/AuthContext';
import { ListRow } from '../../src/components/ui/ListRow';
import { SettingsGroup, SettingsScrollView } from '../../src/components/settings/SettingsSections';
import { groupEffectiveResources } from '../../src/lib/settings/effectiveResourceGroups';

export default function MyPermissionsScreen() {
  const { user, refreshUser } = useAuth();
  const [resources, setResources] = useState<EffectiveResourceView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const debugModeAvailable = user
    ? isDebugModeAvailable(user.tenantId, user.tenantFeatures)
    : false;
  const [debugMode, setDebugMode] = useState(user?.debugMode === true);
  const [debugSaving, setDebugSaving] = useState(false);

  useEffect(() => {
    setDebugMode(user?.debugMode === true && debugModeAvailable);
  }, [debugModeAvailable, user?.debugMode]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setResources(await fetchEffectiveResources());
    } catch (cause) {
      setResources([]);
      setError(cause instanceof Error ? cause.message : '权威权限视图加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const saveDebugMode = useCallback(async (next: boolean) => {
    setDebugSaving(true);
    const previous = debugMode;
    setDebugMode(next);
    try {
      const response = await authFetch('/api/auth/me/debug-mode', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ debugMode: next }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        debugMode?: boolean;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error || `保存调试模式失败（HTTP ${response.status}）`);
      }
      setDebugMode(payload.debugMode === true);
      void refreshUser();
    } catch (cause) {
      setDebugMode(previous);
      Alert.alert('保存失败', cause instanceof Error ? cause.message : '请稍后重试');
    } finally {
      setDebugSaving(false);
    }
  }, [debugMode, refreshUser]);

  const groups = useMemo(() => groupEffectiveResources(resources), [resources]);
  const debugFootnote = debugModeAvailable
    ? '开启后显示思考、工具调用和技能执行细节；只影响当前账号。'
    : user?.tenantFeatures?.debugModeAllowed !== true
      ? '平台尚未授权，当前不能开启个人调试模式。'
      : '组织尚未开放，当前不能开启个人调试模式。';

  return (
    <SettingsScrollView
      testID="my-permissions-screen"
      accessibilityLabel="我的权限"
      refreshing={loading}
      onRefresh={() => { void load(); }}
    >
      <SettingsGroup title="个人调试" footnote={debugFootnote}>
        <ListRow
          title="个人调试模式"
          switchValue={debugModeAvailable && debugMode}
          switchDisabled={debugSaving || !debugModeAvailable}
          onSwitchChange={(next) => { void saveDebugMode(next); }}
        />
      </SettingsGroup>

      {error ? (
        <SettingsGroup title="有效资源" footnote="客户端不会在失败时自行推导权限，请下拉重试。">
          <ListRow title="权威权限视图不可用" subtitle={error} destructive />
        </SettingsGroup>
      ) : groups.length ? (
        groups.map((group) => (
          <SettingsGroup key={group.domain} title={group.label}>
            {group.rows.map((row) => (
              <ListRow
                key={row.key}
                title={row.displayName}
                subtitle={row.detailLines.join('\n')}
                subtitleLines={row.detailLines.length}
                value={row.resultLabel}
              />
            ))}
          </SettingsGroup>
        ))
      ) : (
        <SettingsGroup title="有效资源">
          <ListRow
            title={loading ? '正在获取权威治理结论…' : '暂无可用资源'}
            subtitle={loading ? undefined : '当前没有权威资源结果；客户端不会自行推导权限。'}
          />
        </SettingsGroup>
      )}
    </SettingsScrollView>
  );
}

/**
 * 系统推送通知设置 —— 移动端等价于 Web `BrowserNotificationSettings`（浏览器桌面通知）。
 *
 * 与 Web 同源的语义：
 * - 一个开关 + 一段状态说明 + 已绑定设备列表（标出当前设备、可逐条移除）；
 * - 「当前设备」靠本机绑定记录判定（本机只记自己注册的那条设备 id）；
 * - 开：请求系统授权 → 取设备令牌 → 注册 → 写本机绑定；关：解绑 + 清本机绑定。
 *
 * 刻意差异：本轮系统推送只在 iOS 落地，其余平台整组隐藏，不留点不动的假入口。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Linking } from 'react-native';
import { useAuth } from '../../contexts/AuthContext';
import { ListRow } from '../ui';
import { Button } from '../ui/Button';
import { SettingsGroup } from './SettingsSections';
import {
  fetchPushDeviceStatus,
  hashPushToken,
  readPushBinding,
  registerPushDevice,
  unregisterPushDevice,
  writePushBinding,
  type PushDeviceBinding,
  type PushDeviceStatus,
  type PushIdentityScope,
} from '../../lib/pushDevices';
import {
  getDevicePushToken,
  getPushPermissionState,
  isPushSupported,
  requestPushPermission,
  type PushPermissionState,
} from '../../platform/pushNotifications';

const SUBTITLE = '定时任务、后台 Agent 和等待确认时，通过系统通知提醒；只显示任务名称和状态。';

export function PushNotificationSettings() {
  const { identity } = useAuth();
  const tenantId = identity?.tenantId ?? null;
  const userId = identity?.userId ?? null;
  const scope = useMemo<PushIdentityScope | null>(
    () => (tenantId && userId ? { tenantId, userId } : null),
    [tenantId, userId],
  );

  const [status, setStatus] = useState<PushDeviceStatus | null>(null);
  const [permission, setPermission] = useState<PushPermissionState>('undetermined');
  const [binding, setBinding] = useState<PushDeviceBinding | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextStatus, nextPermission, nextBinding] = await Promise.all([
        fetchPushDeviceStatus(),
        getPushPermissionState(),
        readPushBinding(scope),
      ]);
      setStatus(nextStatus);
      setPermission(nextPermission);
      setBinding(nextBinding);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setLoading(false);
    }
  }, [scope]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const currentDevice = useMemo(
    () => (binding ? status?.devices.find((device) => device.id === binding.id) : undefined),
    [binding, status],
  );
  const enabled = permission === 'granted' && Boolean(currentDevice);
  const switchDisabled = loading || saving || !status?.configured;

  const handleToggle = useCallback(
    async (next: boolean) => {
      setSaving(true);
      setError(null);
      try {
        if (next) {
          const granted = await requestPushPermission();
          setPermission(granted);
          if (granted !== 'granted') {
            throw new Error(
              granted === 'denied'
                ? '系统通知权限已被拒绝，请在系统设置中允许通知后重试。'
                : '尚未获得系统通知权限，本机暂时收不到提醒。',
            );
          }
          const token = await getDevicePushToken();
          if (!token) throw new Error('未能取得本机通知标识，请稍后重试。');
          const device = await registerPushDevice(token);
          await writePushBinding(scope, { id: device.id, tokenHash: hashPushToken(token) });
        } else {
          if (binding) await unregisterPushDevice(binding.id);
          await writePushBinding(scope, null);
        }
        await refresh();
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      } finally {
        setSaving(false);
      }
    },
    [binding, refresh, scope],
  );

  const handleRemove = useCallback(
    async (deviceId: string) => {
      setSaving(true);
      setError(null);
      try {
        await unregisterPushDevice(deviceId);
        if (binding?.id === deviceId) await writePushBinding(scope, null);
        await refresh();
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      } finally {
        setSaving(false);
      }
    },
    [binding, refresh, scope],
  );

  // 本轮只在 iOS 落地：其余平台整组隐藏。
  if (!isPushSupported()) return null;

  const devices = status?.devices ?? [];

  return (
    <>
      <SettingsGroup
        title="系统推送通知"
        footnote={
          error ??
          (loading ? '正在检查系统通知状态…' : describePushState(status, permission, enabled))
        }
      >
        <ListRow
          testID="push-notifications-row"
          title="系统推送通知"
          subtitle={saving ? '保存中…' : SUBTITLE}
          subtitleLines={3}
          switchValue={enabled}
          switchDisabled={switchDisabled}
          onSwitchChange={(next) => {
            void handleToggle(next);
          }}
        />
        {permission === 'denied' ? (
          <ListRow
            testID="push-notifications-open-settings"
            title="去系统设置"
            subtitle="在系统设置中允许通知后，回到这里再打开开关。"
            onPress={() => {
              void Linking.openSettings();
            }}
          />
        ) : null}
      </SettingsGroup>

      {devices.length > 0 ? (
        <SettingsGroup
          title="已绑定设备"
          footnote="移除后该设备不再收到系统通知，站内提醒不受影响。"
        >
          {devices.map((device) => (
            <ListRow
              key={device.id}
              title={`${device.deviceName}${device.id === binding?.id ? '（当前设备）' : ''}`}
              subtitle={describeDeviceDetail(device.updatedAt, device.appVersion)}
              accessory={
                <Button
                  label="移除"
                  variant="link"
                  size="sm"
                  disabled={saving}
                  accessibilityLabel={`移除 ${device.deviceName}`}
                  onPress={() => {
                    void handleRemove(device.id);
                  }}
                />
              }
            />
          ))}
        </SettingsGroup>
      ) : null}
    </>
  );
}

/** 状态说明：与 Web 一样，把「为什么开不了」和「开了会怎样」说清楚。 */
function describePushState(
  status: PushDeviceStatus | null,
  permission: PushPermissionState,
  enabled: boolean,
): string {
  if (!status?.configured) {
    return '平台尚未开启系统推送，暂时不能绑定本机；站内提醒不受影响。';
  }
  if (permission === 'denied') {
    return '系统通知权限已被拒绝。请在系统设置里允许本应用发送通知，再回来打开开关。';
  }
  if (enabled) {
    return '本机已开启。应用退到后台或未打开时，提醒会进入系统通知中心；通知只显示任务名称和状态。';
  }
  return '本机未开启。打开开关后系统才会询问授权；不授权也不影响任务执行和站内结果。';
}

function describeDeviceDetail(updatedAt: string, appVersion: string | null): string {
  const timestamp = Date.parse(updatedAt);
  const time = Number.isNaN(timestamp) ? '时间未知' : new Date(timestamp).toLocaleString('zh-CN');
  return appVersion ? `最近绑定：${time} · 版本 ${appVersion}` : `最近绑定：${time}`;
}

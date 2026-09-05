/**
 * 系统推送（APNs）的原生桥接 —— 结构对齐 `useScenarioDeepLinkBridge`：
 * 冷启动 + 热态两条入口，解析交给 shared 纯函数，投递到 module 级信箱后再导航。
 *
 * 两件事：
 * 1. 令牌保活：本机已经绑定过（本地有当前身份的 binding）时，登录后与每次回到前台
 *    静默重取设备令牌并重新注册。APNs 令牌会轮换，服务端注册是按令牌幂等 upsert，
 *    重复调用安全；这里从不主动申请权限，也从不弹窗，失败只记一条 warn。
 * 2. 点击落地：通知点击（含点通知冷启动）解析出站内目标后投递信箱；已登录才消费并
 *    导航，未登录则留在信箱里等登录完成，避免把未登录用户推进会话页。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '../contexts/AuthContext';
import {
  hashPushToken,
  readPushBinding,
  registerPushDevice,
  writePushBinding,
} from '../lib/pushDevices';
import {
  consumePushNotificationTarget,
  publishPushNotificationTarget,
} from '../lib/pushNotificationInbox';
import {
  addPushResponseListener,
  configureForegroundPushPresentation,
  getDevicePushToken,
  getLastPushResponseAsync,
  getPushPermissionState,
  isPushSupported,
  type PushResponseSnapshot,
} from '../platform/pushNotifications';

export function usePushNotificationBridge(enabled: boolean): void {
  const router = useRouter();
  const { identity } = useAuth();
  const tenantId = identity?.tenantId ?? null;
  const userId = identity?.userId ?? null;
  /** 本次挂载已上报过的令牌指纹：令牌没变时不必每次回前台都重发注册。 */
  const registeredTokenHash = useRef<string | null>(null);
  /** 信箱新投递计数：已登录时用它触发一次消费。 */
  const [inboxRevision, setInboxRevision] = useState(0);

  // 前台呈现策略：进横幅与通知列表，但不响铃、不加角标。
  useEffect(() => {
    configureForegroundPushPresentation();
  }, []);

  // 1) 令牌保活
  useEffect(() => {
    if (!enabled || !isPushSupported() || !tenantId || !userId) return;
    const scope = { tenantId, userId };
    let active = true;
    registeredTokenHash.current = null;

    const refresh = async () => {
      try {
        const binding = await readPushBinding(scope);
        // 本机从未开启过推送：不主动申请权限，也不注册。
        if (!binding || !active) return;
        if ((await getPushPermissionState()) !== 'granted' || !active) return;
        const token = await getDevicePushToken();
        if (!token || !active) return;
        const tokenHash = hashPushToken(token);
        if (tokenHash === registeredTokenHash.current) return;
        const device = await registerPushDevice(token);
        if (!active) return;
        registeredTokenHash.current = tokenHash;
        await writePushBinding(scope, { id: device.id, tokenHash });
      } catch (error) {
        // 保活失败不打扰用户：设置页仍会展示真实状态，用户可手动重开。
        console.warn('[push] 设备令牌保活失败', error);
      }
    };

    void refresh();
    const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') void refresh();
    });
    return () => {
      active = false;
      subscription.remove();
    };
  }, [enabled, tenantId, userId]);

  const deliver = useCallback((snapshot: PushResponseSnapshot) => {
    if (!publishPushNotificationTarget(snapshot.identifier, snapshot.data)) return;
    setInboxRevision((revision) => revision + 1);
  }, []);

  // 2a) 冷启动 + 热态两条投递入口
  useEffect(() => {
    if (!isPushSupported()) return;
    let active = true;
    void getLastPushResponseAsync()
      .then((snapshot) => {
        if (active && snapshot) deliver(snapshot);
      })
      .catch(() => undefined);
    const unsubscribe = addPushResponseListener((snapshot) => {
      if (active) deliver(snapshot);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [deliver]);

  // 2b) 已登录才消费；未登录时目标留在信箱里等这一步。
  useEffect(() => {
    if (!enabled) return;
    const target = consumePushNotificationTarget();
    if (!target) return;
    if (target.kind === 'session') {
      router.push(`/chat/${encodeURIComponent(target.sessionId)}`);
      return;
    }
    // 任务详情页自带运行历史，runId 只用于服务端定位，这里不再作为路由参数。
    router.push(`/cron/${encodeURIComponent(target.jobId)}`);
  }, [enabled, inboxRevision, router]);
}

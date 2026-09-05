/**
 * 系统推送的平台薄封装 —— 本轮只做 iOS（APNs）。
 *
 * 这一层只负责「把 expo-notifications 的原生形状翻译成业务层能用的最小结构」：
 * 权限状态、设备令牌、前台呈现策略、点击响应。所有 expo 模块访问都收在函数体内，
 * 业务层与 hook 只依赖本文件导出的纯结构，测试用 `vi.mock('expo-notifications')` 即可。
 *
 * 与 `jitMediaPermissions.ts` 同一约定：import 本模块没有任何权限副作用，
 * 只有用户在设置页明确打开开关时才会触发系统授权弹窗。
 */
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';

/** `unsupported`：非 iOS 平台，本轮不提供系统推送。 */
export type PushPermissionState = 'granted' | 'denied' | 'undetermined' | 'unsupported';

/** 通知点击响应的最小快照：identifier 用于去重，data 交给 shared 解析落地目标。 */
export interface PushResponseSnapshot {
  identifier: string;
  data: unknown;
}

/** 本轮系统推送仅在 iOS 落地；其余平台整条链路直接短路。 */
export function isPushSupported(): boolean {
  return Platform.OS === 'ios';
}

function toPermissionState(status: {
  granted: boolean;
  canAskAgain: boolean;
}): PushPermissionState {
  if (status.granted) return 'granted';
  return status.canAskAgain ? 'undetermined' : 'denied';
}

/** 读取当前权限，不产生任何用户可见效果。 */
export async function getPushPermissionState(): Promise<PushPermissionState> {
  if (!isPushSupported()) return 'unsupported';
  return toPermissionState(await Notifications.getPermissionsAsync());
}

/** 主动请求权限；只在用户明确打开开关时调用。 */
export async function requestPushPermission(): Promise<PushPermissionState> {
  if (!isPushSupported()) return 'unsupported';
  return toPermissionState(
    await Notifications.requestPermissionsAsync({
      // 不申请 badge：推送只做提醒，不在应用图标上留计数。
      ios: { allowAlert: true, allowSound: true, allowBadge: false },
    }),
  );
}

/**
 * 取本机 APNs 设备令牌（十六进制字符串）；非 iOS 或原生返回异常形状时返回 null。
 */
export async function getDevicePushToken(): Promise<string | null> {
  if (!isPushSupported()) return null;
  const token = await Notifications.getDevicePushTokenAsync();
  if (token.type !== 'ios' || typeof token.data !== 'string' || !token.data) return null;
  return token.data;
}

/**
 * 前台呈现策略：应用在前台时仍进横幅与通知列表，但不响铃、不加角标
 * （前台已经有站内实时提示，再响一次是打扰）。
 */
export function configureForegroundPushPresentation(): void {
  if (!isPushSupported()) return;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
}

function toSnapshot(
  response: {
    notification: { request: { identifier: string; content: { data?: unknown } } };
  } | null,
): PushResponseSnapshot | null {
  if (!response) return null;
  const request = response.notification?.request;
  if (!request || typeof request.identifier !== 'string') return null;
  return { identifier: request.identifier, data: request.content?.data };
}

/** 订阅通知点击；返回取消订阅函数。 */
export function addPushResponseListener(
  listener: (snapshot: PushResponseSnapshot) => void,
): () => void {
  if (!isPushSupported()) return () => undefined;
  const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
    const snapshot = toSnapshot(response);
    if (snapshot) listener(snapshot);
  });
  return () => subscription.remove();
}

/**
 * 冷启动入口：读取「最近一次通知点击」。用户点通知拉起应用时，
 * 监听器往往晚于原生事件注册，只靠 listener 会漏掉这一次。
 */
export async function getLastPushResponseAsync(): Promise<PushResponseSnapshot | null> {
  if (!isPushSupported()) return null;
  return toSnapshot(Notifications.getLastNotificationResponse());
}

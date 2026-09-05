/**
 * 系统推送设备的 API 客户端与本机绑定记录 —— 对齐 Web `web/src/lib/webPush.ts`。
 *
 * 三块职责：
 * 1. `/api/apns/*` 的读写（状态、注册、解绑），走 shared `authFetch`（已注入 token）；
 * 2. 本机绑定：只记「本机注册的那条设备 id + 令牌指纹」，用于在设备列表里标出
 *    「当前设备」，以及在令牌轮换后判断是否需要重新注册。按 `租户:用户` 作用域存，
 *    同一账号重新登录仍复用，换账号则天然读不到上一个账号的绑定；
 * 3. 设备描述、推送环境、应用版本这些注册元数据的组装（纯函数 + 薄取值包装）。
 *
 * 注册接口在服务端是幂等 upsert：同一令牌换账号登录会原子重绑到当前身份，
 * 因此本机可以放心重复调用，不需要先解绑再注册。
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { authFetch } from '@agent/shared';
import { getV1BuildProfile } from '../v1/v1Runtime';

export const APNS_API_BASE = '/api/apns';
/** 本机绑定的存储键前缀；实际键按身份作用域拼接。 */
export const PUSH_BINDING_KEY_BASE = 'agentChat.apns.binding.v1';

const DEVICE_NAME_MAX = 120;
const APP_VERSION_MAX = 64;

export type PushEnvironment = 'production' | 'sandbox';

/** 服务端设备记录（`GET /api/apns/status` 的 devices 元素）。 */
export interface PushDeviceView {
  id: string;
  deviceName: string;
  environment: PushEnvironment;
  appVersion: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PushDeviceStatus {
  configured: boolean;
  devices: PushDeviceView[];
}

/** 本机绑定：设备记录 id + 令牌指纹（不落原始令牌）。 */
export interface PushDeviceBinding {
  id: string;
  tokenHash: string;
}

export interface PushIdentityScope {
  tenantId: string;
  userId: string;
}

/** 令牌指纹：只用于比对「令牌是否变了」，不回传服务端。 */
export function hashPushToken(token: string): string {
  return bytesToHex(sha256(utf8ToBytes(token)));
}

/** 本机绑定的存储键；无身份时返回 null（敏感数据不允许匿名落盘）。 */
export function pushBindingStorageKey(
  identity: PushIdentityScope | null | undefined,
): string | null {
  if (!identity) return null;
  return `${PUSH_BINDING_KEY_BASE}::t=${encodeURIComponent(identity.tenantId)};u=${encodeURIComponent(identity.userId)}`;
}

/** 设备名：优先系统设备名，缺失时用平台兜底，统一带上系统版本。 */
export function formatDeviceName(
  deviceName: string | null | undefined,
  systemLabel: string,
): string {
  const base = (deviceName ?? '').trim() || (Platform.OS === 'ios' ? 'iPhone' : '移动设备');
  return `${base} · ${systemLabel}`.slice(0, DEVICE_NAME_MAX);
}

/** 应用版本：`1.2.3 (85)`；两段都缺时返回 null，不编造版本号。 */
export function formatAppVersion(
  version: string | null | undefined,
  buildNumber: string | null | undefined,
): string | null {
  const marketing = (version ?? '').trim();
  const build = (buildNumber ?? '').trim();
  if (!marketing && !build) return null;
  const label = marketing && build ? `${marketing} (${build})` : marketing || `build ${build}`;
  return label.slice(0, APP_VERSION_MAX);
}

/** 本机设备描述，如「iPhone · iOS 18」。 */
export function describeDevice(): string {
  const systemLabel =
    Platform.OS === 'ios'
      ? `iOS ${String(Platform.Version)}`
      : `${Platform.OS} ${String(Platform.Version)}`;
  return formatDeviceName(Constants.deviceName, systemLabel);
}

/** 推送环境：只有 production 档位走生产 APNs 网关，其余一律 sandbox。 */
export function currentPushEnvironment(): PushEnvironment {
  return getV1BuildProfile() === 'production' ? 'production' : 'sandbox';
}

/** 本机应用版本，用于在设备列表里区分同名设备的新旧安装。 */
export function currentAppVersion(): string | null {
  const config = Constants.expoConfig;
  const buildNumber = Platform.OS === 'ios' ? config?.ios?.buildNumber : null;
  return formatAppVersion(config?.version, buildNumber);
}

function normalizeDevice(raw: unknown): PushDeviceView | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Record<string, unknown>;
  if (typeof entry.id !== 'string' || !entry.id) return null;
  return {
    id: entry.id,
    deviceName: typeof entry.deviceName === 'string' ? entry.deviceName : '未命名设备',
    environment: entry.environment === 'production' ? 'production' : 'sandbox',
    appVersion: typeof entry.appVersion === 'string' ? entry.appVersion : null,
    createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : '',
    updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : '',
  };
}

/** 归一化服务端状态响应；形状不符的条目直接丢弃，不让界面渲染半截数据。 */
export function normalizePushDeviceStatus(body: unknown): PushDeviceStatus {
  const source = (body ?? {}) as { configured?: unknown; devices?: unknown };
  const devices = Array.isArray(source.devices)
    ? source.devices
        .map(normalizeDevice)
        .filter((device): device is PushDeviceView => device !== null)
    : [];
  return { configured: source.configured === true, devices };
}

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string; code?: string };
    if (body.code === 'APNS_NOT_CONFIGURED') return '服务端尚未开启系统推送，暂时无法绑定本机。';
    return body.error || fallback;
  } catch {
    return fallback;
  }
}

export async function fetchPushDeviceStatus(): Promise<PushDeviceStatus> {
  const response = await authFetch(`${APNS_API_BASE}/status`);
  if (!response.ok) throw new Error(await readError(response, '读取系统推送状态失败'));
  return normalizePushDeviceStatus(await response.json());
}

/** 注册（或刷新）本机设备令牌；服务端按令牌幂等 upsert，可重复调用。 */
export async function registerPushDevice(token: string): Promise<PushDeviceView> {
  const appVersion = currentAppVersion();
  const response = await authFetch(`${APNS_API_BASE}/devices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token,
      deviceName: describeDevice(),
      environment: currentPushEnvironment(),
      ...(appVersion ? { appVersion } : {}),
    }),
  });
  if (!response.ok) throw new Error(await readError(response, '开启系统推送失败'));
  const device = normalizeDevice(await response.json());
  if (!device) throw new Error('服务端返回的设备记录无效');
  return device;
}

export async function unregisterPushDevice(deviceId: string): Promise<void> {
  const response = await authFetch(`${APNS_API_BASE}/devices/${encodeURIComponent(deviceId)}`, {
    method: 'DELETE',
  });
  if (!response.ok) throw new Error(await readError(response, '关闭系统推送失败'));
}

export async function readPushBinding(
  identity: PushIdentityScope | null | undefined,
): Promise<PushDeviceBinding | null> {
  const key = pushBindingStorageKey(identity);
  if (!key) return null;
  try {
    const parsed = JSON.parse((await AsyncStorage.getItem(key)) ?? 'null') as {
      id?: unknown;
      tokenHash?: unknown;
    } | null;
    return parsed && typeof parsed.id === 'string' && typeof parsed.tokenHash === 'string'
      ? { id: parsed.id, tokenHash: parsed.tokenHash }
      : null;
  } catch {
    return null;
  }
}

export async function writePushBinding(
  identity: PushIdentityScope | null | undefined,
  binding: PushDeviceBinding | null,
): Promise<void> {
  const key = pushBindingStorageKey(identity);
  if (!key) return;
  if (binding) await AsyncStorage.setItem(key, JSON.stringify(binding));
  else await AsyncStorage.removeItem(key);
}

/** 退出登录时清掉本机所有身份的绑定记录（登出会同时解绑服务端记录）。 */
export async function clearAllPushBindings(): Promise<void> {
  const keys = await AsyncStorage.getAllKeys();
  const owned = keys.filter((key) => key.startsWith(PUSH_BINDING_KEY_BASE));
  if (owned.length) await AsyncStorage.multiRemove(owned);
}

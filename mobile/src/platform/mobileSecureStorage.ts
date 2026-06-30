import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import type { ISecureStorage } from "@agent/shared";

// Shared keychain access group：让 iOS Share Extension 进程能访问主 app 写入的 token。
// 必须与 app.json 的 ios.entitlements.keychain-access-groups 以及
// expo-share-intent 的 iosAppGroupIdentifier 完全一致。
// Android 不支持也不需要（Share Intent 直接启动主 app 进程，天然共享存储）。
const SHARED_KEYCHAIN_GROUP = "group.com.agentsaas.mobile.share";

const opts: SecureStore.SecureStoreOptions | undefined =
  Platform.OS === "ios" ? { accessGroup: SHARED_KEYCHAIN_GROUP } : undefined;

export const mobileSecureStorage: ISecureStorage = {
  async getItem(key: string): Promise<string | null> {
    return SecureStore.getItemAsync(key, opts);
  },
  async setItem(key: string, value: string): Promise<void> {
    await SecureStore.setItemAsync(key, value, opts);
  },
  async removeItem(key: string): Promise<void> {
    await SecureStore.deleteItemAsync(key, opts);
  },
};

/**
 * 把老版本（未指定 keychainAccessGroup）写入的 token 迁移到共享 group。
 * 升级到 Share Intent 版本后第一次启动调用一次；老 token 存在则搬过来再清掉。
 * 仅 iOS 需要；Android 直接 no-op。失败不抛错（被踹回登录的代价小于崩溃）。
 */
export async function migrateLegacyKeychainItem(key: string): Promise<void> {
  if (Platform.OS !== "ios") return;
  try {
    // 已有新 group 下的值就不动
    const existing = await SecureStore.getItemAsync(key, opts);
    if (existing) return;

    // 尝试从默认 group（无 keychainAccessGroup）读取老值
    const legacy = await SecureStore.getItemAsync(key);
    if (!legacy) return;

    // 搬过来 + 清掉老的
    await SecureStore.setItemAsync(key, legacy, opts);
    await SecureStore.deleteItemAsync(key);
  } catch {
    // 静默：老 token 读不出最坏情况是用户重新登录一次
  }
}

/**
 * Android APK 自动更新检查器
 *
 * 流程: 启动/回到前台 → 从 OSS 检查版本 → 静默下载 → 弹窗提示安装
 * 仅 Android 生效，iOS 走 TestFlight 自动更新。
 */
import { useEffect, useRef, useCallback } from "react";
import { Platform, Alert, AppState } from "react-native";
import {
  cacheDirectory,
  downloadAsync,
  deleteAsync,
  getInfoAsync,
  getContentUriAsync,
} from "expo-file-system/legacy";
import Constants from "expo-constants";

/** OSS 上的版本元数据（public-read） */
const LATEST_JSON_URL =
  "https://agent-saas-releases.oss-cn-shenzhen.aliyuncs.com/android/latest.json";

const APK_FILENAME = "AgentSaaS-update.apk";
const CHECK_COOLDOWN_MS = 30 * 60 * 1000; // 30 min between checks

interface LatestInfo {
  version: string;
  size: number;
  url: string;
  buildTime: string;
}

/** true if remote is strictly newer than local (semver segments) */
function isNewer(remote: string, local: string): boolean {
  const r = remote.split(".").map(Number);
  const l = local.split(".").map(Number);
  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    const diff = (r[i] ?? 0) - (l[i] ?? 0);
    if (diff > 0) return true;
    if (diff < 0) return false;
  }
  return false;
}

/** Launch the Android package installer for a local APK */
async function installApk(uri: string): Promise<void> {
  const contentUri = await getContentUriAsync(uri);
  // Dynamic require — this module is Android-only
  const IntentLauncher =
    require("expo-intent-launcher") as typeof import("expo-intent-launcher");
  await IntentLauncher.startActivityAsync("android.intent.action.VIEW", {
    data: contentUri,
    flags: 1 | 268435456, // FLAG_GRANT_READ_URI_PERMISSION | FLAG_ACTIVITY_NEW_TASK
    type: "application/vnd.android.package-archive",
  });
}

export function useUpdateChecker() {
  const lastCheckRef = useRef(0);
  const busyRef = useRef(false);

  const check = useCallback(async () => {
    if (Platform.OS !== "android") return;
    if (busyRef.current) return;
    if (Date.now() - lastCheckRef.current < CHECK_COOLDOWN_MS) return;

    busyRef.current = true;
    lastCheckRef.current = Date.now();

    try {
      const localVersion = Constants.expoConfig?.version ?? "0.0.0";

      // 1. Fetch version metadata from OSS (public, no auth)
      const res = await fetch(LATEST_JSON_URL);
      if (!res.ok) return;

      const latest = (await res.json()) as LatestInfo;
      if (!latest?.version || !isNewer(latest.version, localVersion)) return;

      const apkUri = `${cacheDirectory}${APK_FILENAME}`;

      // 2. Skip download if the exact same build is already cached (compare file size)
      const existing = await getInfoAsync(apkUri);
      if (!existing.exists || existing.size !== latest.size) {
        await deleteAsync(apkUri, { idempotent: true });

        // Download APK from OSS (public-read, no auth needed)
        const result = await downloadAsync(latest.url, apkUri);

        if (result.status !== 200) {
          await deleteAsync(apkUri, { idempotent: true });
          return;
        }
      }

      // 3. Prompt user to install
      Alert.alert(
        "发现新版本",
        `v${latest.version} 已准备就绪，是否立即安装？`,
        [
          { text: "稍后", style: "cancel" },
          {
            text: "安装",
            onPress: () =>
              installApk(apkUri).catch((e) => {
                console.warn("[UpdateChecker] install failed:", e);
                Alert.alert(
                  "安装失败",
                  `请前往设置允许安装未知来源应用后重试。\n\n${e?.message || e}`,
                );
              }),
          },
        ],
      );
    } catch (err) {
      // Silent — don't disrupt user experience for update failures
      console.warn("[UpdateChecker]", err);
    } finally {
      busyRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (Platform.OS !== "android") return;

    // Check on mount (slight delay to not block startup)
    const timer = setTimeout(check, 3000);

    // Check when app returns to foreground
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") check();
    });

    return () => {
      clearTimeout(timer);
      sub.remove();
    };
  }, [check]);
}

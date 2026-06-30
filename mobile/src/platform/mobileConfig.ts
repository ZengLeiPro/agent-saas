import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import type { IPlatformConfig } from "@agent/shared";

const SERVER_URL_KEY = "agentChat.serverUrl";
const LAN_URL_KEY = "agentChat.lanUrl";
const DEFAULT_BASE_URL = "https://agent-saas.example.com";

let _baseUrl: string = DEFAULT_BASE_URL;
const DEFAULT_LAN_URL = "http://agent.local:3000";
let _lanUrl: string = DEFAULT_LAN_URL;
let _lanReachable: boolean = false;

// ── Server URL (external) ──────────────────────────────────────────

/** Load saved server URL from storage (call during app init) */
export async function loadServerUrl(): Promise<void> {
  const saved = await AsyncStorage.getItem(SERVER_URL_KEY);
  if (saved) {
    _baseUrl = saved;
  }
}

/** Update server URL */
export async function setServerUrl(url: string): Promise<void> {
  _baseUrl = url.replace(/\/+$/, "");
  await AsyncStorage.setItem(SERVER_URL_KEY, _baseUrl);
}

/** Get current server URL (always the external/primary URL) */
export function getServerUrl(): string {
  return _baseUrl;
}

// ── LAN URL ────────────────────────────────────────────────────────

/** Load saved LAN URL from storage (call during app init) */
export async function loadLanUrl(): Promise<void> {
  const saved = await AsyncStorage.getItem(LAN_URL_KEY);
  if (saved) {
    _lanUrl = saved;
  }
}

/** Update LAN URL. Pass empty string to disable. */
export async function setLanUrl(url: string): Promise<void> {
  _lanUrl = url ? url.replace(/\/+$/, "") : "";
  if (_lanUrl) {
    await AsyncStorage.setItem(LAN_URL_KEY, _lanUrl);
    await probeLan();
  } else {
    await AsyncStorage.removeItem(LAN_URL_KEY);
    _lanReachable = false;
  }
}

/** Get configured LAN URL (empty string if not set) */
export function getLanUrl(): string {
  return _lanUrl;
}

/** Whether LAN is currently reachable and being used */
export function isLanActive(): boolean {
  return !!_lanUrl && _lanReachable;
}

// ── LAN reachability probe ─────────────────────────────────────────

/** Probe LAN URL with 2s timeout via lightweight /healthz endpoint */
async function probeLan(): Promise<boolean> {
  if (!_lanUrl) {
    _lanReachable = false;
    return false;
  }
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${_lanUrl}/healthz`, {
      method: "GET",
      signal: controller.signal,
    });
    clearTimeout(tid);
    _lanReachable = res.ok;
    return _lanReachable;
  } catch {
    _lanReachable = false;
    return false;
  }
}

let _probeTimer: ReturnType<typeof setInterval> | null = null;
let _netInfoUnsub: (() => void) | null = null;

/** Start periodic LAN probe + listen for network changes. No-op if LAN URL is not configured. */
export function startLanProbe(intervalMs = 30_000): void {
  stopLanProbe();
  if (!_lanUrl) return;
  void probeLan();
  _probeTimer = setInterval(() => void probeLan(), intervalMs);
  // Probe immediately on any network change (WiFi connect/disconnect, cellular switch)
  _netInfoUnsub = NetInfo.addEventListener(() => {
    void probeLan();
  });
}

/** Stop periodic LAN probe and network listener */
export function stopLanProbe(): void {
  if (_probeTimer) {
    clearInterval(_probeTimer);
    _probeTimer = null;
  }
  if (_netInfoUnsub) {
    _netInfoUnsub();
    _netInfoUnsub = null;
  }
}

// ── Resolved base URL ──────────────────────────────────────────────

/** Returns LAN URL if reachable, otherwise external URL */
function resolveBaseUrl(): string {
  return _lanUrl && _lanReachable ? _lanUrl : _baseUrl;
}

export const mobileConfig: IPlatformConfig = {
  platform: "mobile",
  getBaseUrl(): string {
    return resolveBaseUrl();
  },
  getWsUrl(token: string | null): string {
    const httpUrl = resolveBaseUrl();
    const wsUrl = httpUrl.replace(/^http/, "ws");
    const params = token ? `?token=${encodeURIComponent(token)}` : "";
    return `${wsUrl}/ws${params}`;
  },
};

/**
 * §4.6 健康端点。
 *
 * `live`（公开）：`{status:'ok'|'maintenance', etaMinutes?}`，发版期间返回 `maintenance`（§8.3）。
 * `ready`（platform）：契约版本、应用版本、manifest digest、安装实例状态、依赖健康与目录消费位点。
 */
import {
  CONTRACT_VERSION,
  type HealthLiveResponse,
  type HealthReadyResponse,
  type InstallationState,
} from '@kaiyan/ky-app-contract';

export interface HealthLiveInput {
  maintenance?: boolean;
  /** 维护预计剩余分钟数，只在 `maintenance` 下出现。 */
  etaMinutes?: number;
}

export function buildHealthLive(input: HealthLiveInput = {}): HealthLiveResponse {
  if (input.maintenance !== true) return { status: 'ok' };
  return {
    status: 'maintenance',
    ...(input.etaMinutes === undefined ? {} : { etaMinutes: input.etaMinutes }),
  };
}

export interface HealthReadyDeps {
  /** 业务库可用。 */
  db: () => Promise<boolean> | boolean;
  executionStore: () => Promise<boolean> | boolean;
  jtiStore: () => Promise<boolean> | boolean;
}

export interface HealthReadyInput {
  appVersion: string;
  manifestDigest: string;
  installationState: InstallationState;
  maintenance?: boolean;
  deps: HealthReadyDeps;
  /** 目录消费位点与陈旧度（§3.4）。 */
  directorySync: () => Promise<{ checkpoint: number; ageSeconds: number }>;
  jwksKids: () => string[];
}

async function safeProbe(probe: () => Promise<boolean> | boolean): Promise<boolean> {
  try {
    return await probe();
  } catch {
    return false;
  }
}

export async function buildHealthReady(input: HealthReadyInput): Promise<HealthReadyResponse> {
  const [db, executionStore, jtiStore] = await Promise.all([
    safeProbe(input.deps.db),
    safeProbe(input.deps.executionStore),
    safeProbe(input.deps.jtiStore),
  ]);
  let directorySync: { checkpoint: number; ageSeconds: number };
  try {
    directorySync = await input.directorySync();
  } catch {
    // 位点读不出来时按「从未同步」上报，fail-closed 由调用方的门禁决定。
    directorySync = { checkpoint: 0, ageSeconds: Number.MAX_SAFE_INTEGER };
  }

  return {
    status: input.maintenance === true ? 'maintenance' : 'ok',
    contractVersion: CONTRACT_VERSION,
    appVersion: input.appVersion,
    manifestDigest: input.manifestDigest,
    installationState: input.installationState,
    deps: { db, executionStore, jtiStore, directorySync },
    jwksKids: input.jwksKids(),
  };
}

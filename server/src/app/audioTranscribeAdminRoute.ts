import type { Express } from "express";

import { createAudioTranscribeAdminRouter } from "../routes/audioTranscribeAdmin.js";
import type { AppRuntime } from "./runtime.js";
import type { AdminConfigMutationService } from "../config/adminConfigMutationService.js";
import type { ConfigRuntimeRecoveryPermit } from "../config/runtimeRecoveryGate.js";

type SharedConfigIdentityPublisherRuntime = Pick<
  AppRuntime,
  "acknowledgeSharedConfigApplied" | "invalidateSharedConfigIdentity"
  | "notifySharedConfigChanged" | "refreshSharedConfig"
>;

/**
 * 管理端 durable commit 后发布 ConfigIdentity：只有磁盘仍精确等于本请求写入文本时
 * 才确认该版本；否则先同步撤销旧 observation，再强制加载并发胜出版本。
 */
export async function publishAdminCommittedConfigIdentity(
  runtime: SharedConfigIdentityPublisherRuntime,
  expectedConfigText: string,
  recoveryPermit?: ConfigRuntimeRecoveryPermit,
): Promise<void> {
  const acknowledged = recoveryPermit
    ? runtime.acknowledgeSharedConfigApplied(expectedConfigText, recoveryPermit)
    : runtime.acknowledgeSharedConfigApplied(expectedConfigText);
  if (acknowledged) {
    if (recoveryPermit) runtime.notifySharedConfigChanged(recoveryPermit);
    else runtime.notifySharedConfigChanged();
    return;
  }
  runtime.invalidateSharedConfigIdentity();
  if (!await runtime.refreshSharedConfig(true)) {
    throw new Error("配置文件被并发改写且重载失败");
  }
  // SharedConfigRefresher 成功应用时也会 notify；再次通知是安全的，并确保
  // 自定义或测试 refresher 没有回调时，仍只按已应用的胜出内存配置重算。
  if (recoveryPermit) runtime.notifySharedConfigChanged(recoveryPermit);
  else runtime.notifySharedConfigChanged();
}

export function registerAudioTranscribeAdminRoute(
  app: Express,
  runtime: AppRuntime,
  processCwd: string,
  configMutationService?: AdminConfigMutationService,
): void {
  app.use(
    "/api/admin/audio-transcribe",
    createAudioTranscribeAdminRouter({
      processCwd,
      config: runtime.config,
      secretVault: runtime.secretVault,
      validate: runtime.validateAudioTranscribeConfig,
      onUpdated: runtime.updateAudioTranscribeConfig,
      configMutationService,
      ensureConfigBaselineApplied: async () => await runtime.refreshSharedConfig(true),
      onConfigReloaded: (expectedText) => publishAdminCommittedConfigIdentity(runtime, expectedText),
    }),
  );
}

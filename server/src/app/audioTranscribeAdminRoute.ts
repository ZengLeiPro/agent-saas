import type { Express } from "express";

import { createAudioTranscribeAdminRouter } from "../routes/audioTranscribeAdmin.js";
import type { AppRuntime } from "./runtime.js";
import type { AdminConfigMutationService } from "../config/adminConfigMutationService.js";
import type { ConfigRuntimeRecoveryPermit } from "../config/runtimeRecoveryGate.js";

type SharedConfigIdentityPublisherRuntime = Pick<
  AppRuntime,
  "acknowledgeSharedConfigApplied" | "invalidateSharedConfigIdentity"
  | "notifySharedConfigChanged" | "refreshSharedConfig"
> & {
  /** 仅测试窄对象可省略；真实 recovery 路径缺失时必须 fail closed。 */
  acknowledgeRecoveryConfigApplied?: AppRuntime["acknowledgeRecoveryConfigApplied"];
  prepareSharedConfigIdentityPublication?: AppRuntime["prepareSharedConfigIdentityPublication"];
};

/**
 * 管理端 durable commit 后发布 ConfigIdentity。恢复事务精确确认磁盘文本后仅准备 observation，
 * 由 mutation service 在 audit 成功后提交；并发改写则撤销旧 observation 并加载胜出版本。
 */
export async function publishAdminCommittedConfigIdentity(
  runtime: SharedConfigIdentityPublisherRuntime,
  expectedConfigText: string,
  recoveryPermit?: ConfigRuntimeRecoveryPermit,
): Promise<void | (() => void)> {
  if (recoveryPermit) {
    if (!runtime.acknowledgeRecoveryConfigApplied
      || !runtime.acknowledgeRecoveryConfigApplied(expectedConfigText, recoveryPermit)) {
      runtime.invalidateSharedConfigIdentity();
      throw new Error("恢复配置文本与当前稳定磁盘快照不一致");
    }
    if (!runtime.prepareSharedConfigIdentityPublication) {
      throw new Error("运行时缺少受信配置身份发布器");
    }
    return await runtime.prepareSharedConfigIdentityPublication(recoveryPermit);
  }
  if (runtime.acknowledgeSharedConfigApplied(expectedConfigText)) {
    runtime.notifySharedConfigChanged();
    return;
  }
  runtime.invalidateSharedConfigIdentity();
  if (!await runtime.refreshSharedConfig(true)) {
    throw new Error("配置文件被并发改写且重载失败");
  }
  // SharedConfigRefresher 成功应用时也会 notify；再次通知是安全的，并确保
  // 自定义或测试 refresher 没有回调时，仍只按已应用的胜出内存配置重算。
  runtime.notifySharedConfigChanged();
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
      onConfigReloaded: async (expectedText) => {
        await publishAdminCommittedConfigIdentity(runtime, expectedText);
      },
    }),
  );
}

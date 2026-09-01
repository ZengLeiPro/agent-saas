import type { Express } from "express";

import { createAudioTranscribeAdminRouter } from "../routes/audioTranscribeAdmin.js";
import type { AppRuntime } from "./runtime.js";
import type { AdminConfigMutationService } from "../config/adminConfigMutationService.js";

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
    }),
  );
}

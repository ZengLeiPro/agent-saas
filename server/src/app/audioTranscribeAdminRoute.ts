import type { Express } from "express";

import { createAudioTranscribeAdminRouter } from "../routes/audioTranscribeAdmin.js";
import type { AppRuntime } from "./runtime.js";

export function registerAudioTranscribeAdminRoute(
  app: Express,
  runtime: AppRuntime,
  processCwd: string,
): void {
  app.use(
    "/api/admin/audio-transcribe",
    createAudioTranscribeAdminRouter({
      processCwd,
      config: runtime.config,
      secretVault: runtime.secretVault,
      validate: runtime.validateAudioTranscribeConfig,
      onUpdated: runtime.updateAudioTranscribeConfig,
    }),
  );
}

/**
 * Routes Export
 *
 * 统一导出所有路由模块
 * 注: Chat 路由已移入 WebChannel.start()，不再在此导出
 */

export { createHealthRouter } from "./health.js";
export { createUploadRouter, type UploadRouterOptions } from "./upload.js";
export { createCronRouter } from "./cron.js";
export {
  createSessionsRouter,
  type SessionsRouterOptions,
} from "./sessions.js";
export { createTtsRouter, type TtsRouterConfig } from "./tts.js";
export { createGroupsRouter, type GroupsRouterOptions } from "./groups.js";
export { createFileRouter, type FileRouterOptions } from "./file.js";
export { createVoiceRouter, type VoiceRouterOptions } from "./voice.js";
export { createPreviewRoutes, type PreviewRouterOptions } from "./preview.js";
export { createBrowserRouter, type BrowserRouterOptions } from "./browser.js";
export {
  createAppUpdateRouter,
  type AppUpdateRouterOptions,
} from "./app-update.js";
export { createUsageRouter, type UsageRouterOptions } from "./usage.js";
export {
  createArtifactsRouter,
  type ArtifactsRouterOptions,
} from "./artifacts.js";
export { createSearchRouter, type SearchRouterOptions } from "./search.js";

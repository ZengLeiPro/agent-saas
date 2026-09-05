/**
 * `@kaiyan/ky-app-cli` —— `ky-app` 命令行的可编程入口。
 *
 * bin：`ky-app doctor|mock-shell|register|onboard|rotate-credential`。
 * 一致性测试的编排、mock 壳与密钥扫描器都作为库导出，方便平台侧诊断页复用。
 */
export { USAGE, main, parseDotEnv } from './cli.js';
export { runDoctor, loadProjectFiles, resolveDatabase, defaultPgMode } from './doctor/run.js';
export { DoctorContext } from './doctor/context.js';
export { createMockShell, type MockShell, type MockShellOptions } from './mockShell/server.js';
export { createMockSigner, type MockSigner } from './mockShell/keys.js';
export { createMockDirectory, type MockDirectory } from './mockShell/directory.js';
export {
  agentClaims,
  platformClaims,
  userClaims,
  randomJti,
  randomNonce,
  type AppIdentity,
} from './mockShell/sat.js';
export { Reporter, skip, SkipCheck } from './harness/report.js';
export { scanSecrets, formatFindings, type SecretFinding, type SecretRule } from './secretScan.js';
export { startApp, resolveStartCommand, type AppInstance } from './harness/appProcess.js';
export {
  dockerAvailable,
  startDockerPostgres,
  usePgUrl,
  looksLikeTestDatabase,
  type PgHandle,
} from './harness/pg.js';
export { CHAPTERS } from './types.js';
export type {
  BrowserMode,
  ChapterSummary,
  CheckResult,
  CheckStatus,
  DoctorOptions,
  DoctorReport,
  PgMode,
} from './types.js';

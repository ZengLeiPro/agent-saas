/**
 * dist/admin/launcher.mjs 入口。逻辑全部在 launcher.ts（可注入依赖、可测试）。
 */
import { defaultLauncherDeps, runAdminLauncher } from './launcher.js';

runAdminLauncher(process.argv.slice(2), defaultLauncherDeps(import.meta.url)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(
      `[admin-launcher] internal failure: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 3;
  },
);

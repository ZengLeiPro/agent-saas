/** 项目根与静态产物目录：源码运行（tsx）与编译后运行（server/dist）都要能定位。 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 向上找到含 `ky-app.manifest.json` 的目录即项目根。 */
export function projectRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(current, 'ky-app.manifest.json'))) return current;
    const parent = resolve(current, '..');
    if (parent === current) break;
    current = parent;
  }
  throw new Error('找不到项目根（向上 8 层都没有 ky-app.manifest.json）');
}

/** 前端生产构建产物目录（由本服务托管，§5.1）。 */
export function webDistDir(): string {
  return join(projectRoot(), 'web', 'dist');
}

/**
 * 本项目自己的迁移目录。
 * 注意从项目根算，不要从当前文件算：`tsc` 不会把 `.sql` 复制进 `server/dist/`。
 */
export function migrationsDir(): string {
  return join(projectRoot(), 'server', 'migrations');
}

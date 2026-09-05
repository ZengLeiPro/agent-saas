/**
 * `create-ky-app` —— 开沿定制项目脚手架（Hono + Vue 模板）。
 *
 * 生成的项目自带 manifest、附录 J 夹具、声明式权限表、`skills/`、CI、
 * `.gitignore` + pre-commit 密钥扫描，以及由 `@kaiyan/ky-app-contract` 生成的
 * `CLAUDE.md` 契约片段。
 */
export { USAGE, main } from './cli.js';
export {
  createProject,
  resolveLink,
  specifierFor,
  renameTemplatePath,
  toIdentifier,
  RENAMES,
  KY_PACKAGES,
  KY_DEV_PACKAGES,
  DEFAULT_KY_VERSION,
  type CreateProjectOptions,
  type CreateProjectResult,
  type LinkMode,
} from './generate.js';

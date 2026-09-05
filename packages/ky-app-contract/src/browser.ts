/**
 * 浏览器安全子集入口（`@kaiyan/ky-app-contract/browser`）。
 *
 * 主入口 `index.ts` 会连带加载 `hash.ts`（`node:crypto` + `Buffer`）与
 * `schemas/index.ts`（`ajv`）—— 这两样在浏览器构建里要么报错要么白白增体积。
 * 子端 SDK（`@kaiyan/ky-app-browser`）与任何前端项目只需要「类型 + 常量 + 路径规范化 +
 * 错误码」，因此单独给一个不含 Node / ajv 依赖的入口。
 *
 * 这里只做**再导出**，不新增任何语义：同一个 `normalizeAppPath` / 同一批常量，
 * 与服务端走的是同一份实现，不存在契约漂移。
 */
export * from './types/index.js';
export * from './path.js';
export * from './errors.js';

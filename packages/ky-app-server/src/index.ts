/**
 * @kaiyan/ky-app-server —— 定制项目服务端 SDK。
 *
 * 规范：`开沿定制项目与KY Agent衔接契约-实施终稿.md` §3 全部、§4 全部、§6.5、§8.3、§9.1～9.3、附录 B/D/E/I/L。
 * 契约类型、schema、JCS/aph、路径规范化、claims 与端点矩阵一律复用 `@kaiyan/ky-app-contract`。
 *
 * Hono 参考适配器放在子路径入口 `@kaiyan/ky-app-server/hono`（`hono` 是可选 peer 依赖）。
 */
export { CONTRACT_VERSION } from '@kaiyan/ky-app-contract';

export * from './errors.js';
export * from './config/index.js';
export * from './jwks/client.js';
export * from './sat/jtiStore.js';
export * from './sat/pgJtiStore.js';
export * from './sat/verify.js';
export * from './local/keys.js';
export * from './local/attest.js';
export * from './local/token.js';
export * from './breakGlass/store.js';
export * from './breakGlass/service.js';
export * from './breakGlass/pgStore.js';
export * from './directory/store.js';
export * from './directory/staleness.js';
export * from './directory/client.js';
export * from './directory/pgStore.js';
export * from './events/store.js';
export * from './events/handler.js';
export * from './events/pgStore.js';
export * from './capabilities/schemaValidator.js';
export * from './capabilities/executionStore.js';
export * from './capabilities/define.js';
export * from './capabilities/pgExecutionStore.js';
export * from './me/build.js';
export * from './health/index.js';
export * from './pg/schema.js';

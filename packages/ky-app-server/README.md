# @kaiyan/ky-app-server

定制项目服务端 SDK：`verifySat()`（JWKS 缓存/单飞/负缓存/stale-if-error/撤销、claims 矩阵、
端点 × act 矩阵、`pfx` 规范化、`jti` 跨进程单次消费、`dig` 比对）、`verifyLocalToken()`、
`issueAttestation()`、`directoryClient()`、`eventsHandler()`、`defineCapabilities()`、
`breakGlass()`，以及一个参考 Hono 适配器与 PG 存储适配。

**状态：Phase A 只落骨架，实现见 WP1 Phase B。**

## 脚本

| 命令             | 说明                                                                   |
| ---------------- | ---------------------------------------------------------------------- |
| `pnpm typecheck` | `tsc --noEmit`                                                         |
| `pnpm test`      | vitest（需要 PG 的用例读 `TEST_DATABASE_URL`，缺失则 skip 并打印原因） |
| `pnpm build`     | 产出 `dist/`                                                           |

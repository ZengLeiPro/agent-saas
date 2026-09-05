# @kaiyan/ky-app-browser

定制项目前端 SDK（无框架依赖）：握手状态机（attest → `ready` 重发 → `init` → `init.ack`、
重复 `(type,id)` 重放应答）、令牌内存与单飞续期、`fetch` 包装、路由同步（`navId` 回声抑制）、
`openAgent()`、`openLink()`、`permChanged()`。

**状态：Phase A 只落骨架，实现见 WP1 Phase B。**

## 脚本

| 命令             | 说明                 |
| ---------------- | -------------------- |
| `pnpm typecheck` | `tsc --noEmit`       |
| `pnpm test`      | vitest（jsdom 环境） |
| `pnpm build`     | 产出 `dist/`         |

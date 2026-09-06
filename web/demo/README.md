# WP4 双标签与 AppHost 的本地演示态（目视验收用）

**这不是生产代码，也不进生产构建**（`web/vite.config.ts` 的入口只有 `web/index.html`）。
存在的唯一目的：让总控与曾磊在没有后端、不碰 staging、**不跑 `pnpm dev`** 的情况下，
用真实组件把 §5 的四个关键界面看一遍。

## 真的是什么、假的是什么

| 真                                                                               | 假                                                                                          |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `AppsSidebarPanel` / `SidebarNav` / `AppHost` / `AppHostController` 全是生产源码 | 平台 API（`/api/systems/mine`、握手三端点、计费两端点、壳事件）由 `stubs/authFetch.ts` 顶替 |
| §5.3 信封、§5.1 iframe 属性、握手状态机、消息路由器全部真实执行                  | 对端定制项目是 `mock-app.html`（照 §5.4 发 `ready`、回 `init.ack`），不是真实客户系统       |
| 跨源：壳在 `127.0.0.1`，子端在 `localhost`，**是真的跨源**                       | 安装证明不做 HS256 验签（stub 直接返回 SAT 形状的假串）                                     |

## 跑法

```
pnpm exec node web/demo/screenshot.mjs
```

会 `vite build` 出演示产物、用两个静态服务器分别托管壳与子端（真跨源）、
用 Playwright 截四张图到 `assets/20260906/WP4施工/截图/`。

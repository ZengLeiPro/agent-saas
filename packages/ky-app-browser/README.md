# @kaiyan/ky-app-browser

定制项目**子端**（iframe 内）SDK，无框架依赖：握手状态机、令牌内存与单飞续期、
`fetch` 包装、路由同步、`openAgent()` / `openLink()` / `toast()` / `permChanged()`。

契约：`开沿定制项目与 KY Agent 衔接契约` §3.1、§3.4、§4.6、§5.1～5.5。消息表见 §5.4，
类型与常量来自 `@kaiyan/ky-app-contract/browser`（浏览器安全子集，不含 Node / ajv 依赖）。

## 安装

```bash
npm i @kaiyan/ky-app-browser   # 第一期从 Release 附件的 tarball 安装
```

## createKyApp

```ts
import { createKyApp } from '@kaiyan/ky-app-browser';

export const kyApp = createKyApp({
  contractVersion: 1,
  attestUrl: '/ky/v1/attest', // 默认值
  externalLinkHosts: ['docs.kaiyan.net'], // 来自 manifest
  onInit: (ctx) => {
    // ctx: { token 已由 SDK 收走, user, theme, locale, installationId, ... }
    session.setUser(ctx.user);
  },
  onRoute: async (path) => {
    const matched = await router.push(path);
    return matched ? { ok: true, path } : { ok: false, reason: 'not_found' };
  },
  onTheme: (theme) => document.documentElement.setAttribute('data-theme', theme),
  onVisibility: (visible) => void visible,
  onPermChanged: (permVersion) => void permVersion,
  onTokenError: (reason) => ui.showSessionEnded(reason), // 客户面文案由应用层渲染
});

await kyApp.ready(); // 握手完成（active）；standalone 直接完成
const res = await kyApp.fetch('/api/app/orders'); // 自动带 Authorization
```

关键 API：`fetch`、`ready`、`getState`、`routeChanged(path, title?)`、
`syncHistory(path, { mode: 'push' | 'replace' })`、`openAgent({ prompt?, context? })`、
`openLink(url)`、`toast({ level, message })`、`requestLogout()`、`permChanged(v)`、`destroy()`。

## Vue（或任意框架）接入

```ts
// main.ts
const app = createApp(App);
const kyApp = createKyApp({
  onRoute: async (path) => {
    const route = router.resolve(path);
    if (route.matched.length === 0) return { ok: false, reason: 'not_found' };
    await router.replace(path);
    return { ok: true, path };
  },
});
app.provide('kyApp', kyApp);

// 用户在页面内导航后回报给壳（回声由 SDK 自动抑制）
router.afterEach((to) => kyApp.routeChanged(to.fullPath));
```

React / Svelte / 原生同理：SDK 只暴露普通函数与回调，不碰任何框架 API。
浏览器之外（SSR、Node 脚本）不要调用 `createKyApp()`。

## 独立模式（standalone）

URL 上没有 `ky=1` 时自动进入 `standalone`：不握手、不发任何 postMessage、
`fetch` 不带令牌。本地开发（`vite dev` 直接打开）与兜底登录页（`/ky-local/*`）复用同一份代码。

## 注意事项

1. **令牌只在内存**。SDK 不写 `localStorage` / `sessionStorage` / cookie，也不提供读取令牌的
   接口；页面不要自己保存 token，刷新后由握手重新下发。
2. **写请求要幂等键**。401 之后 SDK 只自动重放 `GET` / `HEAD` 一次；`POST` 等写请求会抛
   `KyAuthError`，请带上同一个 `X-KY-Idempotency-Key` 自行查询或重试，避免重复写入。
3. **跨源不带令牌**。只有同源相对路径或 `options.appOrigin`（`KY_ORIGIN`）同源的请求才带
   `Authorization`。
4. **外链先过白名单**。`openLink()` 只放行 `https:`、无 userinfo、非 IP、host ∈ manifest
   `externalLinkHosts` 的地址，不符合直接本地拒绝，不打扰壳。
5. **客户面文案自己渲染**。`onTokenError(reason)` / `route.result.reason` 只给机器可读的原因，
   文案与重试入口由应用层决定。
6. **诊断**：`getState()` 返回 `phase / mode / installationId / tokenExp / shellOrigin / counters`，
   `counters` 含丢弃、重放、续期等计数，排障时先看它。
7. **卸载**：单页应用销毁时调用 `destroy()`，会移除消息监听并清空全部定时器。

## 脚本

| 命令             | 说明                 |
| ---------------- | -------------------- |
| `pnpm typecheck` | `tsc --noEmit`       |
| `pnpm test`      | vitest（jsdom 环境） |
| `pnpm build`     | 产出 `dist/`         |

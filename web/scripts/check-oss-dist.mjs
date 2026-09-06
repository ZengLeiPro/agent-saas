import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const dist = new URL("../dist/", import.meta.url);
const expectedApiOrigin = new URL(process.env.VITE_API_BASE).origin;
const index = await readFile(new URL("index.html", dist), "utf8");
const sw = await readFile(new URL("sw.js", dist), "utf8");

if (
  !index.includes('window.location.protocol === "http:"') ||
  !index.includes('window.location.hostname === "agent.kaiyan.net"') ||
  !index.includes("https://agent.kaiyan.net")
) {
  throw new Error("index.html 缺少 agent.kaiyan.net 的 HTTP→HTTPS 客户端跳转");
}

// 规范 §5.1：壳站不得被嵌套。OSS 直出设不了 frame-ancestors / X-Frame-Options，
// 也没有 CDN 可以前置（不要在这里假设 CDN 存在），因此内联 frame-busting 是唯一防线 ——
// 构建产物里一旦丢了它，点击劫持就没有任何拦截，必须静态断言其存在。
// 注：**不要**把这条搬去 check-live-oss.mjs 做线上响应头断言，OSS 设不了头，会永久红。
if (
  !index.includes("window.top !== window.self") ||
  !index.includes('document.documentElement.style.display = "none"') ||
  !index.includes("window.top.location.replace(window.self.location.href)")
) {
  throw new Error("index.html 缺少壳站 frame-busting（§5.1 禁止被嵌套）");
}

const forbiddenSwMarkers = [
  "api-sessions-list",
  "api-session-detail",
  "api-cron",
  "api-static",
  "createHandlerBoundToURL",
];
for (const marker of forbiddenSwMarkers) {
  if (sw.includes(marker)) {
    throw new Error(`sw.js 仍包含禁止的 API/导航缓存规则：${marker}`);
  }
}

const assetFiles = await readdir(new URL("assets/", dist));
const jsFiles = assetFiles.filter((name) => name.endsWith(".js"));
let apiOriginEmbedded = false;
for (const name of jsFiles) {
  const content = await readFile(join(new URL("assets/", dist).pathname, name), "utf8");
  if (content.includes(expectedApiOrigin)) apiOriginEmbedded = true;
}
if (!apiOriginEmbedded) {
  throw new Error(`构建产物未包含 API 域：${expectedApiOrigin}`);
}

const manifest = JSON.parse(await readFile(new URL("manifest.webmanifest", dist), "utf8"));
if (!manifest.name || !Array.isArray(manifest.icons)) {
  throw new Error("manifest.webmanifest 缺少 name/icons");
}

console.log(`OSS dist contract passed: api=${expectedApiOrigin}, js=${jsFiles.length}`);

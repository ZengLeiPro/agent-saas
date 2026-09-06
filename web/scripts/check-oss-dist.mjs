import { readdir, readFile, stat } from "node:fs/promises";
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

// WP4：目视验收/E2E 的演示态 `web/demo/` 留在仓库里（Phase C 的 E2E 要用同一个 mock 子端），
// 但它**绝不能进生产构建**。生产入口只有 `web/index.html`，演示态自带
// `web/demo/vite.config.ts`；这里做静态断言，防止有人把它接进主入口图：
// ① 产物里不许出现演示态的桩标记；② 产物里不许出现 mock 子端页面或 demo 目录。
const DEMO_STUB_MARKER = "ky-app-demo-stub-do-not-ship";
const distEntries = await readdir(dist);
for (const forbidden of ["mock-app.html", "demo"]) {
  if (distEntries.includes(forbidden)) {
    throw new Error(`生产产物里出现了演示态资源：dist/${forbidden}（web/demo 不得进生产构建）`);
  }
}
if (index.includes(DEMO_STUB_MARKER) || index.includes("mock-app.html")) {
  throw new Error("index.html 引用了演示态资源（web/demo 不得进生产构建）");
}

const assetFiles = await readdir(new URL("assets/", dist));
const jsFiles = assetFiles.filter((name) => name.endsWith(".js"));
let apiOriginEmbedded = false;
for (const name of jsFiles) {
  const content = await readFile(join(new URL("assets/", dist).pathname, name), "utf8");
  if (content.includes(expectedApiOrigin)) apiOriginEmbedded = true;
  if (content.includes(DEMO_STUB_MARKER)) {
    throw new Error(`生产产物 assets/${name} 里含演示态桩（web/demo 不得进生产构建）`);
  }
}
if (!apiOriginEmbedded) {
  throw new Error(`构建产物未包含 API 域：${expectedApiOrigin}`);
}

const manifest = JSON.parse(await readFile(new URL("manifest.webmanifest", dist), "utf8"));
if (!manifest.name || !Array.isArray(manifest.icons)) {
  throw new Error("manifest.webmanifest 缺少 name/icons");
}

// 顺带把「演示态目录还在仓库里」这件事也说清楚：它在，但没进产物。
const demoDir = new URL("../demo/", import.meta.url);
const demoPresent = await stat(demoDir).then(
  (entry) => entry.isDirectory(),
  () => false,
);

console.log(
  `OSS dist contract passed: api=${expectedApiOrigin}, js=${jsFiles.length}, `
    + `demoInRepo=${demoPresent}, demoInDist=false`,
);

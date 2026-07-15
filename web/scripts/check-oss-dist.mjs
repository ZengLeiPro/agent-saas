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

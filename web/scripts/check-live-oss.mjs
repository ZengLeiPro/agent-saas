import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const webOrigin = process.env.VITE_WEB_ORIGIN?.replace(/\/+$/, "");
const apiOrigin = process.env.VITE_API_BASE?.replace(/\/+$/, "");
const bundleApiOrigin = process.env.BUNDLE_API_ORIGIN?.replace(/\/+$/, "") || apiOrigin;
if (!webOrigin || !apiOrigin) throw new Error("缺少 VITE_WEB_ORIGIN/VITE_API_BASE");

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const localIndex = await readFile(`${dist}/index.html`, "utf8");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function fetchNoCache(url, init = {}) {
  return fetch(`${url}${url.includes("?") ? "&" : "?"}deploy_probe=${Date.now()}`, {
    ...init,
    cache: "no-store",
    headers: { ...init.headers, "Cache-Control": "no-cache" },
  });
}

let liveIndexResponse;
let liveIndex = "";
for (let attempt = 1; attempt <= 30; attempt += 1) {
  liveIndexResponse = await fetchNoCache(`${webOrigin}/`);
  liveIndex = await liveIndexResponse.text();
  if (liveIndexResponse.ok && liveIndex === localIndex) break;
  if (attempt === 30) {
    throw new Error(
      `线上 index.html 未切到本次产物：local=${sha256(localIndex)} live=${sha256(liveIndex)}`,
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}

const indexType = liveIndexResponse.headers.get("content-type") || "";
const indexCache = liveIndexResponse.headers.get("cache-control") || "";
if (!indexType.includes("text/html") || !indexCache.includes("no-cache")) {
  throw new Error(`index.html headers 异常：type=${indexType} cache=${indexCache}`);
}

const mainAsset = localIndex.match(/<script[^>]+src="([^"]*\/assets\/index-[^"]+\.js)"/)?.[1];
if (!mainAsset) throw new Error("index.html 未找到主入口 JS");
const localAsset = await readFile(`${dist}${mainAsset}`, "utf8");
const liveAssetResponse = await fetchNoCache(`${webOrigin}${mainAsset}`);
const liveAsset = await liveAssetResponse.text();
const assetType = liveAssetResponse.headers.get("content-type") || "";
const assetCache = liveAssetResponse.headers.get("cache-control") || "";
if (
  !liveAssetResponse.ok ||
  liveAsset !== localAsset ||
  !/(java|ecma)script/.test(assetType) ||
  !assetCache.includes("immutable")
) {
  throw new Error(
    `主入口资源异常：status=${liveAssetResponse.status} type=${assetType} cache=${assetCache} ` +
    `local=${sha256(localAsset)} live=${sha256(liveAsset)}`,
  );
}

const jsFiles = (await readdir(`${dist}/assets`)).filter((name) => name.endsWith(".js"));
let apiConfigAsset;
let localApiConfigAsset;
for (const name of jsFiles) {
  const content = await readFile(`${dist}/assets/${name}`, "utf8");
  if (content.includes(bundleApiOrigin)) {
    apiConfigAsset = `/assets/${name}`;
    localApiConfigAsset = content;
    break;
  }
}
if (!apiConfigAsset || !localApiConfigAsset) {
  throw new Error(`本地产物未找到 API 域：${bundleApiOrigin}`);
}
const liveApiConfigResponse = await fetchNoCache(`${webOrigin}${apiConfigAsset}`);
const liveApiConfigAsset = await liveApiConfigResponse.text();
if (!liveApiConfigResponse.ok || liveApiConfigAsset !== localApiConfigAsset) {
  throw new Error(
    `API 配置 chunk 未正确上线：status=${liveApiConfigResponse.status} ` +
    `local=${sha256(localApiConfigAsset)} live=${sha256(liveApiConfigAsset)}`,
  );
}

const manifestResponse = await fetchNoCache(`${webOrigin}/manifest.webmanifest`);
const manifestType = manifestResponse.headers.get("content-type") || "";
if (!manifestResponse.ok || !manifestType.includes("application/manifest+json")) {
  throw new Error(`manifest headers 异常：status=${manifestResponse.status} type=${manifestType}`);
}

const localSw = await readFile(`${dist}/sw.js`, "utf8");
const swResponse = await fetchNoCache(`${webOrigin}/sw.js`);
const liveSw = await swResponse.text();
if (!swResponse.ok || liveSw !== localSw || !swResponse.headers.get("cache-control")?.includes("no-cache")) {
  throw new Error(`sw.js 未正确上线：status=${swResponse.status} exact=${liveSw === localSw}`);
}

const readyResponse = await fetchNoCache(`${apiOrigin}/api/healthz/ready`, {
  headers: { Origin: webOrigin },
});
if (
  !readyResponse.ok ||
  readyResponse.headers.get("access-control-allow-origin") !== webOrigin
) {
  throw new Error(
    `API/CORS 门禁失败：status=${readyResponse.status} allowOrigin=${readyResponse.headers.get("access-control-allow-origin")}`,
  );
}

const shareProbe = await fetchNoCache(
  `${apiOrigin}/api/share/sessions/deploy-probe-invalid/file?path=audit.pdf`,
  { headers: { Origin: webOrigin, Accept: "application/json" } },
);
const shareType = shareProbe.headers.get("content-type") || "";
if (shareProbe.status < 400 || shareProbe.status >= 500 || !shareType.includes("application/json")) {
  throw new Error(`分享文件 API 路由异常：status=${shareProbe.status} type=${shareType}`);
}

const preflight = await fetchNoCache(`${apiOrigin}/api/auth/login`, {
  method: "OPTIONS",
  headers: {
    Origin: webOrigin,
    "Access-Control-Request-Method": "POST",
    "Access-Control-Request-Headers": "content-type",
  },
});
if (
  preflight.status !== 204 ||
  preflight.headers.get("access-control-allow-origin") !== webOrigin ||
  Number(preflight.headers.get("access-control-max-age")) < 600
) {
  throw new Error(
    `CORS preflight 门禁失败：status=${preflight.status} ` +
    `allowOrigin=${preflight.headers.get("access-control-allow-origin")} ` +
    `maxAge=${preflight.headers.get("access-control-max-age")}`,
  );
}

function probeWebSocket(origin, shouldAllow) {
  return new Promise((resolve, reject) => {
    const wsOrigin = apiOrigin.replace(/^http/, "ws");
    const socket = new WebSocket(`${wsOrigin}/ws?probe=1`, { origin });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error(`WebSocket Origin probe timeout: ${origin}`));
    }, 5_000);
    socket.once("message", () => {
      clearTimeout(timer);
      socket.close();
      if (shouldAllow) resolve();
      else reject(new Error(`WebSocket unexpectedly allowed Origin: ${origin}`));
    });
    socket.once("unexpected-response", (_request, response) => {
      clearTimeout(timer);
      socket.terminate();
      if (!shouldAllow && response.statusCode === 403) resolve();
      else reject(new Error(`WebSocket unexpected status for ${origin}: ${response.statusCode}`));
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      if (shouldAllow) reject(error);
    });
  });
}

await probeWebSocket(webOrigin, true);
await probeWebSocket("https://split-domain-probe.invalid", false);

console.log(
  `Live OSS gate passed: index=${sha256(liveIndex).slice(0, 12)} ` +
  `asset=${sha256(liveAsset).slice(0, 12)} api=${apiOrigin}`,
);

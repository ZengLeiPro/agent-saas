const apiBase = process.env.VITE_API_BASE?.replace(/\/+$/, "");
const webOrigin = process.env.VITE_WEB_ORIGIN?.replace(/\/+$/, "");

if (!apiBase) {
  throw new Error("OSS 构建必须设置 VITE_API_BASE");
}

const apiUrl = new URL(apiBase);
if (apiUrl.protocol !== "https:") {
  throw new Error(`OSS API 域必须使用 HTTPS：${apiBase}`);
}
if (apiUrl.pathname !== "/" || apiUrl.search || apiUrl.hash) {
  throw new Error(`VITE_API_BASE 只能填写 origin，不能带路径、查询或 hash：${apiBase}`);
}

if (webOrigin) {
  const webUrl = new URL(webOrigin);
  if (webUrl.origin === apiUrl.origin) {
    throw new Error(`OSS 前端域与 API 域不能相同：${webUrl.origin}`);
  }
}

console.log(`OSS split-domain build: web=${webOrigin || "(not set)"} api=${apiUrl.origin}`);

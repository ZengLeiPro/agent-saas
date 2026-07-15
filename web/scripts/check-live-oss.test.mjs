import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { WebSocketServer } from "ws";

const webRoot = fileURLToPath(new URL("../", import.meta.url));
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const index = await readFile(`${dist}/index.html`);
const manifest = await readFile(`${dist}/manifest.webmanifest`);
const sw = await readFile(`${dist}/sw.js`);

let webOrigin;
let apiOrigin;
let webServer;
let apiServer;
let wss;

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

before(async () => {
  webServer = http.createServer(async (request, response) => {
    const path = new URL(request.url, "http://local").pathname;
    if (path === "/") {
      response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-cache" });
      response.end(index);
      return;
    }
    if (path === "/manifest.webmanifest") {
      response.writeHead(200, { "Content-Type": "application/manifest+json", "Cache-Control": "no-cache" });
      response.end(manifest);
      return;
    }
    if (path === "/sw.js") {
      response.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-cache" });
      response.end(sw);
      return;
    }
    if (path.startsWith("/assets/")) {
      const body = await readFile(`${dist}${path}`);
      response.writeHead(200, {
        "Content-Type": path.endsWith(".js") ? "text/javascript" : "application/octet-stream",
        "Cache-Control": "public, max-age=31536000, immutable",
      });
      response.end(body);
      return;
    }
    response.writeHead(404).end();
  });
  webOrigin = await listen(webServer);

  apiServer = http.createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", webOrigin);
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "600",
      }).end();
      return;
    }
    const path = new URL(request.url, "http://local").pathname;
    if (path === "/api/healthz/ready") {
      response.writeHead(200, { "Content-Type": "application/json" }).end('{"status":"ok"}');
      return;
    }
    if (path.includes("/api/share/sessions/")) {
      response.writeHead(404, { "Content-Type": "application/json" }).end('{"error":"not found"}');
      return;
    }
    response.writeHead(404).end();
  });
  apiOrigin = await listen(apiServer);

  wss = new WebSocketServer({ noServer: true });
  apiServer.on("upgrade", (request, socket, head) => {
    if (request.headers.origin !== webOrigin) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => ws.send('{"data":{"type":"pong"}}'));
  });
});

after(async () => {
  wss.close();
  await Promise.all([close(webServer), close(apiServer)]);
});

test("live gate passes against independent Web/API origins", async () => {
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["scripts/check-live-oss.mjs"], {
      cwd: webRoot,
      env: {
        ...process.env,
        VITE_WEB_ORIGIN: webOrigin,
        VITE_API_BASE: apiOrigin,
        BUNDLE_API_ORIGIN: process.env.VITE_API_BASE,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Live OSS gate passed/);
});

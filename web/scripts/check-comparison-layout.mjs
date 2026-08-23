import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function availablePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const { port } = address;
  server.close();
  await once(server, "close");
  return port;
}

async function waitForPage(url, processOutput) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Vite 尚未开始监听，继续等待。
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Vite 启动超时：${processOutput.join("")}`);
}

const port = await availablePort();
const fixtureUrl = `http://127.0.0.1:${port}/scripts/fixtures/comparison-layout.html`;
const processOutput = [];
const vite = spawn(
  process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  ["exec", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  { cwd: webRoot, stdio: ["ignore", "pipe", "pipe"] },
);
vite.stdout.on("data", (chunk) => processOutput.push(chunk.toString()));
vite.stderr.on("data", (chunk) => processOutput.push(chunk.toString()));

let browser;
try {
  await waitForPage(fixtureUrl, processOutput);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  await page.goto(fixtureUrl);
  await page.locator("[data-comparison-track]").first().waitFor();

  const tracks = await page.locator("[data-comparison-track]").evaluateAll((elements) =>
    elements.map((element) => ({
      label: element.children[0]?.textContent?.trim() ?? "",
      gridTemplateColumns: getComputedStyle(element).gridTemplateColumns,
      valueColumnStarts: [1, 2, 3].map((index) =>
        Number(element.children[index].getBoundingClientRect().left.toFixed(2)),
      ),
    })),
  );

  assert.equal(tracks.length, 4, "应测量 1 个表头和 3 个不同长度标签的数据行");
  assert.match(tracks[0].gridTemplateColumns, /^144px\s/, "首列应保持紧凑的 9rem 固定轨道");

  const expectedStarts = tracks[0].valueColumnStarts;
  for (const track of tracks.slice(1)) {
    assert.deepEqual(
      track.valueColumnStarts,
      expectedStarts,
      `${track.label} 的第 2～4 列必须与表头保持相同左边界`,
    );
  }

  console.log(JSON.stringify({ fixtureWidth: 800, tracks }, null, 2));
} finally {
  await browser?.close();
  vite.kill("SIGTERM");
  await Promise.race([
    once(vite, "exit"),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
}

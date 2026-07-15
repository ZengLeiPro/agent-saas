import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { test } from "node:test";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const upgradeScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
if (!upgradeScript) throw new Error("index.html 未找到 HTTP→HTTPS 内联脚本");

function execute(location) {
  const redirects = [];
  vm.runInNewContext(upgradeScript, {
    window: {
      location: {
        ...location,
        replace: (target) => redirects.push(target),
      },
    },
  });
  return redirects;
}

test("production HTTP URL upgrades to HTTPS and preserves route state", () => {
  expectRedirects(
    execute({
      protocol: "http:",
      hostname: "agent.kaiyan.net",
      pathname: "/share/a%20b",
      search: "?from=message",
      hash: "#page=2",
    }),
    ["https://agent.kaiyan.net/share/a%20b?from=message#page=2"],
  );
});

test("HTTPS and non-production hosts remain unchanged", () => {
  expectRedirects(execute({
    protocol: "https:",
    hostname: "agent.kaiyan.net",
    pathname: "/",
    search: "",
    hash: "",
  }), []);
  expectRedirects(execute({
    protocol: "http:",
    hostname: "localhost",
    pathname: "/",
    search: "",
    hash: "",
  }), []);
});

function expectRedirects(actual, expected) {
  assert.deepEqual(actual, expected);
}

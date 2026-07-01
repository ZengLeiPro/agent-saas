#!/usr/bin/env node
/**
 * 生成 skill-demo 前端可打开链接。
 *
 * agent-saas 的 Agent 运行在云端 sandbox，不能依赖本地可见 Playwright 窗口。
 * 操作完成后应把此脚本输出的 URL 直接发给客户，让客户在自己的浏览器打开核实。
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SKILL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

function loadConfig() {
  for (const name of ['config.json', 'config.example.json']) {
    const p = join(SKILL_DIR, name);
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  }
  throw new Error('找不到 config.json / config.example.json');
}

function normalizeRoute(raw) {
  const route = String(raw || '').trim();
  if (!route) throw new Error('缺少 route，例如 /crm/customers');
  const withSlash = `/${route.replace(/^\/+/, '')}`;
  if (!/^\/(cywk|crm|bom)(\/|$)/.test(withSlash)) {
    throw new Error('route 必须以 /cywk、/crm 或 /bom 开头');
  }
  return withSlash;
}

async function probe(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal });
    await res.arrayBuffer().catch(() => null);
    return { status: res.status, ok: res.ok, finalUrl: res.url };
  } catch (err) {
    return { error: err?.name === 'AbortError' ? 'timeout' : String(err?.message || err) };
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const route = normalizeRoute(process.argv[2]);
  const cfg = loadConfig();
  const webBase = String(cfg.webBase || '').replace(/\/+$/, '');
  if (!webBase) throw new Error('config 缺少 webBase');

  const url = `${webBase}${route}`;
  const result = await probe(url);

  console.log(JSON.stringify({
    url,
    fallbackUrl: `${webBase}/`,
    route,
    note: '把 url 发给客户打开核实；前端会自动获取 demo token。',
    probe: result,
  }, null, 2));
}

main().catch((e) => {
  console.error('生成页面链接失败:', e.message);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * skill-demo(cywk + crm + bom 三合一)CRUD 请求封装。
 *
 * DEMO 免密登录:POST /auth/token(无 body)直接签发永不过期 JWT。
 * 缓存到 .auth-cache.json;401 时清缓存重登重试一次。
 *
 * 用法:
 *   node scripts/crud.mjs <method> <path> [--data '<json>'] [--dry-run]
 *   node scripts/crud.mjs login             # 确保已登录,打印 demo 用户
 *   node scripts/crud.mjs auth-state [key]  # 仅平台维护/排障使用，默认不要在对话中展示
 *                                           # key: unified-auth(默认) | cywk-auth | crm-auth
 *
 * CRUD 示例(path 直接带业务前缀):
 *   node scripts/crud.mjs get crm/customers
 *   node scripts/crud.mjs get "crm/customers?page=1&pageSize=20&keyword=能源"
 *   node scripts/crud.mjs get crm/customers/<id>
 *   node scripts/crud.mjs post crm/customers --data '{"name":"示例客户","level":"A"}'
 *   node scripts/crud.mjs put crm/customers/<id> --data '{"level":"B"}'    # 本系统更新用 PUT
 *   node scripts/crud.mjs delete crm/customers/<id> --confirm-delete
 *
 *   node scripts/crud.mjs get cywk/stores
 *   node scripts/crud.mjs get bom/work-orders
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SKILL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const CACHE_FILE = join(SKILL_DIR, '.auth-cache.json');

function loadConfig() {
  // 优先 config.json(本地覆盖);无则回退 config.example.json(线上默认)。
  for (const name of ['config.json', 'config.example.json']) {
    const p = join(SKILL_DIR, name);
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, 'utf8'));
      } catch (e) {
        console.error(`解析 ${name} 失败: ${e.message}`);
        process.exit(1);
      }
    }
  }
  console.error('找不到 config.json 或 config.example.json');
  process.exit(1);
}

const cfg = loadConfig();
const API = String(cfg.apiBase || '').replace(/\/+$/, '');

function readCache() {
  try {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

// DEMO 登录:无参数 POST /auth/token 直接签发永不过期 token
async function login() {
  const res = await fetch(`${API}/auth/token`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`登录失败 HTTP ${res.status}: ${text}`);
  const data = JSON.parse(text);
  const cache = { accessToken: data.accessToken, user: data.user || null };
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  return cache;
}

// 有缓存直接用(token 永不过期);无缓存才登录
async function ensureAuth() {
  const cache = readCache();
  if (cache?.accessToken) return cache;
  return login();
}

function parseArgs(argv) {
  const positional = [];
  let data = null;
  let dryRun = false;
  let confirmDelete = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--data' || a === '-d') data = argv[++i];
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--confirm-delete') confirmDelete = true;
    else positional.push(a);
  }
  return { positional, data, dryRun, confirmDelete };
}

// 401 时清缓存重登重试一次
async function request(method, path, body, token, retried = false) {
  const url = `${API}/${String(path).replace(/^\/+/, '')}`;
  const headers = { Accept: 'application/json', Authorization: `Bearer ${token}` };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body });
  if (res.status === 401 && !retried) {
    const fresh = await login();
    return request(method, path, body, fresh.accessToken, true);
  }
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, statusText: res.statusText, ok: res.ok, url, parsed };
}

// 三个 store 的 persist 字段名不同(见 apps/web/src/auth/AuthContext.tsx bootstrapDemoLogin)
function persistFor(key, { accessToken, user }) {
  if (key === 'crm-auth') {
    return JSON.stringify({
      state: { token: accessToken, user: { ...(user || {}), role: 'ADMIN' } },
      version: 0,
    });
  }
  // unified-auth / cywk-auth 用 accessToken
  return JSON.stringify({
    state: { accessToken, user: user || null },
    version: 0,
  });
}

async function main() {
  const { positional, data, dryRun, confirmDelete } = parseArgs(process.argv.slice(2));
  const [cmd, path] = positional;

  if (!cmd) {
    console.error(
      '用法: node scripts/crud.mjs <method|login|auth-state> [path|auth-state-key] [--data ...]'
    );
    process.exit(1);
  }

  // 辅助子命令
  if (cmd === 'login') {
    const { user } = await ensureAuth();
    console.log(`已登录: ${user ? `${user.name || user.username}(${user.username})` : 'demo user'}`);
    return;
  }
  if (cmd === 'token') {
    await ensureAuth();
    console.error('拒绝打印 accessToken。脚本会自动登录并注入 Authorization，无需在对话中暴露 token。');
    process.exit(2);
  }
  if (cmd === 'auth-state' && !process.env.SKILL_DEMO_ALLOW_AUTH_STATE) {
    console.error('拒绝打印 auth-state。仅平台维护排障时设置 SKILL_DEMO_ALLOW_AUTH_STATE=1 后使用。');
    process.exit(2);
  }
  if (cmd === 'auth-state') {
    const key = path || 'unified-auth';
    const cache = await ensureAuth();
    console.log(persistFor(key, cache));
    return;
  }

  // CRUD
  const method = cmd.toUpperCase();
  if (!path) {
    console.error('缺少 path');
    process.exit(1);
  }
  let body;
  if (data != null && !['GET', 'DELETE', 'HEAD'].includes(method)) {
    JSON.parse(data); // 提前校验 JSON
    body = data;
  }
  if (method === 'DELETE' && !confirmDelete) {
    console.error('拒绝执行 DELETE：必须先向用户列出目标记录并取得确认，再追加 --confirm-delete。');
    process.exit(2);
  }

  if (dryRun) {
    console.log(`[dry-run] ${method} ${API}/${String(path).replace(/^\/+/, '')}`);
    if (body) console.log(`body: ${body}`);
    return;
  }

  const { accessToken } = await ensureAuth();
  const r = await request(method, path, body, accessToken);
  console.log(`HTTP ${r.status} ${r.statusText}  ${method} ${r.url}`);
  console.log(typeof r.parsed === 'string' ? r.parsed : JSON.stringify(r.parsed, null, 2));
  if (!r.ok) process.exit(1);
}

main().catch((err) => {
  console.error('失败:', err.message);
  process.exit(1);
});

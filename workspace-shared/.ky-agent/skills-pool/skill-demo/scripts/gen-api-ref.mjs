#!/usr/bin/env node
/**
 * 从 skill-demo backend 的 OpenAPI 文档生成 references/api.md。
 *
 * 用法:
 *   node scripts/gen-api-ref.mjs                                   # 用 config 的 openapiUrl(或由 apiBase 推导)
 *   node scripts/gen-api-ref.mjs --url http://localhost:3000/api/docs-json
 *
 * ⚠️ 后端 Swagger 仅在非生产环境开启(main.ts: NODE_ENV !== 'production')。
 *    生成时必须指向**本地**或**测试**环境;线上 https://fc.kaiyan.net/skill-demo/api/docs-json 是 404。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SKILL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

function resolveUrl() {
  const argIdx = process.argv.indexOf('--url');
  if (argIdx !== -1 && process.argv[argIdx + 1]) return process.argv[argIdx + 1];
  let cfg = {};
  for (const name of ['config.json', 'config.example.json']) {
    try {
      cfg = JSON.parse(readFileSync(join(SKILL_DIR, name), 'utf8'));
      break;
    } catch {
      /* 尝试下一个 */
    }
  }
  if (cfg.openapiUrl) return cfg.openapiUrl;
  if (cfg.apiBase) {
    const u = new URL(cfg.apiBase);
    return `${u.origin}/api/docs-json`;
  }
  console.error('无法确定 OpenAPI 地址:请用 --url 指定,或在 config 里配 openapiUrl / apiBase。');
  process.exit(1);
}

function deref(doc, schema) {
  if (schema && schema.$ref) {
    const name = schema.$ref.split('/').pop();
    return doc.components?.schemas?.[name] || {};
  }
  return schema || {};
}

function typeOf(doc, schema) {
  const s = deref(doc, schema);
  if (s.enum) return `enum(${s.enum.join('|')})`;
  if (s.type === 'array') return `${typeOf(doc, s.items)}[]`;
  return s.type || (s.$ref ? s.$ref.split('/').pop() : 'object');
}

function bodyFields(doc, op) {
  const schema = op.requestBody?.content?.['application/json']?.schema;
  if (!schema) return null;
  const s = deref(doc, schema);
  const props = s.properties || {};
  const required = new Set(s.required || []);
  const rows = Object.entries(props).map(([k, v]) => ({
    name: k,
    type: typeOf(doc, v),
    required: required.has(k),
  }));
  return rows.length ? rows : null;
}

function paramList(op) {
  return (op.params || []).map((p) => `${p.name}${p.required ? '*' : ''} (${p.in})`);
}

// 按 URL 路径前缀分系统:/cywk/... /crm/... /bom/... 其他归"全局"
function systemOf(path) {
  const m = path.match(/^\/api\/v\d+\/([^/]+)/) || path.match(/^\/([^/]+)/);
  const seg = m?.[1];
  if (seg === 'cywk') return '① cywk 餐饮 ERP';
  if (seg === 'crm') return '② CRM';
  if (seg === 'bom') return '③ BOM 设备 ERP';
  return '⑨ 全局';
}

async function main() {
  const url = resolveUrl();
  console.log(`读取 OpenAPI: ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`拉取失败 HTTP ${res.status}。后端是否在运行、是否非生产环境?`);
    process.exit(1);
  }
  const doc = await res.json();

  // 双层分组:system → tag → [ops]
  const bySystem = new Map();
  for (const [path, methods] of Object.entries(doc.paths || {})) {
    for (const [method, op] of Object.entries(methods)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      const sys = systemOf(path);
      const tag = (op.tags && op.tags[0]) || '未分组';
      if (!bySystem.has(sys)) bySystem.set(sys, new Map());
      const byTag = bySystem.get(sys);
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag).push({
        method: method.toUpperCase(),
        path,
        op: { ...op, params: op.parameters },
      });
    }
  }

  const lines = [];
  lines.push('# API 清单(自动生成)');
  lines.push('');
  lines.push('> ⚠️ **本文件由 `scripts/gen-api-ref.mjs` 从后端 OpenAPI 生成。请勿手改。**');
  lines.push(`> 来源: \`${url}\`　标题: ${doc.info?.title || ''} ${doc.info?.version || ''}`);
  lines.push('');
  lines.push('## 通用约定');
  lines.push('');
  lines.push(
    '- 业务接口在 `apiBase` 下(已含 `/api/v1`),形如 `https://fc.kaiyan.net/skill-demo/api/v1`。'
  );
  lines.push(
    '- 鉴权:除 `POST /auth/token` 外,全部需带 `Authorization: Bearer <token>`(由 crud.mjs 自动登录获取)。'
  );
  lines.push('- 字段标 `*` 为必填。资源 → 页面对照见 [routes.md](routes.md)。');
  lines.push(
    '- REST 约定:列表 `GET /资源`、详情 `GET /资源/:id`、新建 `POST /资源`、**更新 `PUT /资源/:id`**、删 `DELETE /资源/:id`。'
  );
  lines.push('');
  lines.push('### 通用分页/排序查询参数');
  lines.push('');
  lines.push('- `page`(query): number(默认 1)');
  lines.push('- `pageSize`(query): number(默认 20,常见上限 100)');
  lines.push('- `sortBy`(query): string');
  lines.push('- `sortOrder`(query): enum(asc|desc)');
  lines.push('- 各列表另有 `keyword` 及业务筛选字段,见下');
  lines.push('');

  let total = 0;
  for (const sys of [...bySystem.keys()].sort()) {
    lines.push(`# ${sys}`);
    lines.push('');
    const byTag = bySystem.get(sys);
    for (const tag of [...byTag.keys()].sort()) {
      lines.push(`## ${tag}`);
      lines.push('');
      for (const { method, path, op } of byTag.get(tag)) {
        lines.push(`### ${method} ${path}`);
        if (op.summary) lines.push(`${op.summary}`);
        const params = paramList(op);
        if (params.length) lines.push(`- 参数: ${params.join(', ')}`);
        const fields = bodyFields(doc, op);
        if (fields) {
          lines.push('- 请求体:');
          for (const f of fields) lines.push(`  - \`${f.name}\`${f.required ? '*' : ''}: ${f.type}`);
        }
        lines.push('');
        total++;
      }
    }
  }

  const out = join(SKILL_DIR, 'references', 'api.md');
  writeFileSync(out, lines.join('\n'), 'utf8');
  console.log(`已写入 ${out}(${total} 个接口,${bySystem.size} 个系统分组)`);
}

main().catch((err) => {
  console.error('生成失败:', err.message);
  process.exit(1);
});

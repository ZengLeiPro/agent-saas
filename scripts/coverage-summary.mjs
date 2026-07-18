#!/usr/bin/env node
// 汇总 server / web / shared 三包 vitest coverage 数据到 markdown 表格。
// 数据源: {pkg}/coverage/coverage-summary.json（由 @vitest/coverage-v8 生成 json-summary reporter 产出）。
// 输出:
//   1) 始终打印到 stdout；
//   2) 若存在 GITHUB_STEP_SUMMARY 环境变量，同时 append 到该文件（进 Actions summary）。
//
// 覆盖率数据缺失（例如某包本轮测试跳过、reporter 未产出）不视为失败：
// 在表格里显式标 "n/a" 并继续；CI 阶段用不到 exit code 做门禁。
//
// 用法:
//   node scripts/coverage-summary.mjs            # 打印到 stdout（+ Step Summary 若存在）
//   node scripts/coverage-summary.mjs --json    # 追加输出机器可读 JSON（供后续脚本）

import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const packages = [
  { name: 'server', jsonPath: resolve(repoRoot, 'server/coverage/coverage-summary.json') },
  { name: 'web',    jsonPath: resolve(repoRoot, 'web/coverage/coverage-summary.json') },
  { name: 'shared', jsonPath: resolve(repoRoot, 'shared/coverage/coverage-summary.json') },
];

/** 读单包 summary；缺失返回 null 而非抛错。 */
function readSummary(jsonPath) {
  if (!existsSync(jsonPath)) return null;
  try {
    return JSON.parse(readFileSync(jsonPath, 'utf8'));
  } catch (err) {
    console.error(`WARN: failed to parse ${jsonPath}: ${err.message}`);
    return null;
  }
}

/** 提取一个 metric 的 pct 值；缺失返回 null。 */
function metricPct(total, key) {
  const m = total?.[key];
  if (!m || typeof m.pct !== 'number') return null;
  return m.pct;
}

/** 提取 covered/total 计数；缺失返回 null。 */
function metricCount(total, key) {
  const m = total?.[key];
  if (!m || typeof m.total !== 'number') return null;
  return { covered: m.covered ?? 0, total: m.total };
}

/** 格式化单元格：`80.2% (401/500)`；缺失显示 n/a。 */
function fmtCell(pct, count) {
  if (pct === null) return 'n/a';
  const pctStr = pct.toFixed(1) + '%';
  if (!count) return pctStr;
  return `${pctStr} (${count.covered}/${count.total})`;
}

/** 合并多包 total: 逐 metric 加总 covered/total，再重算 pct。 */
function mergeTotals(summaries) {
  const metrics = ['statements', 'branches', 'functions', 'lines'];
  const out = {};
  for (const m of metrics) {
    let covered = 0;
    let total = 0;
    let any = false;
    for (const s of summaries) {
      const c = metricCount(s?.total, m);
      if (c) {
        covered += c.covered;
        total += c.total;
        any = true;
      }
    }
    if (!any) {
      out[m] = null;
    } else {
      out[m] = {
        covered,
        total,
        pct: total === 0 ? 100 : (covered / total) * 100,
      };
    }
  }
  return out;
}

const rows = [];
const summariesForMerge = [];
for (const pkg of packages) {
  const summary = readSummary(pkg.jsonPath);
  summariesForMerge.push(summary);
  const total = summary?.total;
  rows.push({
    name: pkg.name,
    statements: [metricPct(total, 'statements'), metricCount(total, 'statements')],
    branches:   [metricPct(total, 'branches'),   metricCount(total, 'branches')],
    functions:  [metricPct(total, 'functions'),  metricCount(total, 'functions')],
    lines:      [metricPct(total, 'lines'),      metricCount(total, 'lines')],
    ok: summary !== null,
  });
}

const merged = mergeTotals(summariesForMerge);
rows.push({
  name: '**total**',
  statements: [merged.statements?.pct ?? null, merged.statements],
  branches:   [merged.branches?.pct ?? null,   merged.branches],
  functions:  [merged.functions?.pct ?? null,  merged.functions],
  lines:      [merged.lines?.pct ?? null,      merged.lines],
  ok: true,
});

const lines = [
  '## 测试覆盖率 (Test Coverage)',
  '',
  '> 口径：**逻辑层覆盖率**——只考核框架无关的可单测代码（server 业务逻辑、',
  '> shared 共享逻辑、web/lib 纯工具）。React 组件/hooks、入口、脚本、DB 迁移、',
  '> 纯类型不纳入本指标（靠 RTL 集成测试与 E2E/手测保障）。',
  '',
  '| 包 | Statements | Branches | Functions | Lines |',
  '|---|---|---|---|---|',
];
for (const row of rows) {
  lines.push(
    `| ${row.name} | ${fmtCell(...row.statements)} | ${fmtCell(...row.branches)} | ${fmtCell(...row.functions)} | ${fmtCell(...row.lines)} |`,
  );
}
lines.push('');
const missing = rows.filter(r => !r.ok).map(r => r.name);
if (missing.length > 0) {
  lines.push(`> ⚠️ 未产出 coverage summary: ${missing.join(', ')}（可能测试跳过或 vitest coverage 未开）。`);
  lines.push('');
}

const markdown = lines.join('\n');
process.stdout.write(markdown + '\n');

const stepSummary = process.env.GITHUB_STEP_SUMMARY;
if (stepSummary) {
  appendFileSync(stepSummary, markdown + '\n');
}

if (process.argv.includes('--json')) {
  const jsonPayload = {
    packages: rows.slice(0, -1).map(r => ({
      name: r.name,
      statements: r.statements[1],
      branches:   r.branches[1],
      functions:  r.functions[1],
      lines:      r.lines[1],
    })),
    total: {
      statements: merged.statements,
      branches:   merged.branches,
      functions:  merged.functions,
      lines:      merged.lines,
    },
  };
  process.stdout.write('\n<!-- COVERAGE_JSON -->\n' + JSON.stringify(jsonPayload) + '\n');
}

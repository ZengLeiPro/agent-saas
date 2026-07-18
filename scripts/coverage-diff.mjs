#!/usr/bin/env node
// PR diff coverage: 只统计"本次 PR 改动的行"是否被测试覆盖，不做全量覆盖率对比。
// 好处: 压力集中在增量而非存量，历史 legacy 代码不必被拉进 review 讨论。
//
// 数据源:
//   - git diff <base>...HEAD --unified=0 拿新增/修改的行范围（只看 +）
//   - server/coverage/lcov.info、web/coverage/lcov.info、shared/coverage/lcov.info
//
// 输出:
//   - 始终打印 markdown 到 stdout
//   - 若存在 GITHUB_STEP_SUMMARY，附加进 Step Summary
//   - 若指定 --write=<path>，同时把 markdown 写入该文件（供 workflow 后续 gh script 读取评论到 PR）
//
// 环境变量:
//   COVERAGE_BASE_REF   显式 base（默认 origin/main）
//   COVERAGE_INCLUDE_EXT 逗号分隔文件后缀白名单（默认 .ts,.tsx）
//
// 用法:
//   node scripts/coverage-diff.mjs
//   node scripts/coverage-diff.mjs --write=/tmp/coverage-diff.md

import { readFileSync, existsSync, appendFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const BASE_REF = process.env.COVERAGE_BASE_REF || 'origin/main';
const INCLUDE_EXT = (process.env.COVERAGE_INCLUDE_EXT || '.ts,.tsx').split(',').map(s => s.trim());

const lcovPaths = [
  resolve(repoRoot, 'server/coverage/lcov.info'),
  resolve(repoRoot, 'web/coverage/lcov.info'),
  resolve(repoRoot, 'shared/coverage/lcov.info'),
];

const writeArg = process.argv.find(a => a.startsWith('--write='));
const writePath = writeArg ? writeArg.slice('--write='.length) : null;

function git(...args) {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  } catch (err) {
    console.error(`git ${args.join(' ')} failed: ${err.message}`);
    return '';
  }
}

/**
 * 解析 lcov.info: 返回 map<absPath, Set<lineNumber>>
 * 只收 hits > 0 的行；DA:line,0 表示未覆盖，不进 set。
 * SF: 可能是绝对路径或相对 lcov 文件所在目录的路径；两种都规范化到 absolute。
 */
function parseLcov(lcovPath) {
  const map = new Map();
  if (!existsSync(lcovPath)) return map;
  const raw = readFileSync(lcovPath, 'utf8');
  const lcovDir = dirname(lcovPath);
  // vitest lcov 里 SF: 通常是绝对路径；但保险起见把相对路径解析到 lcov 目录
  let currentFile = null;
  let currentSet = null;
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('SF:')) {
      const p = line.slice(3).trim();
      currentFile = resolve(lcovDir, p);
      currentSet = map.get(currentFile);
      if (!currentSet) {
        currentSet = new Set();
        map.set(currentFile, currentSet);
      }
    } else if (line.startsWith('DA:')) {
      // DA:<line>,<hits>[,<checksum>]
      const [lineNum, hits] = line.slice(3).split(',');
      if (currentSet && Number(hits) > 0) {
        currentSet.add(Number(lineNum));
      }
    } else if (line === 'end_of_record') {
      currentFile = null;
      currentSet = null;
    }
  }
  return map;
}

/** 合并三包 lcov：多 map 合成一个。 */
function mergeLcov(maps) {
  const out = new Map();
  for (const m of maps) {
    for (const [file, set] of m) {
      let dst = out.get(file);
      if (!dst) {
        dst = new Set();
        out.set(file, dst);
      }
      for (const n of set) dst.add(n);
    }
  }
  return out;
}

/**
 * 解析 git diff --unified=0 输出，返回 map<relPath, Set<lineNumber>> 新增/改动行集合。
 * 只识别 +side（右侧新版本行号），diff hunk header 形如 @@ -a,b +c,d @@。
 * b=0 表示纯新增，c=起始行号, d=行数；d 缺省=1。
 */
function parseDiff(diffText) {
  const map = new Map();
  let currentFile = null;
  const lines = diffText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      // "diff --git a/path b/path" —— 取 b/ 后的路径
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      currentFile = m ? m[2] : null;
      if (currentFile && !map.has(currentFile)) map.set(currentFile, new Set());
    } else if (line.startsWith('@@')) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m && currentFile) {
        const startLine = Number(m[1]);
        const count = m[2] === undefined ? 1 : Number(m[2]);
        if (count > 0) {
          const set = map.get(currentFile);
          for (let n = startLine; n < startLine + count; n++) set.add(n);
        }
      }
    }
  }
  return map;
}

function inWhitelist(file) {
  return INCLUDE_EXT.some(ext => file.endsWith(ext));
}

/**
 * 判断某改动文件是否属于「逻辑层覆盖率」口径的可覆盖源码。
 * 必须与三包 vitest.config 的 coverage.exclude 保持一致：
 * - 排除测试/mock/类型/.d.ts
 * - server：入口 index.ts / 一次性脚本 scripts/ / DB 迁移 data/migrations/
 * - web：React 渲染/绑定层（*.tsx / components / layouts / hooks）
 */
function isCoverablePath(file) {
  if (!/^(server|web|shared)\/src\//.test(file)) return false;
  if (/\.(test|spec)\.(ts|tsx)$/.test(file)) return false;
  if (/\/__tests__\//.test(file)) return false;
  if (/\/__mocks__\//.test(file)) return false;
  if (/\/test\//.test(file)) return false;
  if (/\.d\.ts$/.test(file)) return false;
  if (/\/types\//.test(file)) return false;
  if (/^server\/src\/(index\.ts$|scripts\/|data\/migrations\/)/.test(file)) return false;
  if (/^web\/src\//.test(file)) {
    if (/\.tsx$/.test(file)) return false;
    if (/^web\/src\/(components|layouts|hooks)\//.test(file)) return false;
  }
  return true;
}

/** 折叠连续行号为 "a-b, c, d-e" 风格。 */
function foldRanges(nums) {
  if (nums.length === 0) return '';
  const sorted = [...nums].sort((a, b) => a - b);
  const out = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const n = sorted[i];
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    out.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = n;
    prev = n;
  }
  out.push(start === prev ? `${start}` : `${start}-${prev}`);
  return out.join(', ');
}

// ── 主流程 ──
git('fetch', 'origin', BASE_REF.replace(/^origin\//, ''), '--depth=100');
const diffText = git('diff', `${BASE_REF}...HEAD`, '--unified=0');
const diffMap = parseDiff(diffText);

const merged = mergeLcov(lcovPaths.map(parseLcov));

let totalChanged = 0;
let totalCovered = 0;
const perFileRows = [];
const uncoveredDetail = [];

for (const [file, changedLines] of diffMap) {
  if (!inWhitelist(file)) continue;
  if (!isCoverablePath(file)) continue;
  const absFile = resolve(repoRoot, file);
  const covSet = merged.get(absFile) || new Set();

  const changed = changedLines.size;
  if (changed === 0) continue;
  let covered = 0;
  const uncovered = [];
  for (const n of changedLines) {
    if (covSet.has(n)) covered++;
    else uncovered.push(n);
  }
  totalChanged += changed;
  totalCovered += covered;
  const pct = changed === 0 ? 100 : (covered / changed) * 100;
  perFileRows.push({ file, changed, covered, pct, uncovered });
  if (uncovered.length > 0) {
    uncoveredDetail.push({ file, ranges: foldRanges(uncovered) });
  }
}

perFileRows.sort((a, b) => a.pct - b.pct); // 覆盖率低的排前面，方便 review

const md = [];
md.push('## PR 覆盖率变化 (Diff Coverage)');
md.push('');
if (totalChanged === 0) {
  md.push('本次 PR 无可覆盖的源码改动（server/web/shared 下 .ts/.tsx，排除测试与 mock）。');
  md.push('');
} else {
  const overallPct = ((totalCovered / totalChanged) * 100).toFixed(1);
  md.push(`**改动行覆盖率**: ${overallPct}% (${totalCovered}/${totalChanged})`);
  md.push('');
  md.push('_只统计本 PR 新增或修改的行；历史存量代码不计入。_');
  md.push('');
  md.push('| 文件 | 改动行 | 已覆盖 | 覆盖率 |');
  md.push('|---|---:|---:|---:|');
  for (const row of perFileRows) {
    md.push(`| \`${row.file}\` | ${row.changed} | ${row.covered} | ${row.pct.toFixed(1)}% |`);
  }
  md.push('');
  if (uncoveredDetail.length > 0) {
    md.push('<details><summary>未覆盖行清单</summary>');
    md.push('');
    for (const item of uncoveredDetail) {
      md.push(`- \`${item.file}\`: 行 ${item.ranges}`);
    }
    md.push('');
    md.push('</details>');
    md.push('');
  }
}
md.push(`_base ref: \`${BASE_REF}\` · 观测期不设覆盖率门禁_`);

const markdown = md.join('\n');
process.stdout.write(markdown + '\n');

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + '\n');
}
if (writePath) {
  writeFileSync(writePath, markdown);
}

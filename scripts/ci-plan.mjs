#!/usr/bin/env node
// CI 门禁计划：决定一次 run 要跑哪些测试分片、是否收集覆盖率、哪些辅助门禁可以跳过。
//
// - pull_request：affected 模式。只跑受影响工作区，server/web 在纯 TS 源码改动时用
//   vitest --changed=<base> 选择相关测试，不收集覆盖率；未识别路径 fail closed 到全量。
// - push main / workflow_dispatch：full 模式。全量分片 + 覆盖率 + 全部辅助门禁，
//   这是合并后的权威门禁，也是覆盖率的唯一来源（PR 与 main 各跑一遍但内容不同，不重复）。
import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const TEST_WORKSPACES = ['shared', 'server', 'web'];
// 分片数按 push main 全量耗时定：server 366s→4 片、web 210s→2 片、shared 12s 不切。
export const SHARDS = Object.freeze({ shared: 1, server: 4, web: 2 });

// 只有仓库根目录的 Markdown 与 docs/ 才算纯文档；工作区内的 .md（如 server 的工具描述）
// 是运行时资源，必须按所属工作区的规则处理。
function isDocumentationOnly(file) {
  return (
    (file.endsWith('.md') && !file.includes('/')) ||
    file.startsWith('docs/') ||
    file.startsWith('.github/ISSUE_TEMPLATE/') ||
    file.startsWith('.github/PULL_REQUEST_TEMPLATE') ||
    file === 'LICENSE'
  );
}

// 这些路径影响所有工作区的测试或 CI 自身，直接回到 full。
function requiresFullRun(file) {
  return (
    file.startsWith('shared/') ||
    file.startsWith('scripts/') ||
    file.startsWith('.github/') ||
    file.startsWith('config/') ||
    file.startsWith('patches/') ||
    file.startsWith('workspace-shared/') ||
    file.startsWith('daemon-packaging/') ||
    file === 'package.json' ||
    file === 'pnpm-lock.yaml' ||
    file === 'pnpm-workspace.yaml' ||
    file === '.npmrc' ||
    file === 'eslint.config.mjs' ||
    file.startsWith('tsconfig')
  );
}

// vitest --changed 只能沿静态 import 图追踪。凡是可能被 fs 读取的资源、测试基建、
// 类型声明或非 TS 文件，都必须退回该工作区全量。
const NON_GRAPH_SEGMENTS = ['/fixtures/', '/__fixtures__/', '/__snapshots__/', '/__mocks__/', '/test/'];

function serverAffectedEligible(file) {
  if (!/^server\/src\/.+\.tsx?$/u.test(file) || file.endsWith('.d.ts')) return false;
  if (file.startsWith('server/src/data/') || file.startsWith('server/src/agent/descriptions/')) return false;
  return !NON_GRAPH_SEGMENTS.some((segment) => file.includes(segment));
}

function webAffectedEligible(file) {
  if (!/^web\/src\/.+\.tsx?$/u.test(file) || file.endsWith('.d.ts')) return false;
  return !NON_GRAPH_SEGMENTS.some((segment) => file.includes(segment));
}

function fullPlan(reason) {
  return {
    mode: 'full',
    tests: { shared: 'full', server: 'full', web: 'full' },
    coverage: true,
    postgres: true,
    webProduction: true,
    mobile: true,
    reasons: [reason],
  };
}

export function planCi(files, eventName = 'pull_request') {
  if (eventName !== 'pull_request') return fullPlan(`event ${eventName} always runs the full gate`);
  if (files === null) return fullPlan('changed files unavailable');

  const normalized = [...new Set(files.map((file) => file.trim()).filter(Boolean))];
  const full = normalized.find(requiresFullRun);
  if (full) return fullPlan(`${full} affects every workspace`);

  const plan = {
    mode: 'affected',
    tests: { shared: 'none', server: 'none', web: 'none' },
    coverage: false,
    postgres: false,
    webProduction: false,
    mobile: false,
    reasons: [],
  };
  const widen = (workspace, level, reason) => {
    const rank = { none: 0, affected: 1, full: 2 };
    if (rank[level] > rank[plan.tests[workspace]]) {
      plan.tests[workspace] = level;
      plan.reasons.push(reason);
    }
  };

  for (const file of normalized) {
    if (isDocumentationOnly(file)) continue;
    if (file.startsWith('server/') || file === 'config.json') {
      plan.postgres = true;
      if (file.startsWith('server/src/data/scenarios/') || file.startsWith('server/scripts/')) {
        plan.webProduction = true;
      }
      if (serverAffectedEligible(file)) widen('server', 'affected', `${file} → server affected tests`);
      else widen('server', 'full', `${file} → server full tests`);
      continue;
    }
    if (file.startsWith('web/')) {
      plan.webProduction = true;
      if (webAffectedEligible(file)) widen('web', 'affected', `${file} → web affected tests`);
      else widen('web', 'full', `${file} → web full tests`);
      continue;
    }
    if (file.startsWith('mobile/')) {
      plan.mobile = true;
      plan.reasons.push(`${file} → mobile gates`);
      continue;
    }
    return fullPlan(`${file} is not mapped to a workspace`);
  }
  if (plan.reasons.length === 0) plan.reasons.push('documentation-only change');
  return plan;
}

// GitHub Actions 的空矩阵不会产生稳定的 needs 结果；none 只创建一个无步骤的成功 Job。
export function testMatrix(plan) {
  const entries = [];
  for (const workspace of TEST_WORKSPACES) {
    const mode = plan.tests[workspace];
    if (mode === 'none') continue;
    const total = SHARDS[workspace];
    for (let shard = 1; shard <= total; shard += 1) entries.push({ workspace, shard, total, mode });
  }
  return entries.length > 0 ? entries : [{ workspace: 'none', shard: 1, total: 1, mode: 'none' }];
}

function changedFiles(baseSha, headSha) {
  if (!baseSha || !headSha) {
    process.stderr.write('ci plan: missing base/head SHA, falling back to the full gate\n');
    return null;
  }
  try {
    const output = execFileSync('git', ['diff', '--name-only', `${baseSha}...${headSha}`], {
      cwd: resolve(fileURLToPath(new URL('..', import.meta.url))),
      encoding: 'utf8',
    });
    return output.split(/\r?\n/u).filter(Boolean);
  } catch (error) {
    process.stderr.write(`ci plan: git diff failed, falling back to the full gate: ${error.message}\n`);
    return null;
  }
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function main() {
  const eventName = argument('--event') || 'pull_request';
  const baseSha = argument('--base') || '';
  const files = eventName === 'pull_request' ? changedFiles(baseSha, argument('--head')) : [];
  const plan = planCi(files, eventName);
  const matrix = testMatrix(plan);
  const outputs = {
    mode: plan.mode,
    coverage: String(plan.coverage),
    postgres: String(plan.postgres),
    web_production: String(plan.webProduction),
    mobile: String(plan.mobile),
    changed_base: plan.mode === 'affected' ? baseSha : '',
    test_matrix: JSON.stringify(matrix),
  };
  for (const [key, value] of Object.entries(outputs)) process.stdout.write(`${key}=${value}\n`);
  process.stdout.write(`reasons:\n${plan.reasons.map((reason) => `  - ${reason}\n`).join('')}`);
  const output = argument('--output');
  if (output) {
    appendFileSync(output, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''));
  }
  const summary = argument('--summary');
  if (summary) {
    appendFileSync(
      summary,
      [
        '### CI plan',
        '',
        `- mode: \`${plan.mode}\``,
        `- tests: ${TEST_WORKSPACES.map((ws) => `${ws}=\`${plan.tests[ws]}\``).join(', ')}`,
        `- coverage: \`${plan.coverage}\` · postgres: \`${plan.postgres}\` · web production: \`${plan.webProduction}\` · mobile: \`${plan.mobile}\``,
        ...plan.reasons.slice(0, 20).map((reason) => `- ${reason}`),
        '',
      ].join('\n'),
    );
  }
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (entry === import.meta.url) main();

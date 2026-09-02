#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ALL_WORKSPACES = ['shared', 'server', 'web'];

function isDocumentationOnly(file) {
  return (
    file.endsWith('.md') ||
    file.startsWith('docs/') ||
    file.startsWith('.github/ISSUE_TEMPLATE/') ||
    file.startsWith('.github/PULL_REQUEST_TEMPLATE') ||
    file.startsWith('mobile/')
  );
}

function requiresAllCoverage(file) {
  return (
    file.startsWith('shared/') ||
    file.startsWith('scripts/') ||
    file.startsWith('.github/workflows/') ||
    file === 'package.json' ||
    file === 'pnpm-lock.yaml' ||
    file === 'pnpm-workspace.yaml' ||
    file.startsWith('tsconfig')
  );
}

/**
 * PR 只运行受影响工作区的覆盖率；push/main 与手动运行始终保留全量门禁。
 * 未识别路径 fail closed 到全量，避免新增目录静默绕过覆盖率。
 */
export function planCoverageWorkspaces(files, eventName = 'pull_request') {
  if (eventName !== 'pull_request') return [...ALL_WORKSPACES];

  const normalized = [...new Set(files.map((file) => file.trim()).filter(Boolean))];
  if (normalized.some(requiresAllCoverage)) return [...ALL_WORKSPACES];

  const selected = new Set();
  for (const file of normalized) {
    if (file.startsWith('server/') || file === 'config.json') selected.add('server');
    else if (file.startsWith('web/')) selected.add('web');
    else if (!isDocumentationOnly(file)) return [...ALL_WORKSPACES];
  }

  // GitHub Actions 的空矩阵不会产生稳定的 needs 结果；none 仅创建一个无步骤的成功 Job。
  return selected.size > 0
    ? ALL_WORKSPACES.filter((workspace) => selected.has(workspace))
    : ['none'];
}

function changedFiles(baseSha, headSha) {
  if (!baseSha || !headSha) {
    process.stderr.write('coverage scope: missing base/head SHA, falling back to all workspaces\n');
    return null;
  }
  try {
    const output = execFileSync('git', ['diff', '--name-only', `${baseSha}...${headSha}`], {
      cwd: resolve(fileURLToPath(new URL('..', import.meta.url))),
      encoding: 'utf8',
    });
    return output.split(/\r?\n/u).filter(Boolean);
  } catch (error) {
    process.stderr.write(
      `coverage scope: git diff failed, falling back to all workspaces: ${error.message}\n`,
    );
    return null;
  }
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function main() {
  const eventName = argument('--event') || 'pull_request';
  const files =
    eventName === 'pull_request' ? changedFiles(argument('--base'), argument('--head')) : [];
  const workspaces =
    files === null ? [...ALL_WORKSPACES] : planCoverageWorkspaces(files, eventName);
  const json = JSON.stringify(workspaces);
  process.stdout.write(`coverage workspaces: ${json}\n`);
  const output = argument('--output');
  if (output) appendFileSync(output, `workspaces=${json}\n`);
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (entry === import.meta.url) main();

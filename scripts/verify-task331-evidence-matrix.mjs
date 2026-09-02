import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const documentPath = 'docs/TASK-331-移动端V1证据矩阵.md';
const verifierPath = 'scripts/verify-task331-evidence-matrix.mjs';
const document = readFileSync(documentPath, 'utf8');
const expectedTaskIds = [
  'M00-01', 'M00-02', 'M00-03',
  'M10-01', 'M10-02', 'M10-03', 'M10-04', 'M10-05',
  'M20-01', 'M20-02', 'M20-03', 'M20-04', 'M20-05', 'M20-06', 'M20-07',
  'M30-01', 'M30-02', 'M30-03',
  'M40-01', 'M40-02', 'M40-03', 'M40-04', 'M40-05',
  'M50-01', 'M50-02', 'M50-03', 'M50-04', 'M50-05',
  'M60-01', 'M60-02', 'M60-03', 'M60-04', 'M60-05',
  'M70-01', 'M70-02', 'M70-03',
];
const taskLines = document.split('\n').filter((line) => /^\| M\d{2}-\d{2} \|/u.test(line));
const taskRows = taskLines.map((line) => line.match(/^\| (M\d{2}-\d{2}) \|/u)?.[1]);
if (JSON.stringify(taskRows) !== JSON.stringify(expectedTaskIds)) {
  throw new Error(`TASK-331 evidence matrix ID set/order differs from the authoritative 36 IDs: ${taskRows.join(',')}`);
}
if (document.includes('mobile/src/app/')) {
  throw new Error('TASK-331 evidence matrix still references removed mobile/src/app paths');
}

const allowedStatuses = new Set(['通过', '部分', 'blocked']);
const missingPaths = [];
for (const line of taskLines) {
  const columns = line.split('|').map((value) => value.trim());
  if (!allowedStatuses.has(columns[6])) {
    throw new Error(`TASK-331 evidence row ${columns[1]} has an invalid code status: ${columns[6]}`);
  }
  const evidenceColumn = columns[4];
  for (const match of evidenceColumn.matchAll(/`([^`]+)`/gu)) {
    const reference = match[1];
    const path = reference.replace(/:\d+(?:-\d+)?$/u, '');
    if (!/^(?:\.github|docs|mobile|scripts|server|shared|web)\//u.test(path)) continue;
    if (/[*{}]/u.test(path) || evidenceColumn.includes(`已删除 \`${reference}\``)) continue;
    if (!existsSync(path)) missingPaths.push(`${columns[1]}:${path}`);
  }
}
if (missingPaths.length > 0) {
  throw new Error(`TASK-331 evidence matrix references missing evidence paths: ${missingPaths.join(', ')}`);
}

for (const required of [
  '共 **1,695** 项（Shared Vitest 1,301；Mobile Vitest 195；Mobile Node 199）',
  'Shared 100 files / 1,301 tests',
  'Mobile Vitest 42 files / 195 tests',
  'Mobile Node 199 tests',
]) {
  if (!document.includes(required)) throw new Error(`TASK-331 evidence matrix has stale test totals; missing: ${required}`);
}

const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const metadata = document.match(/审计代码基线：当前 `HEAD`（由 verifier 解析）；当前 `origin\/main`：`([0-9a-f]{40})`/u);
if (!metadata) throw new Error('TASK-331 evidence matrix must bind its audit baseline to current HEAD');
const auditBase = metadata[1];
execFileSync('git', ['merge-base', '--is-ancestor', auditBase, head], { stdio: 'ignore' });

const expectedLedger = execFileSync('git', ['rev-list', '--reverse', `${auditBase}..${head}`], { encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter(Boolean);
const ledgerTokens = [...document.matchAll(/^\| \d+ \| `([0-9a-f]{40}|HEAD)` \|/gmu)].map((match) => match[1]);
if (ledgerTokens.at(-1) !== 'HEAD' || ledgerTokens.slice(0, -1).includes('HEAD')) {
  throw new Error('TASK-331 commit ledger must use symbolic HEAD exactly once in its final self-referential row');
}
const ledger = ledgerTokens.map((token) => token === 'HEAD' ? head : token);
if (ledger.length !== expectedLedger.length || ledger.some((sha, index) => sha !== expectedLedger[index])) {
  throw new Error(`TASK-331 commit ledger does not exactly match ${auditBase}..HEAD: ${ledger.length}/${expectedLedger.length}`);
}

const changedAtHead = execFileSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], { encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter(Boolean);
if (!changedAtHead.includes(documentPath) || !changedAtHead.includes(verifierPath)
  || changedAtHead.some((path) => path !== documentPath && path !== verifierPath)) {
  throw new Error(`TASK-331 symbolic HEAD row must be the evidence-only commit; found: ${changedAtHead.join(', ')}`);
}

const fullShas = [...new Set(document.match(/\b[0-9a-f]{40}\b/gu) ?? [])];
const unreachable = fullShas.filter((sha) => {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, head], { stdio: 'ignore' });
    return false;
  } catch {
    return true;
  }
});
if (unreachable.length > 0) {
  throw new Error(`TASK-331 evidence matrix contains unreachable commit SHA(s): ${unreachable.join(', ')}`);
}

console.log(`Verified TASK-331 evidence matrix at ${head}: ${taskRows.length} authoritative IDs, ${ledger.length} HEAD-bound commits, ${fullShas.length} reachable full SHAs`);

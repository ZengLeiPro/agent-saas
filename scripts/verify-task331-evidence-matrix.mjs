import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const documentPath = 'docs/TASK-331-移动端V1证据矩阵.md';
const document = readFileSync(documentPath, 'utf8');
const taskRows = [...document.matchAll(/^\| (M\d{2}-\d{2}) \|/gm)].map((match) => match[1]);
const uniqueTaskIds = new Set(taskRows);
if (taskRows.length !== 36 || uniqueTaskIds.size !== 36) {
  throw new Error(`TASK-331 evidence matrix must contain 36 unique ID rows; found ${taskRows.length}/${uniqueTaskIds.size}`);
}
if (document.includes('mobile/src/app/')) {
  throw new Error('TASK-331 evidence matrix still references removed mobile/src/app paths');
}

const shas = [...new Set(document.match(/\b[0-9a-f]{40}\b/g) ?? [])];
const unreachable = shas.filter((sha) => {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { stdio: 'ignore' });
    return false;
  } catch {
    return true;
  }
});
if (unreachable.length > 0) {
  throw new Error(`TASK-331 evidence matrix contains unreachable commit SHA(s): ${unreachable.join(', ')}`);
}

const metadata = document.match(/审计代码基线（证据文档提交前）：`([0-9a-f]{40})`；当前 `origin\/main`：`([0-9a-f]{40})`/);
if (!metadata) throw new Error('TASK-331 evidence matrix is missing its full audit head/base metadata');
const [, auditHead, auditBase] = metadata;
const expectedLedger = execFileSync('git', ['rev-list', '--reverse', `${auditBase}..${auditHead}`], { encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter(Boolean);
const ledger = [...document.matchAll(/^\| \d+ \| `([0-9a-f]{40})` \|/gm)].map((match) => match[1]);
if (ledger.length !== expectedLedger.length || ledger.some((sha, index) => sha !== expectedLedger[index])) {
  throw new Error(`TASK-331 commit ledger does not exactly match ${auditBase}..${auditHead}: ${ledger.length}/${expectedLedger.length}`);
}

console.log(`Verified TASK-331 evidence matrix: ${taskRows.length} IDs, ${ledger.length} task commits, ${shas.length} reachable full SHAs`);

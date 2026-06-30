#!/usr/bin/env tsx
/**
 * Runtime chaos 发布前门禁 runner（2026-06-22）。
 *
 * 串行跑全部 chaos mode（每个 mode 是一个独立子进程，互不污染），收集每个 mode 的
 * 通过/失败/耗时/输出尾巴，产出可追溯报告（JSON + Markdown），并以退出码表达门禁结论：
 *   - 全部通过 → exit 0（允许发版）
 *   - 任一失败 → exit 1（禁止发版）
 *
 * 与 `verify-runtime-chaos.mts --mode=all` 的区别：那个是 fail-fast（第一个失败就停，
 * 不跑完），且只有 console.log 没有结构化报告。门禁需要"跑完所有 mode + 完整报告"，
 * 所以单独做这个聚合层。
 *
 * 用法：
 *   tsx scripts/chaos-gate.mts                      # 跑全部 mode
 *   tsx scripts/chaos-gate.mts --modes a,b,c        # 只跑指定 mode
 *   tsx scripts/chaos-gate.mts --bail               # 第一个失败即停（默认跑完）
 *   tsx scripts/chaos-gate.mts --timeout-ms 240000  # 单 mode 超时（默认 240s）
 *   tsx scripts/chaos-gate.mts --out <dir>          # 报告输出目录（默认 server/.chaos-reports）
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';

const execFile = promisify(execFileCb);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CHAOS_SCRIPT = join(SCRIPT_DIR, 'verify-runtime-chaos.mts');
const SERVER_DIR = join(SCRIPT_DIR, '..');

const ALL_MODES = [
  'hand-cancel',
  'hand-kill',
  'server-restart',
  'network-interrupt',
  'multi-worker',
  'ask-user-resume',
  'client-daemon',
  'daemon-network',
  'renew-failure',
  'abort-states',
  'notify-drop',
  'db-unavailable',
];

// 需要临时 PG docker 容器的 mode（用于启动期 docker / 镜像预检）。
const PG_MODES = new Set([
  'server-restart', 'multi-worker', 'ask-user-resume',
  'renew-failure', 'abort-states', 'notify-drop', 'db-unavailable',
]);
const POSTGRES_IMAGE = 'postgres:16-alpine';

interface ModeResult {
  mode: string;
  ok: boolean;
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  okLines: string[];
  tail: string;
}

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx >= 0) return process.argv[idx + 1];
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function dockerReady(): Promise<{ ok: boolean; reason?: string }> {
  try {
    await execFile('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 10_000 });
  } catch {
    return { ok: false, reason: 'docker 不可用（PG mode 需要 docker）' };
  }
  try {
    await execFile('docker', ['image', 'inspect', POSTGRES_IMAGE], { timeout: 10_000 });
  } catch {
    return { ok: false, reason: `本地缺少镜像 ${POSTGRES_IMAGE}（chaos 用 --pull=never，CI 需先 docker pull）` };
  }
  return { ok: true };
}

function runMode(mode: string, timeoutMs: number): Promise<ModeResult> {
  const start = Date.now();
  return new Promise<ModeResult>((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CHAOS_SCRIPT, `--mode=${mode}`], {
      cwd: SERVER_DIR,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(timer);
      const okLines = stdout.split('\n').filter((line) => line.includes('[ok]')).map((line) => line.trim());
      const combined = stdout + (stderr ? `\n[stderr]\n${stderr}` : '');
      resolve({
        mode,
        ok: exitCode === 0 && !timedOut,
        durationMs: Date.now() - start,
        exitCode,
        signal,
        timedOut,
        okLines,
        tail: combined.split('\n').slice(-40).join('\n').trim(),
      });
    };
    child.on('exit', (code, signal) => finish(code, signal));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        mode, ok: false, durationMs: Date.now() - start, exitCode: null, signal: null,
        timedOut, okLines: [], tail: `spawn error: ${err instanceof Error ? err.message : String(err)}`,
      });
    });
  });
}

function fmtDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function buildMarkdown(report: {
  startedAt: string; finishedAt: string; durationMs: number; gate: string;
  total: number; passed: number; failed: number;
  host: { node: string; platform: string };
  results: ModeResult[];
}): string {
  const lines: string[] = [];
  lines.push(`# Runtime Chaos 发布前门禁报告`);
  lines.push('');
  lines.push(`- 门禁结论：**${report.gate === 'pass' ? '✅ PASS（允许发版）' : '❌ FAIL（禁止发版）'}**`);
  lines.push(`- 通过 / 总数：${report.passed} / ${report.total}（失败 ${report.failed}）`);
  lines.push(`- 开始：${report.startedAt}`);
  lines.push(`- 结束：${report.finishedAt}`);
  lines.push(`- 总耗时：${fmtDuration(report.durationMs)}`);
  lines.push(`- 环境：node ${report.host.node} / ${report.host.platform}`);
  lines.push('');
  lines.push(`| Mode | 结果 | 耗时 | 退出码 | 断言通过条数 |`);
  lines.push(`|---|---|---|---|---|`);
  for (const r of report.results) {
    const status = r.ok ? '✅ pass' : (r.timedOut ? '⏱ timeout' : '❌ fail');
    const exit = r.timedOut ? 'SIGKILL' : (r.signal ? `signal ${r.signal}` : String(r.exitCode));
    lines.push(`| \`${r.mode}\` | ${status} | ${fmtDuration(r.durationMs)} | ${exit} | ${r.okLines.length} |`);
  }
  lines.push('');
  const failures = report.results.filter((r) => !r.ok);
  if (failures.length > 0) {
    lines.push(`## 失败详情`);
    lines.push('');
    for (const r of failures) {
      lines.push(`### \`${r.mode}\`${r.timedOut ? '（超时）' : ''}`);
      lines.push('');
      lines.push('```');
      lines.push(r.tail || '(无输出)');
      lines.push('```');
      lines.push('');
    }
  }
  lines.push(`## 通过断言明细`);
  lines.push('');
  for (const r of report.results.filter((x) => x.ok)) {
    lines.push(`- \`${r.mode}\`：`);
    for (const ok of r.okLines.filter((l) => l.includes('chaos'))) {
      lines.push(`  - ${ok.replace(/^\[ok\]\s*/, '')}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const modesArg = argValue('--modes');
  const modes = modesArg ? modesArg.split(',').map((m) => m.trim()).filter(Boolean) : ALL_MODES;
  const timeoutMs = Number(argValue('--timeout-ms') ?? '240000');
  const bail = hasFlag('--bail');
  const outDir = argValue('--out') ?? join(SERVER_DIR, '.chaos-reports');

  const unknown = modes.filter((m) => !ALL_MODES.includes(m));
  if (unknown.length > 0) {
    console.error(`[chaos-gate] 未知 mode: ${unknown.join(', ')}`);
    console.error(`[chaos-gate] 可用 mode: ${ALL_MODES.join(', ')}`);
    process.exit(2);
  }

  if (modes.some((m) => PG_MODES.has(m))) {
    const ready = await dockerReady();
    if (!ready.ok) {
      console.error(`[chaos-gate] 前置检查失败：${ready.reason}`);
      process.exit(2);
    }
  }

  const startedAt = new Date();
  console.log(`[chaos-gate] 开始：${modes.length} 个 mode，单 mode 超时 ${fmtDuration(timeoutMs)}${bail ? '，--bail' : ''}`);
  console.log(`[chaos-gate] modes: ${modes.join(', ')}`);

  const results: ModeResult[] = [];
  for (const mode of modes) {
    process.stdout.write(`[chaos-gate] ▶ ${mode} ... `);
    const result = await runMode(mode, timeoutMs);
    results.push(result);
    console.log(result.ok ? `✅ ${fmtDuration(result.durationMs)}` : `❌ ${result.timedOut ? 'timeout' : `exit ${result.exitCode}`} ${fmtDuration(result.durationMs)}`);
    if (!result.ok && bail) {
      console.log(`[chaos-gate] --bail：${mode} 失败，停止后续 mode`);
      break;
    }
  }

  const finishedAt = new Date();
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  const skipped = modes.length - results.length;
  const gate = failed === 0 && skipped === 0 ? 'pass' : 'fail';

  const report = {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    gate,
    total: modes.length,
    passed,
    failed,
    skipped,
    host: { node: process.version, platform: `${process.platform}-${process.arch}` },
    results,
  };

  await mkdir(outDir, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const jsonPath = join(outDir, `chaos-gate-${stamp}.json`);
  const mdPath = join(outDir, `chaos-gate-${stamp}.md`);
  const markdown = buildMarkdown(report);
  await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf-8');
  await writeFile(mdPath, markdown, 'utf-8');
  await writeFile(join(outDir, 'latest.json'), JSON.stringify(report, null, 2), 'utf-8');
  await writeFile(join(outDir, 'latest.md'), markdown, 'utf-8');

  console.log('');
  console.log(`[chaos-gate] 结论：${gate === 'pass' ? '✅ PASS（允许发版）' : '❌ FAIL（禁止发版）'}  通过 ${passed}/${modes.length}`);
  console.log(`[chaos-gate] 报告：${mdPath}`);
  console.log(`[chaos-gate]       ${jsonPath}`);
  process.exit(gate === 'pass' ? 0 : 1);
}

main().catch((err) => {
  console.error('[chaos-gate] 运行器异常：', err);
  process.exit(1);
});

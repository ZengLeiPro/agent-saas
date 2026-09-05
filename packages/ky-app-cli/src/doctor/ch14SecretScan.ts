/** §9.3-14：密钥扫描 —— 项目目录内无 `.env` 真值、无私钥 PEM、无 `Bearer ` 字面量。 */
import { assert } from '../harness/http.js';
import { formatFindings, scanSecrets } from '../secretScan.js';
import type { DoctorContext } from './context.js';

export async function chapter14(ctx: DoctorContext): Promise<void> {
  const reporter = ctx.reporter;
  reporter.section(14);

  const findings = await scanSecrets(ctx.projectDir);

  await reporter.check('项目目录内没有 .env 真值文件（只允许 .env.example）', () => {
    const hits = findings.filter((finding) => finding.rule === 'env_value');
    assert(hits.length === 0, `命中 ${String(hits.length)} 处：\n${formatFindings(hits)}`);
  });

  await reporter.check('项目目录内没有私钥 PEM', () => {
    const hits = findings.filter((finding) => finding.rule === 'private_key');
    assert(hits.length === 0, `命中 ${String(hits.length)} 处：\n${formatFindings(hits)}`);
  });

  await reporter.check('项目源码里没有 `Bearer ` 字面量', () => {
    const hits = findings.filter((finding) => finding.rule === 'bearer_literal');
    assert(hits.length === 0, `命中 ${String(hits.length)} 处：\n${formatFindings(hits)}`);
  });

  await reporter.check('.gitignore 覆盖 .env 与构建产物', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    let text = '';
    try {
      text = await readFile(join(ctx.projectDir, '.gitignore'), 'utf8');
    } catch {
      throw new Error('项目根没有 .gitignore');
    }
    for (const entry of ['.env', 'node_modules', 'dist']) {
      assert(text.includes(entry), `.gitignore 里缺少 ${entry}`);
    }
  });

  await reporter.check('项目自带 pre-commit 密钥扫描脚本', async () => {
    const { access } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await access(join(ctx.projectDir, 'scripts', 'secret-scan.mjs')).catch(() => {
      throw new Error('缺少 scripts/secret-scan.mjs');
    });
  });
}

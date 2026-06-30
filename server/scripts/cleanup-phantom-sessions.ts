/**
 * 清理 title-generator 产生的幽灵 transcript 文件
 *
 * 历史问题：title-generator 可能写入首行为 `{"type":"ai-title",...}` 的
 * 小 jsonl。这些文件没有 user/assistant 消息，会被会话列表误判为「新对话」。
 *
 * 本脚本递归扫描 Agent SaaS transcript root，删除首行为 `"type":"ai-title"`
 * 的 jsonl 及其同名 .meta.json 和 sidecar 目录。
 *
 * 用法：
 *   tsx scripts/cleanup-phantom-sessions.ts         # dry-run（只报告）
 *   tsx scripts/cleanup-phantom-sessions.ts --apply # 真正删除
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { AGENT_LEGACY_TRANSCRIPTS_ROOT } from '../src/data/transcripts/projectKey.js';

const ROOT = process.env.AGENT_TRANSCRIPTS_ROOT || AGENT_LEGACY_TRANSCRIPTS_ROOT;

interface PhantomFile {
  bucket: string;
  sessionId: string;
  jsonlPath: string;
  metaPath: string;
  sidecarDir: string;
  hasSidecar: boolean;
  hasMeta: boolean;
  firstLine: string;
}

async function readFirstLine(fullPath: string): Promise<string | null> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(fullPath, 'r');
    const buf = Buffer.alloc(1024);
    const { bytesRead } = await handle.read(buf, 0, 1024, 0);
    if (bytesRead === 0) return null;
    const text = buf.slice(0, bytesRead).toString('utf-8');
    const nl = text.indexOf('\n');
    return nl === -1 ? text : text.slice(0, nl);
  } catch {
    return null;
  } finally {
    if (handle) await handle.close().catch(() => { /* noop */ });
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function scanDir(dir: string): Promise<PhantomFile[]> {
  const found: PhantomFile[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      found.push(...await scanDir(full));
      continue;
    }
    if (!ent.isFile() || !ent.name.endsWith('.jsonl')) continue;
    const sessionId = ent.name.replace(/\.jsonl$/, '');
    const jsonlPath = full;
    const stat = await fs.stat(jsonlPath).catch(() => null);
    if (!stat) continue;
    // 真实对话 transcript 至少有系统初始化行 + 用户消息，通常 > 4KB
    if (stat.size >= 4096) continue;

    const firstLine = await readFirstLine(jsonlPath);
    if (!firstLine || !firstLine.includes('"type":"ai-title"')) continue;

    const metaPath = path.join(dir, `${sessionId}.meta.json`);
    const sidecarDir = path.join(dir, sessionId);

    found.push({
      bucket: path.relative(ROOT, dir) || '.',
      sessionId,
      jsonlPath,
      metaPath,
      sidecarDir,
      hasMeta: await exists(metaPath),
      hasSidecar: await exists(sidecarDir),
      firstLine: firstLine.slice(0, 200),
    });
  }
  return found;
}

async function main() {
  const apply = process.argv.includes('--apply');
  console.log(`递归扫描 transcript root: ${ROOT}\n`);
  const all = await scanDir(ROOT);

  console.log(`\n总计发现幽灵文件: ${all.length}`);
  const withMeta = all.filter(f => f.hasMeta).length;
  const withSidecar = all.filter(f => f.hasSidecar).length;
  console.log(`  其中有 meta: ${withMeta}`);
  console.log(`  其中有 sidecar 目录: ${withSidecar}`);

  if (all.length === 0) {
    console.log('\n无需清理。');
    return;
  }

  if (!apply) {
    console.log('\n前 5 个样本：');
    for (const f of all.slice(0, 5)) {
      console.log(`  - ${f.bucket}/${f.sessionId}.jsonl`);
      console.log(`    firstLine: ${f.firstLine}`);
    }
    console.log('\nDry-run 模式，未实际删除。加 --apply 参数真正执行。');
    return;
  }

  console.log('\n开始删除...');
  let deletedJsonl = 0, deletedMeta = 0, deletedSidecar = 0, errors = 0;
  for (const f of all) {
    try {
      await fs.unlink(f.jsonlPath);
      deletedJsonl++;
    } catch (e) {
      console.error(`  ✗ 删除 ${f.jsonlPath} 失败: ${e}`);
      errors++;
    }
    if (f.hasMeta) {
      try {
        await fs.unlink(f.metaPath);
        deletedMeta++;
      } catch (e) {
        console.error(`  ✗ 删除 ${f.metaPath} 失败: ${e}`);
        errors++;
      }
    }
    if (f.hasSidecar) {
      try {
        await fs.rm(f.sidecarDir, { recursive: true, force: true });
        deletedSidecar++;
      } catch (e) {
        console.error(`  ✗ 删除 ${f.sidecarDir} 失败: ${e}`);
        errors++;
      }
    }
  }
  console.log(`\n完成。删除 jsonl=${deletedJsonl} meta=${deletedMeta} sidecar=${deletedSidecar} errors=${errors}`);
}

main().catch(err => {
  console.error('脚本异常：', err);
  process.exit(1);
});

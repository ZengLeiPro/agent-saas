import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * skills 内容指纹（2026-07-15 零停机部署批次）。
 *
 * 用途：启动时判断「skill 文件内容是否随新 release 变化」。指纹变化 →
 * SkillConfigStore.setPoolContentHashSync 落盘新指纹并 bump configVersion，
 * 由 SkillMaterializationService（启动后台 reconcile + Agent/Cron preflight）
 * 把变更异步物化到各用户 workspace。取代旧的「启动无条件全量 syncSkills」，
 * 让 no-op 重启/部署不再触发全用户复制风暴。
 *
 * 两类来源采用不同的取证策略：
 * - pool 与共享 scripts（随 release 打包，每次部署 checkout/tar 后 mtime 必变）：
 *   相对路径 + 文件内容 sha256——与 mtime 无关，同内容跨 release 稳定。
 *   pool 内是 SKILL.md/脚本等小文件，且位于本地盘，全量读代价可忽略。
 * - 租户自有 skill 目录（位于共享数据盘，不随 release 重建，mtime 稳定，
 *   可能含较大参考文件）：相对路径 + size + mtimeMs——避免每次启动在
 *   NAS 上全量读大文件。
 *
 * 遍历排序确定性；跳过 __pycache__ / .DS_Store / node_modules（与
 * syncSkills 的复制过滤一致）及 pool 顶层 `_`/`.` 开头条目（与
 * syncSkills 的 pool 扫描规则一致）。单个文件读取失败以 `!ERR` 记号
 * 入摘要（不中断启动），修复后指纹自然变化触发一次同步。
 */

const SKIPPED_NAMES = new Set(['__pycache__', '.DS_Store', 'node_modules']);

function listSortedEntries(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => !SKIPPED_NAMES.has(name)).sort();
  } catch {
    return [];
  }
}

function digestTreeByContent(hash: ReturnType<typeof createHash>, dir: string, prefix: string): void {
  for (const name of listSortedEntries(dir)) {
    const full = join(dir, name);
    const rel = `${prefix}/${name}`;
    let stat;
    try {
      stat = statSync(full);
    } catch {
      hash.update(`${rel}!ERR\n`);
      continue;
    }
    if (stat.isDirectory()) {
      hash.update(`${rel}/\n`);
      digestTreeByContent(hash, full, rel);
    } else if (stat.isFile()) {
      try {
        const content = readFileSync(full);
        const contentHash = createHash('sha256').update(content).digest('hex');
        hash.update(`${rel}#${contentHash}\n`);
      } catch {
        hash.update(`${rel}!ERR\n`);
      }
    }
  }
}

function digestTreeByStat(hash: ReturnType<typeof createHash>, dir: string, prefix: string): void {
  for (const name of listSortedEntries(dir)) {
    const full = join(dir, name);
    const rel = `${prefix}/${name}`;
    let stat;
    try {
      stat = statSync(full);
    } catch {
      hash.update(`${rel}!ERR\n`);
      continue;
    }
    if (stat.isDirectory()) {
      hash.update(`${rel}/\n`);
      digestTreeByStat(hash, full, rel);
    } else if (stat.isFile()) {
      hash.update(`${rel}@${stat.size}:${Math.floor(stat.mtimeMs)}\n`);
    }
  }
}

async function listSortedEntriesAsync(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => !SKIPPED_NAMES.has(name)).sort();
  } catch {
    return [];
  }
}

async function digestTreeByContentAsync(
  hash: ReturnType<typeof createHash>,
  dir: string,
  prefix: string,
): Promise<void> {
  for (const name of await listSortedEntriesAsync(dir)) {
    const full = join(dir, name);
    const rel = `${prefix}/${name}`;
    const info = await stat(full).catch(() => null);
    if (!info) {
      hash.update(`${rel}!ERR\n`);
      continue;
    }
    if (info.isDirectory()) {
      hash.update(`${rel}/\n`);
      await digestTreeByContentAsync(hash, full, rel);
    } else if (info.isFile()) {
      try {
        const contentHash = createHash('sha256')
          .update(await readFile(full))
          .digest('hex');
        hash.update(`${rel}#${contentHash}\n`);
      } catch {
        hash.update(`${rel}!ERR\n`);
      }
    }
  }
}

async function digestTreeByStatAsync(
  hash: ReturnType<typeof createHash>,
  dir: string,
  prefix: string,
): Promise<void> {
  for (const name of await listSortedEntriesAsync(dir)) {
    const full = join(dir, name);
    const rel = `${prefix}/${name}`;
    const info = await stat(full).catch(() => null);
    if (!info) {
      hash.update(`${rel}!ERR\n`);
      continue;
    }
    if (info.isDirectory()) {
      hash.update(`${rel}/\n`);
      await digestTreeByStatAsync(hash, full, rel);
    } else if (info.isFile()) {
      hash.update(`${rel}@${info.size}:${Math.floor(info.mtimeMs)}\n`);
    }
  }
}

export function computeSkillsContentFingerprint(
  poolDir: string,
  tenantSkillsRootDir?: string,
  scriptsDir?: string,
): string {
  const hash = createHash('sha256');

  if (existsSync(poolDir)) {
    for (const name of listSortedEntries(poolDir)) {
      // 与 syncSkills 的 pool 顶层扫描一致：跳过 `_manifest.json` 等 _/. 开头条目
      if (name.startsWith('_') || name.startsWith('.')) continue;
      const full = join(poolDir, name);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      hash.update(`pool/${name}/\n`);
      digestTreeByContent(hash, full, `pool/${name}`);
    }
  }

  if (tenantSkillsRootDir && existsSync(tenantSkillsRootDir)) {
    for (const tenant of listSortedEntries(tenantSkillsRootDir)) {
      if (tenant.startsWith('.')) continue;
      const tenantDir = join(tenantSkillsRootDir, tenant);
      let isDir = false;
      try {
        isDir = statSync(tenantDir).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      hash.update(`tenant/${tenant}/\n`);
      digestTreeByStat(hash, tenantDir, `tenant/${tenant}`);
    }
  }

  if (scriptsDir && existsSync(scriptsDir)) {
    hash.update('scripts/\n');
    digestTreeByContent(hash, scriptsDir, 'scripts');
  }

  return hash.digest('hex');
}

/**
 * 与 computeSkillsContentFingerprint 完全同口径的非阻塞版本。生产启动/warmup
 * 必须使用此函数，避免 NAS 元数据或文件读取把 HTTP 事件循环一起卡住。
 */
export async function computeSkillsContentFingerprintAsync(
  poolDir: string,
  tenantSkillsRootDir?: string,
  scriptsDir?: string,
): Promise<string> {
  const hash = createHash('sha256');

  for (const name of await listSortedEntriesAsync(poolDir)) {
    if (name.startsWith('_') || name.startsWith('.')) continue;
    const full = join(poolDir, name);
    if (!(await stat(full).catch(() => null))?.isDirectory()) continue;
    hash.update(`pool/${name}/\n`);
    await digestTreeByContentAsync(hash, full, `pool/${name}`);
  }

  if (tenantSkillsRootDir) {
    for (const tenant of await listSortedEntriesAsync(tenantSkillsRootDir)) {
      if (tenant.startsWith('.')) continue;
      const tenantDir = join(tenantSkillsRootDir, tenant);
      if (!(await stat(tenantDir).catch(() => null))?.isDirectory()) continue;
      hash.update(`tenant/${tenant}/\n`);
      await digestTreeByStatAsync(hash, tenantDir, `tenant/${tenant}`);
    }
  }

  if (scriptsDir && (await stat(scriptsDir).catch(() => null))?.isDirectory()) {
    hash.update('scripts/\n');
    await digestTreeByContentAsync(hash, scriptsDir, 'scripts');
  }

  return hash.digest('hex');
}

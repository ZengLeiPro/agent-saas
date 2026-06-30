/**
 * 文件轮转工具
 *
 * 当文件大小超过阈值时，重命名为带时间戳的归档文件，并清理旧归档。
 */

import { stat, rename, readdir, unlink } from 'fs/promises';
import { dirname, basename, join } from 'path';

export interface RotationOptions {
  /** 文件大小阈值（字节），默认 10MB */
  maxSizeBytes: number;
  /** 保留的归档文件数量，默认 5 */
  maxFiles: number;
}

/**
 * 检查文件是否超过大小阈值，超过则轮转。
 *
 * 轮转逻辑：将当前文件 rename 为 `{base}-{timestamp}.jsonl`，
 * 然后清理超过 maxFiles 限制的旧归档文件。
 *
 * @returns true 如果发生了轮转
 */
export async function rotateIfNeeded(
  filePath: string,
  options: RotationOptions,
): Promise<boolean> {
  try {
    const stats = await stat(filePath);
    if (stats.size < options.maxSizeBytes) return false;

    const dir = dirname(filePath);
    const ext = '.jsonl';
    const base = basename(filePath, ext);
    const rotatedName = `${base}-${Date.now()}${ext}`;
    await rename(filePath, join(dir, rotatedName));

    // 清理旧归档
    if (options.maxFiles >= 0) {
      const files = await readdir(dir);
      const rotated = files
        .filter(f => f.startsWith(`${base}-`) && f.endsWith(ext))
        .sort()
        .reverse();

      for (const old of rotated.slice(options.maxFiles)) {
        await unlink(join(dir, old)).catch(() => {});
      }
    }

    return true;
  } catch {
    // 文件不存在或其他错误，静默忽略
    return false;
  }
}

import {
  normalizeSessionShareFilePath,
  type SessionShareAllowedFile,
} from '../data/sessionShares/publicProjection.js';

type ShareFileSelection = { ok: true; filePaths: string[] } | { ok: false; error: string };

/** 新前端默认分享全部成果，同时兼容仍在提交文件子集的旧前端。 */
export function resolveSessionShareFileSelection(
  submittedFilePaths: unknown,
  candidates: readonly SessionShareAllowedFile[],
): ShareFileSelection {
  if (submittedFilePaths === undefined) {
    return { ok: true, filePaths: candidates.map((file) => file.relativePath) };
  }
  if (
    !Array.isArray(submittedFilePaths) ||
    submittedFilePaths.length > 32 ||
    submittedFilePaths.some((item) => typeof item !== 'string') ||
    new Set(submittedFilePaths).size !== submittedFilePaths.length
  ) {
    return { ok: false, error: '文件清单格式无效' };
  }
  const normalized = submittedFilePaths.map(normalizeSessionShareFilePath);
  if (normalized.some((filePath) => !filePath) || new Set(normalized).size !== normalized.length) {
    return { ok: false, error: '文件清单包含无效或重复路径' };
  }
  const filePaths = normalized as string[];
  if (candidates.some((file) => file.inlineInBody && !filePaths.includes(file.relativePath))) {
    return { ok: false, error: '正文内嵌图片和视频必须随正文一并公开' };
  }
  return { ok: true, filePaths };
}

import path from 'path';
import type { DingtalkCredentials } from '../../../../integrations/dingtalk/mediaApi.js';
import { dingtalkLogger } from '../../../../utils/logger.js';
import {
  BARE_IMAGE_PATH_RE,
  LOCAL_IMAGE_RE,
} from '../../../../integrations/dingtalk/constants.js';
import {
  toLocalPath,
  uploadMediaToDingTalk,
} from './common.js';

export async function processLocalImages(
  content: string,
  credentials: DingtalkCredentials,
): Promise<string> {
  let result = content;

  // 1. 处理 markdown 图片语法 ![alt](path)
  const mdMatches = [...result.matchAll(LOCAL_IMAGE_RE)];
  const processedPaths = new Set<string>();
  const mdReplacements: { start: number; end: number; replacement: string }[] = [];

  for (const match of mdMatches) {
    const [fullMatch, alt, rawPath] = match;
    const matchStart = match.index!;
    const mediaId = await uploadMediaToDingTalk(rawPath, 'image', credentials);
    if (mediaId) {
      mdReplacements.push({
        start: matchStart,
        end: matchStart + fullMatch.length,
        replacement: `![${alt}](${mediaId})`,
      });
      processedPaths.add(toLocalPath(rawPath));
      dingtalkLogger.info(`[Media][image] 上传成功: ${path.basename(toLocalPath(rawPath))}`);
    }
  }

  // 从后往前替换，避免索引偏移
  for (const r of mdReplacements.reverse()) {
    result = result.slice(0, r.start) + r.replacement + result.slice(r.end);
  }

  // 2. 处理裸路径（保持原有逻辑不变）
  const bareMatches = [...result.matchAll(BARE_IMAGE_PATH_RE)];
  const replacements: { start: number; end: number; replacement: string }[] = [];

  for (const match of bareMatches) {
    const rawPath = match[1];
    const localPath = toLocalPath(rawPath);
    if (processedPaths.has(localPath)) continue;

    const matchStart = match.index!;
    const preceding = result.slice(Math.max(0, matchStart - 2), matchStart);
    if (preceding.includes('](')) continue;

    const mediaId = await uploadMediaToDingTalk(rawPath, 'image', credentials);
    if (mediaId) {
      replacements.push({
        start: matchStart,
        end: matchStart + match[0].length,
        replacement: `![](${mediaId})`,
      });
      processedPaths.add(localPath);
      dingtalkLogger.info(`[Media][image] 裸路径上传成功: ${path.basename(localPath)}`);
    }
  }

  for (const r of replacements.reverse()) {
    result = result.slice(0, r.start) + r.replacement + result.slice(r.end);
  }

  return result;
}

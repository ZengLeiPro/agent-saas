import { createReadStream } from 'fs';
import { open } from 'fs/promises';
import { createInterface } from 'readline';

import { tryReadWorkspaceImage } from './readImageTool.js';
import {
  MAX_FILE_BYTES,
  MAX_READ_LINES,
  MAX_READ_OUTPUT_BYTES,
  truncateUtf8Prefix,
} from './toolOutput.js';
import { openRecoveredWorkspaceReadFile } from './workspacePathRecovery.js';

export async function readWorkspaceFile(
  workspaceRoot: string,
  path: string,
  options: { offset?: number; limit?: number; displayPath?: string },
  assertReadAllowed: (fullPath: string) => void,
): Promise<{ content: string; metadata: Record<string, unknown> }> {
  const recovered = await openRecoveredWorkspaceReadFile(workspaceRoot, path);
  const { fullPath, relativePath: relPath, trusted } = recovered;
  const outputPath = options.displayPath ?? relPath;
  try {
    assertReadAllowed(fullPath);
    const fileStat = trusted.stats;
    const stablePath = trusted.fdPath;
    const countLines = (text: string): number => (text ? text.split('\n').length : 0);
    const recoveredMetadata = recovered.recovered ? { pathRecovered: true } : {};
    const imageResult = await tryReadWorkspaceImage({
      fullPath: stablePath,
      relPath: outputPath,
      fileSize: fileStat.size,
      ...options,
    });
    if (imageResult) {
      return {
        ...imageResult,
        metadata: { ...imageResult.metadata, ...recoveredMetadata },
      };
    }
    if (options.offset !== undefined || options.limit !== undefined) {
      const content = await readLineRange(stablePath, outputPath, {
        offset: options.offset ?? 1,
        limit: options.limit ?? MAX_READ_LINES,
      });
      return {
        content,
        metadata: {
          path: outputPath,
          fileBytes: fileStat.size,
          linesRead: countLines(content),
          ranged: true,
          ...recoveredMetadata,
        },
      };
    }
    if (fileStat.size <= MAX_FILE_BYTES) {
      const handle = await open(stablePath, 'r');
      try {
        const buffer = Buffer.alloc(fileStat.size);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const content = buffer.toString('utf-8', 0, bytesRead);
        return {
          content,
          metadata: {
            path: outputPath,
            fileBytes: fileStat.size,
            linesRead: countLines(content),
            ...recoveredMetadata,
          },
        };
      } finally {
        await handle.close();
      }
    }
    const prefix = await readFilePrefix(stablePath, MAX_FILE_BYTES);
    return {
      content: `${prefix}\n...[truncated: file ${outputPath} is ${fileStat.size} bytes; showing first ${MAX_FILE_BYTES} bytes. Use Read with {"path":"${outputPath}","offset":1,"limit":${MAX_READ_LINES}} to continue by line chunks.]`,
      metadata: {
        path: outputPath,
        fileBytes: fileStat.size,
        linesRead: countLines(prefix),
        truncated: true,
        shownBytes: MAX_FILE_BYTES,
        ...recoveredMetadata,
      },
    };
  } finally {
    await trusted.handle.close();
  }
}

async function readFilePrefix(fullPath: string, maxBytes: number): Promise<string> {
  const handle = await open(fullPath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.toString('utf-8', 0, bytesRead);
  } finally {
    await handle.close();
  }
}

function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function readLineRange(
  fullPath: string,
  relPath: string,
  options: { offset: number; limit: number },
): Promise<string> {
  const offset = Math.max(1, Math.trunc(options.offset));
  const limit = Math.min(MAX_READ_LINES, Math.max(1, Math.trunc(options.limit)));
  const stream = createReadStream(fullPath, { encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  const lines: string[] = [];
  let lineNo = 0;
  let hasMore = false;
  let returnedBytes = 0;
  let byteLimitReached = false;
  let oversizedLine: { lineNo: number; bytes: number } | undefined;
  // 为包含完整路径的可执行 Shell 建议预留空间，保证最终 tool_result 仍落在硬上限内。
  const contentByteBudget = MAX_READ_OUTPUT_BYTES - 8 * 1024;
  try {
    for await (const line of rl) {
      lineNo += 1;
      if (lineNo < offset) continue;
      if (lines.length >= limit) {
        hasMore = true;
        break;
      }
      const separatorBytes = lines.length > 0 ? 1 : 0;
      const remainingBytes = contentByteBudget - returnedBytes - separatorBytes;
      if (remainingBytes <= 0) {
        hasMore = true;
        byteLimitReached = true;
        break;
      }
      const bounded = truncateUtf8Prefix(line, remainingBytes);
      lines.push(bounded.text);
      returnedBytes += separatorBytes + Buffer.byteLength(bounded.text, 'utf8');
      if (bounded.truncated) {
        oversizedLine = { lineNo, bytes: Buffer.byteLength(line, 'utf8') };
        hasMore = true;
        byteLimitReached = true;
        break;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  if (lines.length === 0) {
    return `...[no content: offset ${offset} is beyond EOF for ${relPath}; total lines=${lineNo}]`;
  }
  const endLine = offset + lines.length - 1;
  const suffix = oversizedLine
    ? `\n...[truncated: line ${oversizedLine.lineNo} is ${oversizedLine.bytes} UTF-8 bytes and exceeds the Read budget; use Shell: sed -n '${oversizedLine.lineNo}p' -- ${quoteShellArgument(relPath)} | head -c ${MAX_READ_OUTPUT_BYTES}]`
    : byteLimitReached
      ? `\n...[truncated: Read output reached ${MAX_READ_OUTPUT_BYTES} UTF-8 bytes while showing ${relPath} lines ${offset}-${endLine}; narrow the line range or use Search/Shell for targeted inspection]`
      : hasMore
        ? `\n...[truncated: showing ${relPath} lines ${offset}-${endLine}; next Read offset=${endLine + 1}, limit=${limit}]`
        : `\n...[EOF: showing ${relPath} lines ${offset}-${endLine}; total lines=${lineNo}]`;
  return `${lines.join('\n')}${suffix}`;
}

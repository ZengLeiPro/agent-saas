import { openTrustedTranscript } from './trusted.js';

/** 读取头部完整行；未读到文件末尾时丢弃可能截断的末行。 */
export async function readTrustedTranscriptHeadLines(filePath: string, byteCount: number): Promise<string[]> {
  const file = await openTrustedTranscript(filePath);
  try {
    const buf = Buffer.alloc(byteCount);
    const { bytesRead } = await file.handle.read(buf, 0, byteCount, 0);
    if (bytesRead === 0) return [];
    const lines = buf.subarray(0, bytesRead).toString('utf-8').split('\n');
    if (bytesRead === byteCount) lines.pop();
    return lines.filter(line => line.trim() !== '');
  } finally {
    await file.handle.close();
  }
}

/** 读取尾部完整行；非文件头起读时丢弃可能截断的首行。 */
export async function readTrustedTranscriptTailLines(
  filePath: string,
  fileSize: number,
  byteCount: number,
): Promise<string[]> {
  if (fileSize === 0) return [];
  const readSize = Math.min(byteCount, fileSize);
  const offset = fileSize - readSize;
  const file = await openTrustedTranscript(filePath);
  try {
    const buf = Buffer.alloc(readSize);
    const { bytesRead } = await file.handle.read(buf, 0, readSize, offset);
    if (bytesRead === 0) return [];
    const lines = buf.subarray(0, bytesRead).toString('utf-8').split('\n');
    if (offset > 0) lines.shift();
    return lines.filter(line => line.trim() !== '');
  } finally {
    await file.handle.close();
  }
}

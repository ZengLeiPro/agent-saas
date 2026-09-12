import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

/** Open once, reject symlinks/non-files, and cap bytes even if the file grows after stat. */
export async function readEvidenceFile(path, limit = 256000) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4194304)
    throw new Error('Invalid evidence byte limit');
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('Evidence must be a regular file');
    if (stat.size > limit) throw new Error('Evidence exceeds byte limit');
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await file.read(buffer, length, buffer.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > limit) throw new Error('Evidence exceeds byte limit');
    return buffer.subarray(0, length);
  } finally {
    await file?.close();
  }
}

export async function readEvidenceJson(path, limit) {
  const bytes = await readEvidenceFile(path, limit);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    // Do not leak raw evidence, paths or parser excerpts into public workflow logs.
    throw new Error('Evidence is not valid UTF-8 JSON');
  }
}

export async function readEvidenceJsonl(path, limit = 1048576) {
  const bytes = await readEvidenceFile(path, limit);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Evidence is not valid UTF-8 JSONL');
  }
  const records = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      throw new Error('Evidence is not valid UTF-8 JSONL');
    }
    if (records.length > 256) break;
  }
  return records;
}

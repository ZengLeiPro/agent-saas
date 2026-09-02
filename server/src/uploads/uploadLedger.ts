import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { UploadedFileInfo } from '../types/index.js';
import { atomicWriteTrustedFile, openTrustedDirectory, readTrustedFile } from '../security/trustedFile.js';
import { uploadLogger } from '../utils/logger.js';
import { ATTACHMENT_ID_RE, isSafeTaskScopeSegment } from './attachmentValidation.js';
import type { AttachmentState } from './manager.js';

interface CompletedUploadRequest {
  version: 1;
  requestId: string;
  sessionId?: string;
  completedAt: string;
  files: UploadedFileInfo[];
}

export async function readCompletedUploadRequest(
  userCwd: string,
  requestId: string,
  sessionId?: string,
): Promise<UploadedFileInfo[] | undefined> {
  if (!isSafeTaskScopeSegment(requestId)) return undefined;
  try {
    const record = JSON.parse(await readTrustedFile(
      userCwd,
      `uploads/.requests/${requestId}.json`,
      'utf8',
    ) as string) as CompletedUploadRequest;
    if (record.version !== 1 || record.requestId !== requestId || !Array.isArray(record.files)) return undefined;
    if (sessionId !== undefined && (record.sessionId ?? '') !== sessionId) {
      throw Object.assign(new Error('Upload request belongs to a different session'), {
        statusCode: 409,
        code: 'UPLOAD_REQUEST_SCOPE_MISMATCH',
      });
    }
    return record.files;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function writeCompletedUploadRequest(
  userCwd: string,
  requestId: string,
  files: UploadedFileInfo[],
  completedAt: string,
  sessionId?: string,
): Promise<void> {
  const record: CompletedUploadRequest = {
    version: 1,
    requestId,
    ...(sessionId ? { sessionId } : {}),
    completedAt,
    files: files.map((file) => ({ ...file, savedPath: undefined })),
  };
  await atomicWriteTrustedFile(
    userCwd,
    `uploads/.requests/${requestId}.json`,
    `${JSON.stringify(record)}\n`,
    { encoding: 'utf8', createParents: true, mode: 0o600 },
  );
}

export async function writeAttachmentState(
  root: string,
  state: AttachmentState,
  stateDirectory = '.state',
): Promise<void> {
  await atomicWriteTrustedFile(
    root,
    `${stateDirectory}/${state.attachmentId}.json`,
    `${JSON.stringify(state)}\n`,
    { encoding: 'utf8', createParents: true, mode: 0o664 },
  );
}

async function readPinnedFile(
  directoryFdPath: string,
  leaf: string,
  encoding?: BufferEncoding,
): Promise<Buffer | string> {
  const handle = await open(join(directoryFdPath, leaf), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw Object.assign(new Error('Not a file'), { code: 'EISDIR' });
    return encoding ? await handle.readFile({ encoding }) : await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function readAttachmentStates(userCwd: string): Promise<AttachmentState[]> {
  let stateDirectory: Awaited<ReturnType<typeof openTrustedDirectory>>;
  try {
    stateDirectory = await openTrustedDirectory(userCwd, 'uploads/.state');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  try {
    const entries = await readdir(stateDirectory.fdPath, { withFileTypes: true });
    const states: AttachmentState[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(await readPinnedFile(stateDirectory.fdPath, entry.name, 'utf8') as string) as AttachmentState;
        if (parsed.version === 1 && ATTACHMENT_ID_RE.test(parsed.attachmentId)) states.push(parsed);
      } catch (error) {
        uploadLogger.warn(`Skip invalid attachment state ${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return states;
  } finally {
    await stateDirectory.handle.close();
  }
}

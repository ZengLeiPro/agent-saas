import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  appendTrustedFile,
  atomicWriteTrustedFile,
  openTrustedDirectory,
  openTrustedFile,
  relativeToTrustedRoot,
  removeTrustedPath,
  writeTrustedFile,
  writeTrustedFileIfAbsent,
  type TrustedFile,
} from '../../security/trustedFile.js';
import { AGENT_LEGACY_TRANSCRIPTS_ROOT } from './projectKey.js';

export interface TrustedTranscriptLocation {
  root: string;
  relativePath: string;
  cacheKey: string;
}

export function trustedTranscriptLocation(candidate: string): TrustedTranscriptLocation {
  const relativePath = relativeToTrustedRoot(AGENT_LEGACY_TRANSCRIPTS_ROOT, candidate);
  return {
    root: AGENT_LEGACY_TRANSCRIPTS_ROOT,
    relativePath,
    cacheKey: resolve(AGENT_LEGACY_TRANSCRIPTS_ROOT, relativePath),
  };
}

export function trustedTranscriptRelativePath(candidate: string): string {
  return trustedTranscriptLocation(candidate).relativePath;
}

export async function openTrustedTranscript(candidate: string): Promise<TrustedFile & TrustedTranscriptLocation> {
  const location = trustedTranscriptLocation(candidate);
  return { ...await openTrustedFile(location.root, location.relativePath), ...location };
}

export async function withTrustedTranscript<T>(
  candidate: string,
  operation: (file: TrustedFile & TrustedTranscriptLocation) => Promise<T>,
): Promise<T> {
  const file = await openTrustedTranscript(candidate);
  try {
    return await operation(file);
  } finally {
    await file.handle.close();
  }
}

export async function statTrustedTranscript(candidate: string): Promise<Stats> {
  const file = await openTrustedTranscript(candidate);
  try {
    return file.stats;
  } finally {
    await file.handle.close();
  }
}

export function readTrustedTranscript(candidate: string, encoding: BufferEncoding): Promise<string>;
export function readTrustedTranscript(candidate: string): Promise<Buffer>;
export async function readTrustedTranscript(candidate: string, encoding?: BufferEncoding): Promise<Buffer | string> {
  const file = await openTrustedTranscript(candidate);
  try {
    return encoding ? await file.handle.readFile({ encoding }) : await file.handle.readFile();
  } finally {
    await file.handle.close();
  }
}

export async function writeTrustedTranscript(
  candidate: string,
  data: string | Uint8Array,
  options: { encoding?: BufferEncoding; createParents?: boolean; exclusive?: boolean; mode?: number } = {},
): Promise<void> {
  const location = trustedTranscriptLocation(candidate);
  await writeTrustedFile(location.root, location.relativePath, data, options);
}

/** Appends through a descriptor-pinned parent; no caller-controlled pathname is reopened. */
export async function appendTrustedTranscript(
  candidate: string,
  data: string | Uint8Array,
  encoding?: BufferEncoding,
): Promise<void> {
  const location = trustedTranscriptLocation(candidate);
  await appendTrustedFile(location.root, location.relativePath, data, encoding);
}

const transcriptReadsInFlight = new Map<string, Promise<string | null>>();

/** Coalesced read that still opens the inode through the trusted descriptor chain. */
export async function readTrustedTranscriptCoalesced(candidate: string): Promise<string | null> {
  const location = trustedTranscriptLocation(candidate);
  const existing = transcriptReadsInFlight.get(location.cacheKey);
  if (existing) return existing;
  const pending = readTrustedTranscript(location.cacheKey, 'utf-8')
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    })
    .finally(() => transcriptReadsInFlight.delete(location.cacheKey));
  transcriptReadsInFlight.set(location.cacheKey, pending);
  return pending;
}

export async function atomicWriteTrustedTranscript(
  candidate: string,
  data: string | Uint8Array,
  options: { encoding?: BufferEncoding; createParents?: boolean; mode?: number; tempSuffix?: string } = {},
): Promise<void> {
  const location = trustedTranscriptLocation(candidate);
  await atomicWriteTrustedFile(location.root, location.relativePath, data, options);
}

export async function writeTrustedTranscriptIfAbsent(
  candidate: string,
  data: string | Uint8Array,
  options: { encoding?: BufferEncoding; createParents?: boolean; mode?: number; tempSuffix?: string } = {},
): Promise<boolean> {
  const location = trustedTranscriptLocation(candidate);
  return writeTrustedFileIfAbsent(location.root, location.relativePath, data, options);
}

export async function removeTrustedTranscriptPath(candidate: string): Promise<void> {
  const location = trustedTranscriptLocation(candidate);
  await removeTrustedPath(location.root, location.relativePath);
}

export async function openTrustedTranscriptDirectory(candidate: string): Promise<{
  handle: FileHandle;
  fdPath: string;
  stats: Stats;
  location: TrustedTranscriptLocation;
}> {
  const location = candidate === AGENT_LEGACY_TRANSCRIPTS_ROOT
    ? { root: AGENT_LEGACY_TRANSCRIPTS_ROOT, relativePath: '', cacheKey: resolve(candidate) }
    : trustedTranscriptLocation(candidate);
  return { ...await openTrustedDirectory(location.root, location.relativePath), location };
}

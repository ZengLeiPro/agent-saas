import { createHash, randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { posix } from 'node:path';

import {
  copyTrustedFile,
  moveTrustedDirectoryIfAbsent,
  openTrustedDirectory,
  readTrustedFile,
  withTrustedFile,
  writeTrustedFileIfAbsent,
} from '../security/trustedFile.js';

const ORG_AGENT_ARTIFACT_INSTRUCTION =
  '\n\n交付文件约定：只把需要交付给群成员的最终产物写入当前任务目录的 artifacts/；其他工作文件留在任务目录。平台只会为 artifacts/ 生成清单，并由管理员显式发布到群共享目录。';

const MAX_ARTIFACT_FILES = 1_000;
const MAX_ARTIFACT_FILE_BYTES = 25 * 1024 * 1024;
const MAX_ARTIFACT_TOTAL_BYTES = 100 * 1024 * 1024;
const PUBLISHED_MANIFEST_FILE = '.ky-publish-manifest.json';

export interface OrgAgentArtifactFile {
  path: string;
  digest: string;
  size: number;
}

export interface OrgAgentArtifactManifest {
  version: 1;
  files: OrgAgentArtifactFile[];
  totalBytes: number;
  capturedAt: string;
  publishedRoot?: string;
}

export function withOrgAgentArtifactContract(prompt: string, enabled: boolean): string {
  return enabled ? `${prompt}${ORG_AGENT_ARTIFACT_INSTRUCTION}` : prompt;
}

export async function collectOrgAgentArtifactManifest(
  taskRoot: string,
): Promise<OrgAgentArtifactManifest> {
  const files: OrgAgentArtifactFile[] = [];
  let totalBytes = 0;
  const visit = async (relativeDirectory: string): Promise<void> => {
    const directory = await openTrustedDirectory(taskRoot, relativeDirectory);
    try {
      const entries = await readdir(directory.fdPath, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const relativePath = relativeDirectory
          ? posix.join(relativeDirectory, entry.name)
          : entry.name;
        if (entry.isSymbolicLink()) throw new Error('ORG_AGENT_ARTIFACT_SYMLINK_REJECTED');
        if (entry.isDirectory()) {
          await visit(relativePath);
          continue;
        }
        if (!entry.isFile()) throw new Error('ORG_AGENT_ARTIFACT_TYPE_REJECTED');
        if (files.length >= MAX_ARTIFACT_FILES) throw new Error('ORG_AGENT_ARTIFACT_FILE_LIMIT');
        const artifact = await withTrustedFile(taskRoot, relativePath, async (file) => {
          if (file.stats.size > MAX_ARTIFACT_FILE_BYTES)
            throw new Error('ORG_AGENT_ARTIFACT_FILE_TOO_LARGE');
          const content = await file.handle.readFile();
          const after = await file.handle.stat();
          if (
            after.size !== file.stats.size ||
            after.mtimeMs !== file.stats.mtimeMs ||
            after.ino !== file.stats.ino
          )
            throw new Error('ORG_AGENT_ARTIFACT_CHANGED_DURING_CAPTURE');
          return {
            path: relativePath,
            digest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
            size: content.byteLength,
          };
        });
        totalBytes += artifact.size;
        if (totalBytes > MAX_ARTIFACT_TOTAL_BYTES)
          throw new Error('ORG_AGENT_ARTIFACT_TOTAL_TOO_LARGE');
        files.push(artifact);
      }
    } finally {
      await directory.handle.close();
    }
  };
  await visit('');
  return { version: 1, files, totalBytes, capturedAt: new Date().toISOString() };
}

export async function publishOrgAgentArtifacts(input: {
  taskRoot: string;
  stagingRoot: string;
  sharedRoot: string;
  publishedRoot: string;
  manifest: OrgAgentArtifactManifest;
}): Promise<OrgAgentArtifactManifest> {
  assertManifest(input.manifest);
  if (!isSafeRelativePath(input.publishedRoot))
    throw new Error('ORG_AGENT_ARTIFACT_PUBLISH_ROOT_INVALID');
  const published = await readPublishedManifest(input.sharedRoot, input.publishedRoot).catch(
    (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    },
  );
  if (published) {
    assertSameManifest(input.manifest, published);
    await verifyPublishedFiles(input.sharedRoot, input.publishedRoot, published);
    return { ...published, publishedRoot: input.publishedRoot };
  }
  const manifestDocument = JSON.stringify(serializeOrgAgentArtifactManifest(input.manifest));
  const stagingPath = `stage-${createHash('sha256')
    .update(`${input.publishedRoot}\0${manifestDocument}`)
    .digest('hex')}-${randomUUID()}`;
  for (const artifact of input.manifest.files) {
    const destination = posix.join(stagingPath, artifact.path);
    try {
      await copyTrustedFile(input.taskRoot, artifact.path, input.stagingRoot, destination, {
        maxBytes: MAX_ARTIFACT_FILE_BYTES,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await readTrustedFile(input.stagingRoot, destination);
      const digest = `sha256:${createHash('sha256').update(existing).digest('hex')}`;
      if (existing.byteLength !== artifact.size || digest !== artifact.digest)
        throw new Error('ORG_AGENT_ARTIFACT_PUBLISH_CONFLICT');
    }
    const staged = await readTrustedFile(input.stagingRoot, destination);
    const stagedDigest = `sha256:${createHash('sha256').update(staged).digest('hex')}`;
    if (staged.byteLength !== artifact.size || stagedDigest !== artifact.digest)
      throw new Error('ORG_AGENT_ARTIFACT_PUBLISH_INTEGRITY_FAILED');
  }
  const markerPath = posix.join(stagingPath, PUBLISHED_MANIFEST_FILE);
  const markerCreated = await writeTrustedFileIfAbsent(
    input.stagingRoot,
    markerPath,
    manifestDocument,
    { createParents: true },
  );
  if (!markerCreated) {
    const existingMarker = await readTrustedFile(input.stagingRoot, markerPath, 'utf8');
    if (existingMarker !== manifestDocument) throw new Error('ORG_AGENT_ARTIFACT_PUBLISH_CONFLICT');
  }
  try {
    await moveTrustedDirectoryIfAbsent(
      input.stagingRoot,
      stagingPath,
      input.sharedRoot,
      input.publishedRoot,
    );
  } catch (error) {
    if (!['EEXIST', 'ENOENT'].includes(String((error as NodeJS.ErrnoException).code))) throw error;
  }
  const finalManifest = await readPublishedManifest(input.sharedRoot, input.publishedRoot);
  assertSameManifest(input.manifest, finalManifest);
  await verifyPublishedFiles(input.sharedRoot, input.publishedRoot, finalManifest);
  return { ...finalManifest, publishedRoot: input.publishedRoot };
}

export function parseOrgAgentArtifactManifest(value: unknown): OrgAgentArtifactManifest {
  assertManifest(value);
  return value;
}

export function serializeOrgAgentArtifactManifest(
  manifest: OrgAgentArtifactManifest,
): Record<string, unknown> {
  return {
    version: manifest.version,
    files: manifest.files.map((file) => ({ ...file })),
    totalBytes: manifest.totalBytes,
    capturedAt: manifest.capturedAt,
    ...(manifest.publishedRoot ? { publishedRoot: manifest.publishedRoot } : {}),
  };
}

function assertManifest(value: unknown): asserts value is OrgAgentArtifactManifest {
  if (!value || typeof value !== 'object') throw new Error('ORG_AGENT_ARTIFACT_MANIFEST_INVALID');
  const manifest = value as Partial<OrgAgentArtifactManifest>;
  if (
    manifest.version !== 1 ||
    !Array.isArray(manifest.files) ||
    !Number.isSafeInteger(manifest.totalBytes) ||
    (manifest.totalBytes ?? -1) < 0
  )
    throw new Error('ORG_AGENT_ARTIFACT_MANIFEST_INVALID');
  let total = 0;
  for (const file of manifest.files) {
    if (!file || typeof file !== 'object') throw new Error('ORG_AGENT_ARTIFACT_MANIFEST_INVALID');
    const candidate = file as Partial<OrgAgentArtifactFile>;
    const size = candidate.size;
    if (
      typeof candidate.path !== 'string' ||
      !isSafeRelativePath(candidate.path) ||
      typeof candidate.digest !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(candidate.digest) ||
      typeof size !== 'number' ||
      !Number.isSafeInteger(size) ||
      size < 0
    )
      throw new Error('ORG_AGENT_ARTIFACT_MANIFEST_INVALID');
    if (candidate.path === PUBLISHED_MANIFEST_FILE)
      throw new Error('ORG_AGENT_ARTIFACT_MANIFEST_INVALID');
    total += size;
  }
  if (
    total !== manifest.totalBytes ||
    manifest.files.length > MAX_ARTIFACT_FILES ||
    total > MAX_ARTIFACT_TOTAL_BYTES
  )
    throw new Error('ORG_AGENT_ARTIFACT_MANIFEST_INVALID');
}

async function readPublishedManifest(
  root: string,
  publishedRoot: string,
): Promise<OrgAgentArtifactManifest> {
  const raw = await readTrustedFile(
    root,
    posix.join(publishedRoot, PUBLISHED_MANIFEST_FILE),
    'utf8',
  );
  return parseOrgAgentArtifactManifest(JSON.parse(raw) as unknown);
}

function assertSameManifest(
  expected: OrgAgentArtifactManifest,
  actual: OrgAgentArtifactManifest,
): void {
  const comparable = (manifest: OrgAgentArtifactManifest) => ({
    version: manifest.version,
    files: manifest.files,
    totalBytes: manifest.totalBytes,
    capturedAt: manifest.capturedAt,
  });
  if (JSON.stringify(comparable(expected)) !== JSON.stringify(comparable(actual)))
    throw new Error('ORG_AGENT_ARTIFACT_PUBLISH_CONFLICT');
}

async function verifyPublishedFiles(
  root: string,
  publishedRoot: string,
  manifest: OrgAgentArtifactManifest,
): Promise<void> {
  for (const artifact of manifest.files) {
    const content = await readTrustedFile(root, posix.join(publishedRoot, artifact.path));
    const digest = `sha256:${createHash('sha256').update(content).digest('hex')}`;
    if (content.byteLength !== artifact.size || digest !== artifact.digest)
      throw new Error('ORG_AGENT_ARTIFACT_PUBLISH_INTEGRITY_FAILED');
  }
}

function isSafeRelativePath(value: string): boolean {
  return (
    Boolean(value) &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    value.split('/').every((part) => Boolean(part) && part !== '.' && part !== '..')
  );
}

import { createHash, randomUUID } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';

import {
  MAX_SHELL_RETURN_CHARS,
  type ShellOutputFileRef,
} from './toolOutput.js';

const SHELL_OUTPUT_DIR = 'tmp/tool-results';

export function shouldPersistShellOutput(stdout: string, stderr: string): boolean {
  return stdout.length + stderr.length > MAX_SHELL_RETURN_CHARS;
}

export async function persistShellOutputFiles(input: {
  workspaceRoot: string;
  invocationId?: string;
  stdout: string;
  stderr: string;
}): Promise<ShellOutputFileRef[]> {
  if (!shouldPersistShellOutput(input.stdout, input.stderr)) return [];
  const baseName = sanitizeFileSegment(input.invocationId ?? `shell-${Date.now()}-${randomUUID().slice(0, 8)}`);
  const files: ShellOutputFileRef[] = [];
  if (input.stdout) files.push(await writeChannelOutput(input.workspaceRoot, baseName, 'stdout', input.stdout));
  if (input.stderr) files.push(await writeChannelOutput(input.workspaceRoot, baseName, 'stderr', input.stderr));
  return files;
}

async function writeChannelOutput(
  workspaceRoot: string,
  baseName: string,
  channel: 'stdout' | 'stderr',
  content: string,
): Promise<ShellOutputFileRef> {
  const relPath = `${SHELL_OUTPUT_DIR}/${baseName}-${channel}.txt`;
  const fullPath = resolve(workspaceRoot, relPath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, 'utf-8');
  return {
    channel,
    path: relPath,
    bytes: Buffer.byteLength(content, 'utf-8'),
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}

function sanitizeFileSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || randomUUID();
}

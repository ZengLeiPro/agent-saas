import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

export const SHA_PATTERN = /^[a-f0-9]{40}$/u;
export const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function digestBuffer(buffer) {
  return `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
}

export async function digestFile(filePath) {
  const content = await readFile(filePath);
  return { digest: digestBuffer(content), size: content.byteLength };
}

export async function inventoryTree(root) {
  const absoluteRoot = resolve(root);
  const output = [];
  async function walk(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = resolve(directory, entry.name);
      if (!path.startsWith(`${absoluteRoot}${sep}`)) throw new Error('Artifact path escaped root');
      if (entry.isSymbolicLink()) throw new Error(`Artifact contains forbidden symlink: ${path}`);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const item = await digestFile(path);
        output.push({ path: relative(absoluteRoot, path).split(sep).join('/'), ...item });
      } else throw new Error(`Artifact contains unsupported entry: ${path}`);
    }
  }
  await walk(absoluteRoot);
  return output;
}

export async function assertRegularFile(filePath) {
  const details = await stat(filePath);
  if (!details.isFile()) throw new Error(`Expected regular artifact file: ${filePath}`);
}

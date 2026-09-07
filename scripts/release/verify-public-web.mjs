import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { digestBuffer } from './artifact-lib.mjs';

/** Compare the actual public entry and every shipped JS/CSS resource, without cache-busting. */
export async function verifyPublicWeb({ root, url, fetchImpl = fetch }) {
  const base = new URL(url);
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password)
    throw new Error('Invalid public Web URL');
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const files = ['index.html'];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Web artifact symlinks are not allowed');
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.(?:js|css)$/u.test(entry.name)) files.push(relative(root, path));
    }
  }
  root = resolve(root);
  await walk(root);
  if (files.length === 1) throw new Error('Web artifact has no JS/CSS entry resources');
  const results = [];
  for (const path of files.sort()) {
    const target = path === 'index.html' ? base : new URL(path, base);
    const response = await fetchImpl(target, {
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw new Error(`Public Web resource unavailable: ${path} (${response.status})`);
    const actual = Buffer.from(await response.arrayBuffer());
    const expected = await readFile(join(root, path));
    if (!actual.equals(expected)) throw new Error(`Public Web artifact mismatch: ${path}`);
    results.push({
      path,
      digest: digestBuffer(actual),
      cacheControl: response.headers.get('cache-control'),
      age: response.headers.get('age'),
    });
  }
  return {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    url: base.href,
    status: 'passed',
    files: results,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , root, url, output] = process.argv;
  if (!root || !url || !output)
    throw new Error('Usage: verify-public-web.mjs <artifact root> <public URL> <output>');
  const result = await verifyPublicWeb({ root, url });
  await writeFile(output, JSON.stringify(result, null, 2) + '\n');
}

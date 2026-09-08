import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function stageCoverageBlobs({ source, destination, matrix, runId, attempt }) {
  if (!/^[0-9]+$/u.test(String(runId)) || !/^[0-9]+$/u.test(String(attempt)))
    throw new Error('Coverage requires a complete run and attempt identity');
  if (!Array.isArray(matrix) || matrix.length === 0) throw new Error('Missing coverage shard plan');
  const expected = new Map();
  const files = [];
  for (const entry of matrix) {
    const { workspace, shard, total } = entry;
    if (
      !['shared', 'server', 'web'].includes(workspace) ||
      !Number.isInteger(shard) ||
      !Number.isInteger(total) ||
      shard < 1 ||
      shard > total
    )
      throw new Error('Invalid coverage shard plan');
    const key = `${workspace}-${shard}`;
    if (expected.has(key)) throw new Error(`Duplicate coverage shard ${key}`);
    expected.set(key, entry);
    const name = `blob-${shard}-${total}.json`;
    const directory = join(source, `coverage-blob-${workspace}-${shard}-${runId}-${attempt}`);
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      throw new Error(`Missing coverage blob for ${workspace} ${shard}/${total}`);
    }
    if (entries.length !== 1 || entries[0].name !== name || !entries[0].isFile())
      throw new Error(`Unexpected coverage blob contents for ${workspace} ${shard}/${total}`);
    files.push({ from: join(directory, name), workspace, name });
  }
  for (const workspace of new Set(matrix.map((entry) => entry.workspace))) {
    const entries = matrix.filter((entry) => entry.workspace === workspace);
    if (
      entries.some((entry) => entry.total !== entries[0].total) ||
      entries.length !== entries[0].total
    )
      throw new Error(`Incomplete coverage shard plan for ${workspace}`);
  }
  // Verify the entire current attempt before writing anything; stale or partial reports cannot pass.
  for (const workspace of new Set(files.map((file) => file.workspace))) {
    const target = join(destination, workspace, 'coverage-blobs');
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
  }
  for (const file of files)
    copyFileSync(file.from, join(destination, file.workspace, 'coverage-blobs', file.name));
  return { staged: files.length };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const result = stageCoverageBlobs({
    source: process.argv[2],
    destination: process.cwd(),
    matrix: JSON.parse(process.env.CI_TEST_MATRIX),
    runId: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT,
  });
  process.stdout.write(`Coverage blobs: ${JSON.stringify(result)}\n`);
}

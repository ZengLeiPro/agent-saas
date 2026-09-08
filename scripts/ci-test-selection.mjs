import { writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createVitest } from 'vitest/node';
import { sourceGuardTests } from './ci-source-guards.mjs';

export async function selectedTests(
  workspace,
  base,
  repository = fileURLToPath(new URL('..', import.meta.url)),
) {
  if (!['shared', 'server', 'web'].includes(workspace) || !/^[a-f0-9]{40}$/u.test(base))
    throw new Error('Affected selection requires a known workspace and complete base SHA');
  const root = resolve(repository, workspace);
  const context = await createVitest('test', { root, watch: false, changed: base });
  try {
    const all = new Set(
      (await context.globTestSpecifications()).map((test) => relative(root, test.moduleId)),
    );
    const affected = (await context.getRelevantTestSpecifications()).map((test) =>
      relative(root, test.moduleId),
    );
    const guards = sourceGuardTests(workspace, repository);
    for (const guard of guards)
      if (!all.has(guard))
        throw new Error(`Source guard is excluded by test configuration: ${guard}`);
    const files = [...new Set([...affected, ...guards])].sort();
    if (files.some((file) => /[\r\n]/u.test(file)))
      throw new Error('Test paths must not contain line breaks');
    return { files, discovered: all.size, affected: affected.length, guards: guards.length };
  } finally {
    await context.close();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [, , workspace, base, output] = process.argv;
  if (!output) throw new Error('Missing selected-test output path');
  const result = await selectedTests(workspace, base);
  writeFileSync(output, result.files.length ? result.files.join('\n') + '\n' : '');
  process.stdout.write(
    `CI test selection: ${JSON.stringify({ workspace, base, ...result, files: undefined, selected: result.files.length })}\n`,
  );
}

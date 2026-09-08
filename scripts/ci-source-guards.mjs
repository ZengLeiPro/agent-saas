import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, relative, join, dirname, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const WORKSPACES = new Set(['server', 'web', 'shared']);
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
// These tests read resources outside Vitest's source-import graph. Be conservative:
// temporary-fixture readers also run, and an indirect local helper propagates its
// filesystem dependency back to every importing test. Annotate nonlocal resource
// helpers with @ci-source-guard; unknown dynamic loaders are always included.
const RESOURCE_READ =
  /(?:@ci-source-guard|['"](?:node:)?fs(?:\/promises)?['"]|['"]fs-extra['"]|\b(?:readFileSync|readFile|readdirSync|readdir|readJsonSync|readJson|readJSON|globSync)\b|\b(?:import|require)\s*(?:\/\*[\s\S]*?\*\/\s*)*\(\s*[^'"\s])/u;
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];

function localDependency(file, specifier) {
  const path = resolve(dirname(file), specifier);
  const base = /\.[cm]?jsx?$/u.test(path) ? path.slice(0, -extname(path).length) : path;
  const candidates = [
    path,
    ...EXTENSIONS.map((extension) => base + extension),
    ...EXTENSIONS.map((extension) => join(path, 'index' + extension)),
  ];
  return candidates.find((candidate) => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

export function sourceGuardTests(
  workspace,
  repository = fileURLToPath(new URL('..', import.meta.url)),
) {
  if (!WORKSPACES.has(workspace)) throw new Error(`Unsupported test workspace: ${workspace}`);
  const repositoryRoot = resolve(repository);
  const root = resolve(repositoryRoot, workspace);
  const testFiles = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && TEST_FILE.test(entry.name)) testFiles.push(path);
    }
  };
  visit(join(root, 'src'));
  if (workspace === 'server' && existsSync(join(root, 'tests'))) visit(join(root, 'tests'));
  const readers = new Set();
  const importers = new Map();
  const inspected = new Set();
  const pending = [...testFiles];
  while (pending.length) {
    const file = pending.pop();
    if (inspected.has(file)) continue;
    inspected.add(file);
    const source = readFileSync(file, 'utf8');
    if (/\.guard\.(?:test|spec)\./u.test(file) || RESOURCE_READ.test(source)) readers.add(file);
    for (const { fileName: specifier } of ts.preProcessFile(source, true, true).importedFiles) {
      if (!specifier.startsWith('.')) continue;
      const dependency = localDependency(file, specifier);
      if (!dependency || !dependency.startsWith(repositoryRoot + '/')) {
        // Unknown/out-of-repository local resolution cannot justify skipping the caller.
        readers.add(file);
        continue;
      }
      if (!importers.has(dependency)) importers.set(dependency, new Set());
      importers.get(dependency).add(file);
      pending.push(dependency);
    }
  }
  const propagate = [...readers];
  while (propagate.length) {
    const file = propagate.pop();
    for (const importer of importers.get(file) ?? []) {
      if (readers.has(importer)) continue;
      readers.add(importer);
      propagate.push(importer);
    }
  }
  return testFiles
    .filter((file) => readers.has(file))
    .map((file) => relative(root, file).split('\\').join('/'))
    .sort();
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const tests = sourceGuardTests(process.argv[2]);
  process.stderr.write(`CI source/resource guard selection: ${tests.length} test files\n`);
  for (const file of tests) process.stdout.write(`${file}\n`);
}

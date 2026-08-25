import { execFileSync as defaultExecFileSync } from 'node:child_process';

export const COMPONENTS = Object.freeze(['web', 'api', 'runtimeWorker', 'acs']);

const PATH_COMPONENTS = Object.freeze([
  ['web/', ['web']],
  ['server/', ['api']],
  ['shared/', ['web', 'api']],
  ['workspace-shared/', ['api']],
  ['hand-server/', ['runtimeWorker']],
  ['acs-orchestrator/', ['acs']],
]);

export function classifyPath(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return { components: [], blockingReason: 'Changed path is empty.' };
  }

  const normalizedPath = filePath.replaceAll('\\', '/').replace(/^\.\//u, '');
  const match = PATH_COMPONENTS.find(([prefix]) => normalizedPath.startsWith(prefix));
  if (!match) {
    return {
      components: [],
      blockingReason: `Changed path is not mapped to a release component: ${filePath}`,
    };
  }

  return { components: [...match[1]], blockingReason: null };
}

export function classifyChangedPaths(changedPaths) {
  const components = new Set();
  const blockingReasons = [];

  for (const filePath of changedPaths) {
    const classification = classifyPath(filePath);
    classification.components.forEach((component) => components.add(component));
    if (classification.blockingReason) blockingReasons.push(classification.blockingReason);
  }

  return {
    ok: blockingReasons.length === 0,
    changedFiles: [...changedPaths],
    components: COMPONENTS.filter((component) => components.has(component)),
    blockingReasons,
  };
}

export function readChangedPaths({ baseline, target, cwd = process.cwd(), execFileSync = defaultExecFileSync }) {
  const output = execFileSync(
    'git',
    ['diff', '--name-only', `${baseline}...${target}`],
    { cwd, encoding: 'utf8' },
  );

  return String(output)
    .split(/\r?\n/u)
    .map((filePath) => filePath.trim())
    .filter(Boolean);
}

export function classifyComponents(options) {
  try {
    const changedPaths = readChangedPaths(options);
    return classifyChangedPaths(changedPaths);
  } catch (error) {
    return {
      ok: false,
      changedFiles: [],
      components: [],
      blockingReasons: [`Unable to read changed paths with git diff --name-only: ${error.message}`],
    };
  }
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) continue;
    values[argument.slice(2)] = argv[index + 1];
    index += 1;
  }
  return values;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const missing = ['baseline', 'target'].filter((name) => !args[name]);
  const result = missing.length > 0
    ? {
      ok: false,
      changedFiles: [],
      components: [],
      blockingReasons: missing.map((name) => `Missing required --${name}.`),
    }
    : classifyComponents({ baseline: args.baseline, target: args.target, cwd: args.cwd ?? process.cwd() });

  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

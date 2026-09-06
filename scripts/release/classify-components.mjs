import { execFileSync as defaultExecFileSync } from 'node:child_process';

export const COMPONENTS = Object.freeze(['web', 'api', 'runtimeWorker', 'acs']);

const PATH_COMPONENTS = Object.freeze([
  // 根 Dockerfile 是多 target 构建入口：Server、Hand、ACS Sandbox，并通过
  // web-build stage 产出嵌入式 Web dist。变更时保守要求全部组件重新绑定制品。
  ['Dockerfile', COMPONENTS],
  ['config/runtime-dependency-contract.json', COMPONENTS],
  ['daemon-packaging/Dockerfile', ['api', 'runtimeWorker', 'acs']],
  ['scripts/deploy-acs-orchestrator.sh', ['acs']],
  ['scripts/deploy-recovery-web.sh', ['web']],
  ['scripts/rollback-recovery-web.sh', ['web']],
  ['scripts/rollback-web-oss.sh', ['web']],
  ['scripts/release/runtime-dependency.mjs', ['api', 'runtimeWorker', 'acs']],
  ['scripts/release/artifact-lib.mjs', ['api', 'runtimeWorker', 'acs']],
  ['package.json', COMPONENTS],
  ['pnpm-lock.yaml', COMPONENTS],
  ['pnpm-workspace.yaml', COMPONENTS],
  ['patches/', COMPONENTS],
  ['web/', ['web']],
  ['server/', ['api', 'runtimeWorker', 'acs']],
  ['shared/', ['web', 'api', 'runtimeWorker', 'acs']],
  ['workspace-shared/', ['api', 'runtimeWorker', 'acs']],
  ['hand-server/', ['api', 'runtimeWorker']],
  ['acs-orchestrator/', ['acs']],
  ['daemon-packaging/', ['api', 'runtimeWorker', 'acs']],
  ['.github/', []],
  ['.husky/', []],
  ['docs/', []],
  ['scripts/config/', []],
  ['scripts/release/', []],
  ['scripts/staging/', []],
  ['e2e/', []],
  ['infra/staging/', []],
  ['config/', []],
  ['mobile/', []],
  ['assets/', []],
  // 契约包（@kaiyan/ky-app-*、create-ky-app）以 tarball 发布给定制项目，不随任何生产组件部署。
  ['packages/', []],
]);

const NON_RUNTIME_FILES = new Set([
  '.dockerignore',
  '.env.ecs.example',
  '.gitignore',
  '.nvmrc',
  '.npmrc',
  '.prettierignore',
  '.prettierrc.json',
  'CLAUDE.md',
  'README.md',
  'app.json',
  'config.example.json',
  'daemon-packaging/systemd/agent-saas-server-staging.service.template',
  'daemon-packaging/systemd/agent-saas-runtime-worker-staging.service.template',
  'docker-compose.local-db.yml',
  'docker-compose.override.ecs.yml',
  'docker-compose.yml',
  'eas.json',
  'eslint.config.mjs',
  'scripts/check-env-var-count.mjs',
  'scripts/check-max-lines-ratchet.mjs',
  'scripts/ratchets.test.mjs',
  'scripts/ci-plan.mjs',
  // 删除的旧脚本仍会出现在生产基线到目标版本的差异中。
  'scripts/coverage-workspace-plan.mjs',
  'scripts/format-new-staged-files.mjs',
  'scripts/generate-dws-command-policy.mjs',
  'scripts/pr-preflight-contract.test.mjs',
  'scripts/pr-preflight-task.sh',
  'scripts/pr-preflight.sh',
  'scripts/runtime-worker-rollout-order.test.mjs',
  'scripts/test_acs_operational_scripts.py',
  'scripts/typecheck-staged.mjs',
]);

export function classifyPath(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return { components: [], blockingReason: 'Changed path is empty.' };
  }

  const normalizedPath = filePath.replaceAll('\\', '/').replace(/^\.\//u, '');
  if (NON_RUNTIME_FILES.has(normalizedPath)) {
    return { components: [], blockingReason: null };
  }
  const match = PATH_COMPONENTS.find(([prefix]) =>
    prefix.endsWith('/') ? normalizedPath.startsWith(prefix) : normalizedPath === prefix,
  );
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

  if (components.has('api') || components.has('runtimeWorker')) {
    components.add('api');
    components.add('runtimeWorker');
  }

  return {
    ok: blockingReasons.length === 0,
    changedFiles: [...changedPaths],
    components: COMPONENTS.filter((component) => components.has(component)),
    blockingReasons,
  };
}

export function readChangedPaths({
  baseline,
  target,
  cwd = process.cwd(),
  execFileSync = defaultExecFileSync,
}) {
  const output = execFileSync(
    'git',
    [
      '-c',
      'core.quotePath=false',
      'diff',
      '--name-status',
      '--find-renames',
      '--find-copies',
      `${baseline}...${target}`,
    ],
    { cwd, encoding: 'utf8' },
  );

  return String(output)
    .split(/\r?\n/u)
    .flatMap((line) => {
      const fields = line
        .split('\t')
        .map((field) => field.trim())
        .filter(Boolean);
      if (fields.length === 0) return [];
      if (/^[RC]\d*$/u.test(fields[0]) && fields.length === 3) return fields.slice(1);
      return fields.length > 1 ? [fields.at(-1)] : fields;
    })
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
  const result =
    missing.length > 0
      ? {
          ok: false,
          changedFiles: [],
          components: [],
          blockingReasons: missing.map((name) => `Missing required --${name}.`),
        }
      : classifyComponents({
          baseline: args.baseline,
          target: args.target,
          cwd: args.cwd ?? process.cwd(),
        });

  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

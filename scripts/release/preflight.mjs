import { execFileSync as defaultExecFileSync } from 'node:child_process';
import { classifyComponents } from './classify-components.mjs';
import { isFullSha, readRuntimeIdentity } from './read-runtime-identity.mjs';

function gitSucceeds(args, { cwd, execFileSync }) {
  try {
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export function runPreflight({
  target,
  baseline,
  identityPath,
  mainRef = 'main',
  cwd = process.cwd(),
  execFileSync = defaultExecFileSync,
  readFileSync,
}) {
  const blockingReasons = [];
  const targetIsFullSha = isFullSha(target);
  const baselineIsFullSha = isFullSha(baseline);

  if (!targetIsFullSha) {
    blockingReasons.push('Target must be a complete 40-character SHA.');
  }
  if (!baselineIsFullSha) {
    blockingReasons.push('Baseline must be a complete 40-character SHA.');
  }

  if (targetIsFullSha && !gitSucceeds(['merge-base', '--is-ancestor', target, mainRef], { cwd, execFileSync })) {
    blockingReasons.push(`Target ${target} is not reachable from ${mainRef}.`);
  }
  if (targetIsFullSha && baselineIsFullSha
    && !gitSucceeds(['merge-base', '--is-ancestor', baseline, target], { cwd, execFileSync })) {
    blockingReasons.push(`Baseline ${baseline} is not an ancestor of target ${target}.`);
  }

  const identity = readRuntimeIdentity({ identityPath, readFileSync });
  blockingReasons.push(...identity.blockingReasons);
  if (identity.ok) {
    if (identity.identity.gitSha !== baseline) blockingReasons.push('Production runtime identity gitSha does not match the supplied baseline.');
    for (const [component, entry] of Object.entries(identity.identity.components)) {
      if (!gitSucceeds(['merge-base', '--is-ancestor', entry.gitSha, target], { cwd, execFileSync })) {
        blockingReasons.push(`Production component ${component} SHA is not an ancestor of target.`);
      }
    }
  }

  const classification = targetIsFullSha && baselineIsFullSha
    ? classifyComponents({ baseline, target, cwd, execFileSync })
    : { ok: false, changedFiles: [], components: [], blockingReasons: [] };
  blockingReasons.push(...classification.blockingReasons);

  return {
    ok: blockingReasons.length === 0,
    target,
    baseline,
    mainRef,
    changedFiles: classification.changedFiles,
    components: classification.components,
    identity: identity.ok ? identity.identity : null,
    blockingReasons,
  };
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
  const result = runPreflight({
    target: args.target,
    baseline: args.baseline,
    identityPath: args.identity,
    mainRef: args.main ?? 'main',
    cwd: args.cwd ?? process.cwd(),
  });

  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

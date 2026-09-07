import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Output only release identity, never the full process environment.
const result = {};
for (const [component, unit] of [
  ['api', 'agent-saas-server-staging.service'],
  ['runtimeWorker', 'agent-saas-runtime-worker-staging.service'],
]) {
  try {
    const pid = execFileSync('systemctl', ['show', unit, '--property=MainPID', '--value'], {
      encoding: 'utf8',
    }).trim();
    if (!/^[1-9][0-9]*$/u.test(pid)) throw new Error('No live PID');
    const env = Object.fromEntries(
      readFileSync(`/proc/${pid}/environ`, 'utf8')
        .split('\0')
        .filter(Boolean)
        .map((line) => {
          const index = line.indexOf('=');
          return [line.slice(0, index), line.slice(index + 1)];
        }),
    );
    if (env.AGENT_SAAS_ENVIRONMENT !== 'staging') throw new Error('Wrong environment');
    if (
      component === 'runtimeWorker' &&
      readFileSync('/run/agent-saas-staging/runtime-worker.ready', 'utf8').trim() !== pid
    )
      throw new Error('Worker not ready');
    result[component] = {
      pid,
      releaseId: env.AGENT_SAAS_RELEASE_ID,
      sourceSha: env.AGENT_SAAS_RELEASE_SHA,
      artifactDigest: env.AGENT_SAAS_SERVER_DIGEST,
    };
  } catch {
    result[component] = { error: 'Process identity unavailable' };
  }
}
process.stdout.write(JSON.stringify(result));

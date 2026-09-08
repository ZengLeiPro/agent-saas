import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Exercise the published Node entry; only the external Kubernetes control plane is simulated. */
export async function verifyAcsPackage(directory, temporary) {
  const allocator = createServer();
  await new Promise((resolve) => allocator.listen(0, '127.0.0.1', resolve));
  const port = allocator.address().port;
  await new Promise((resolve) => allocator.close(resolve));
  const kubectl = join(temporary, 'fixture-kubectl');
  await writeFile(
    kubectl,
    `#!/bin/sh
case "$*" in
  *"auth can-i"*) echo yes ;;
  *"-o json"*) echo '{"items":[]}' ;;
  *"get crd"*|*"get namespace"*) echo fixture ;;
  *) echo 'unsupported fixture Kubernetes command' >&2; exit 1 ;;
esac
`,
    { mode: 0o700 },
  );
  const child = spawn(process.execPath, ['dist/index.js'], {
    cwd: directory,
    env: {
      PATH: process.env.PATH,
      HOME: temporary,
      NODE_ENV: 'production',
      ACS_ORCH_AUTH_TOKEN: 'fixture-acs-package-token',
      ACS_ORCH_HOST: '127.0.0.1',
      ACS_ORCH_PORT: String(port),
      ACS_NAMESPACE: 'package-smoke',
      ACS_SANDBOX_IMAGE: `registry.example.invalid/smoke@sha256:${'a'.repeat(64)}`,
      ACS_KUBECTL_PATH: kubectl,
      KUBECONFIG: join(temporary, 'absent-kubeconfig'),
      ACS_SANDBOX_LIFECYCLE_ENABLED: 'false',
      ACS_SNAT_MODE: 'disabled',
      ACS_ORCH_PIDFILE: join(temporary, 'acs.pid'),
      ACS_ORCH_DRAIN_STATE_FILE: join(temporary, 'acs-drain.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => {
    logs += chunk;
  });
  child.stderr.on('data', (chunk) => {
    logs += chunk;
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`Published ACS exited during startup: ${logs}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(3000),
        });
        const health = await response.json();
        assert.equal(response.status, 200);
        assert.equal(health.status, 'ok');
        assert.equal(health.namespace, 'package-smoke');
        assert.equal(health.inflight, 0);
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.ok(ready, `Published ACS did not become ready: ${logs}`);
    const denied = await fetch(`http://127.0.0.1:${port}/execute`, {
      method: 'POST',
      body: '{}',
      signal: AbortSignal.timeout(3000),
    });
    assert.equal(denied.status, 401, 'Published ACS must reject unauthenticated execution');
    child.kill('SIGUSR2');
    for (
      let attempt = 0;
      attempt < 100 && child.exitCode === null && child.signalCode === null;
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(child.exitCode, 0, 'Published ACS must gracefully retire the exact process');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
    }
  }
}

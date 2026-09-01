#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { spawnSync } from 'node:child_process';

const RELEASE_ID_PATTERN = /^rc-\d{8}-\d{2,}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const STAGING_ROOT = '/mnt/agent-saas-staging';
const CONFIG_PATH = '/var/lib/agent-saas-staging/config/config.json';
const KUBECONFIG = '/etc/agent-saas-staging/kubeconfig';
const CURRENT_SERVER = '/opt/agent-saas-staging/current/server';

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

function evidenceDigest(observed) {
  return `sha256:${createHash('sha256').update(canonicalJson(observed)).digest('hex')}`;
}

function probe(id, status, targetEnvironment, observed, observedAt) {
  return {
    id,
    status,
    sourceEnvironment: 'staging',
    targetEnvironment,
    observed,
    observedAt,
    evidenceDigest: evidenceDigest(observed),
  };
}

function run(command, args, { acceptedStatuses = [0] } = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 15_000,
  });
  if (!acceptedStatuses.includes(result.status ?? -1)) {
    throw new Error(`${command} failed with status ${result.status}: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

async function connectionDenied(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => finish({ denied: true, reason: 'timeout' }), 3_000);
    timer.unref?.();
    const finish = (value) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => finish({ denied: false, reason: 'connected' }));
    socket.once('error', (error) =>
      finish({ denied: true, reason: String(error.code ?? error.message) }),
    );
    socket.once('close', () => undefined);
    socket.once('timeout', () => reject(new Error('unexpected socket timeout event')));
  });
}

async function collectDatabaseProbe(config, targets, resources) {
  const connection = new URL(config.runtimeEventStore.connectionString);
  connection.pathname = `/${targets.productionDatabase}`;
  const requireFromRelease = createRequire(`${CURRENT_SERVER}/package.json`);
  const { Client } = requireFromRelease('pg');
  const client = new Client({
    connectionString: connection.toString(),
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
  });
  await client.connect();
  try {
    const result = await client.query(
      `SELECT current_user AS username,
              has_database_privilege(current_user,current_database(),$1) AS database_create,
              has_schema_privilege(current_user,$2,$1) AS schema_create,
              to_regclass($3)::text AS runtime_table,
              CASE WHEN to_regclass($3) IS NULL THEN NULL
                   ELSE has_table_privilege(current_user,$3,$4) END AS can_select,
              CASE WHEN to_regclass($3) IS NULL THEN NULL
                   ELSE has_table_privilege(current_user,$3,$5) END AS can_write`,
      [
        'CREATE',
        'public',
        `public.${targets.productionRuntimeTable}`,
        'SELECT',
        'INSERT,UPDATE,DELETE',
      ],
    );
    const row = result.rows[0];
    if (
      row?.username !== resources.database.role ||
      row.runtime_table !== targets.productionRuntimeTable ||
      row.database_create !== false ||
      row.schema_create !== false ||
      row.can_select !== false ||
      row.can_write !== false
    ) {
      throw new Error('Staging database role has unexpected Production privileges');
    }
    return {
      database: targets.productionDatabase,
      role: row.username,
      runtimeTable: row.runtime_table,
      databaseCreate: row.database_create,
      schemaCreate: row.schema_create,
      canSelect: row.can_select,
      canWrite: row.can_write,
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

function collectKubernetesProbe(targets, resources) {
  const impersonate = `system:serviceaccount:${resources.acs.namespace}:${resources.acs.serviceAccount}`;
  const canReadSandbox = run(
    'kubectl',
    [
      '--kubeconfig',
      KUBECONFIG,
      'auth',
      'can-i',
      'get',
      'sandboxes',
      '-n',
      targets.productionNamespace,
      `--as=${impersonate}`,
    ],
    { acceptedStatuses: [0, 1] },
  );
  const canReadPods = run(
    'kubectl',
    [
      '--kubeconfig',
      KUBECONFIG,
      'auth',
      'can-i',
      'get',
      'pods',
      '-n',
      targets.productionNamespace,
      `--as=${impersonate}`,
    ],
    { acceptedStatuses: [0, 1] },
  );
  if (canReadSandbox !== 'no' || canReadPods !== 'no') {
    throw new Error('Staging ACS service account can read Production namespace resources');
  }
  return {
    serviceAccount: impersonate,
    namespace: targets.productionNamespace,
    canReadSandbox,
    canReadPods,
  };
}

function collectWorkspaceProbe(resources) {
  const pvc = JSON.parse(
    run('kubectl', [
      '--kubeconfig',
      KUBECONFIG,
      '-n',
      resources.acs.namespace,
      'get',
      'pvc',
      resources.acs.pvc,
      '-o',
      'json',
    ]),
  );
  const pv = JSON.parse(
    run('kubectl', ['--kubeconfig', KUBECONFIG, 'get', 'pv', pvc.spec.volumeName, '-o', 'json']),
  );
  const observed = {
    namespace: pvc.metadata.namespace,
    pvc: pvc.metadata.name,
    volumeName: pvc.spec.volumeName,
    serverPath: pv.spec.csi?.volumeAttributes?.path ?? null,
    workspaceRoot: resources.acs.workspaceRoot,
    productionWorkspaceMounted: false,
    sharedFilesystemLogicalIsolation: true,
    residualRisk: resources.nas.residualRisk,
  };
  if (
    observed.namespace !== resources.acs.namespace ||
    observed.pvc !== resources.acs.pvc ||
    observed.volumeName !== resources.acs.pv ||
    observed.serverPath !== resources.nas.serverPath ||
    observed.workspaceRoot !== `${STAGING_ROOT}/workspaces`
  ) {
    throw new Error('Staging Sandbox workspace PVC or path identity is inconsistent');
  }
  return observed;
}

function collectNasProbe(resources, targets) {
  const mount = JSON.parse(
    run('findmnt', ['-J', '-T', resources.nas.mountRoot, '-o', 'TARGET,SOURCE,FSTYPE,OPTIONS']),
  ).filesystems?.[0];
  const expectedSource = `${resources.nas.mountTarget}:${resources.nas.serverPath}`;
  const productionNamesVisible = targets.productionMountPaths.some((path) => existsSync(path));
  const observed = {
    mountTarget: mount?.target ?? null,
    mountSource: mount?.source ?? null,
    serverPath: resources.nas.serverPath,
    sourceCidr: resources.nas.sourceCidr,
    userAccess: resources.nas.userAccess,
    filesystem: mount?.fstype ?? null,
    productionNamesVisible,
    residualRisk: resources.nas.residualRisk,
  };
  if (
    observed.mountTarget !== resources.nas.mountRoot ||
    observed.mountSource !== expectedSource ||
    observed.filesystem !== 'nfs' ||
    productionNamesVisible
  ) {
    throw new Error('Staging NAS mount does not prove the expected all-squash subdirectory');
  }
  return observed;
}

export async function collectHostIsolationEvidence({ releaseId, resourcePlan, config }) {
  const resources = resourcePlan.resources;
  const targets = resources.isolationTargets;
  if (resourcePlan.environment !== 'staging' || !targets) {
    throw new Error('Staging isolation targets are missing');
  }
  const manifest = JSON.parse(
    await readFile('/opt/agent-saas-staging/current/manifest.json', 'utf8'),
  );
  if (manifest.releaseId !== releaseId || !DIGEST_PATTERN.test(manifest.digest ?? '')) {
    throw new Error('Live Staging release does not match the requested isolation probe');
  }
  const observedAt = new Date().toISOString();
  const database = await collectDatabaseProbe(config, targets, resources);
  const productionAcs = await connectionDenied(
    targets.productionAcsHost,
    targets.productionAcsPort,
  );
  if (!productionAcs.denied) throw new Error('Staging host can connect to the Production ACS');
  const hands = config.tenantRemoteHands?.hands ?? [];
  if (
    hands.length !== 1 ||
    hands[0]?.id !== 'agent-saas-staging-acs' ||
    new URL(hands[0].baseUrl).hostname !== '127.0.0.1' ||
    Number(new URL(hands[0].baseUrl).port) !== resources.acs.orchestratorPort
  ) {
    throw new Error('Staging API/Worker hand configuration is not isolated');
  }
  if (config.alerting?.enabled !== false || Object.keys(config.alerting).length !== 1) {
    throw new Error('Staging notification delivery is not disabled');
  }
  const nas = collectNasProbe(resources, targets);
  const serviceAccount = collectKubernetesProbe(targets, resources);
  const workspace = collectWorkspaceProbe(resources);
  return {
    schemaVersion: 1,
    environment: 'staging',
    releaseId,
    manifestDigest: manifest.digest,
    observedAt,
    probes: [
      probe(
        'database-role-cannot-read-or-write-production',
        'denied',
        'production',
        database,
        observedAt,
      ),
      probe(
        'nas-client-is-all-squashed-and-mounted-to-staging-subdirectory',
        'verified-with-accepted-residual-risk',
        'staging',
        nas,
        observedAt,
      ),
      probe(
        'notification-identity-cannot-deliver-to-production',
        'denied',
        'production',
        {
          alertingEnabled: false,
          configuredKeys: Object.keys(config.alerting),
          deliveryPolicy: resources.notifications.deliveryPolicy,
        },
        observedAt,
      ),
      probe(
        'api-worker-cannot-connect-production-hand-or-acs',
        'denied',
        'production',
        { configuredHands: hands.map(({ id, baseUrl }) => ({ id, baseUrl })), productionAcs },
        observedAt,
      ),
      probe(
        'acs-service-account-cannot-read-production-namespace-resources',
        'denied',
        'production',
        serviceAccount,
        observedAt,
      ),
      probe(
        'sandbox-workspace-uses-staging-only-pvc-and-paths',
        'verified-with-accepted-residual-risk',
        'staging',
        workspace,
        observedAt,
      ),
    ],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [environment, releaseId, resourcePlanPath] = process.argv.slice(2);
  if (environment !== 'staging' || !RELEASE_ID_PATTERN.test(releaseId ?? '') || !resourcePlanPath) {
    throw new Error('usage: collect-isolation-host.mjs staging <release-id> <resource-plan>');
  }
  const [resourcePlan, config] = await Promise.all([
    readFile(resourcePlanPath, 'utf8').then(JSON.parse),
    readFile(CONFIG_PATH, 'utf8').then(JSON.parse),
  ]);
  process.stdout.write(
    `${JSON.stringify(await collectHostIsolationEvidence({ releaseId, resourcePlan, config }))}\n`,
  );
}

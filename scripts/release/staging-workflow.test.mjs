import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowPath = new URL('../../.github/workflows/deploy-staging.yml', import.meta.url);
const deployPath = new URL('./deploy-staging-release.sh', import.meta.url);
const resourcePath = new URL('../../infra/staging/resource-plan.json', import.meta.url);
const acsRuntimePath = new URL('../../infra/staging/acs-runtime.yaml', import.meta.url);
const observationPath = new URL('./observe-production.mjs', import.meta.url);
const isolationPath = new URL('../staging/assert-isolation.mjs', import.meta.url);
const serverUnitPath = new URL(
  '../../daemon-packaging/systemd/agent-saas-server-staging.service.template',
  import.meta.url,
);
const workerUnitPath = new URL(
  '../../daemon-packaging/systemd/agent-saas-runtime-worker-staging.service.template',
  import.meta.url,
);

function runScriptLines(text) {
  const output = [];
  let runIndent = null;
  for (const line of text.split('\n')) {
    const indentation = line.match(/^\s*/u)[0].length;
    if (runIndent !== null && line.trim() && indentation <= runIndent) runIndent = null;
    const start = line.match(/^(\s*)run:\s*\|\s*$/u);
    if (start) {
      runIndent = start[1].length;
      continue;
    }
    if (runIndent !== null) output.push(line);
  }
  return output;
}

test('Staging workflow accepts only a reason and locks the dispatch SHA and single slot', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  assert.match(workflow, /workflow_dispatch:[\s\S]*reason:/u);
  assert.doesNotMatch(workflow, /release_sha:/u);
  assert.match(workflow, /group: staging-deploy\s+cancel-in-progress: false/u);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/u);
  assert.match(workflow, /test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"/u);
  assert.match(
    workflow,
    /created_at="\$\(node -e "process\.stdout\.write\(new Date\(process\.argv\[1\]\)\.toISOString\(\)\)" "\$created_at"\)"/u,
  );
  assert.match(workflow, /environment: staging/u);
  assert.match(workflow, /STAGING_WEB_URL: https:\/\/staging-agent\.kaiyan\.net/u);
  assert.match(workflow, /STAGING_API_URL: https:\/\/staging-agent-api\.kaiyan\.net/u);
  assert.match(workflow, /VITE_API_BASE: \$\{\{ env\.STAGING_API_URL \}\}/u);
  assert.match(workflow, /VITE_WEB_ORIGIN: \$\{\{ env\.STAGING_WEB_URL \}\}/u);
  assert.doesNotMatch(workflow, /vars\.STAGING_E2E_INTEGRATION_TASK_ID/u);
  assert.match(workflow, /ensure-integration-fixture\.mjs/u);
  assert.match(workflow, /STAGING_E2E_INTEGRATION_TASK_ID=\$integration_task_id/u);
  assert.match(workflow, /touch "\$RUNNER_TEMP\/staging-fixtures-touched"/u);
  assert.match(workflow, /if \[ ! -f "\$RUNNER_TEMP\/staging-fixtures-touched" \]; then/u);
  assert.match(workflow, /infra\/staging\/resource-plan\.json/u);
  assert.match(workflow, /plan\.firstDeploymentReadiness !== 'ready'/u);
  assert.match(workflow, /blockers\.length > 0/u);
  assert.match(workflow, /REUSE_RC=true/u);
  assert.match(workflow, /state staging_deployed/u);
  assert.match(workflow, /state verified/u);
  assert.match(workflow, /web-oss-readback/u);
  assert.match(workflow, /manifest-digest: \$MANIFEST_DIGEST/u);
  assert.match(workflow, /publish-release-record\.mjs/u);
  assert.match(workflow, /name: Verify completed Staging evidence bundle\s+if: success\(\)/u);
  assert.match(workflow, /test -f "\$RUNNER_TEMP\/\$evidence"/u);
  assert.match(workflow, /if-no-files-found: warn/u);
  assert.match(workflow, /name: Authorize current runner for Staging SSH/u);
  assert.match(workflow, /https:\/\/api\.ipify\.org/u);
  assert.match(workflow, /\.resources\.api\.securityGroupId/u);
  assert.match(workflow, /aliyun ecs AuthorizeSecurityGroup/u);
  assert.match(workflow, /--SourceCidrIp "\$source_cidr"/u);
  assert.doesNotMatch(workflow, /--SourceCidrIp 0\.0\.0\.0\/0/u);
  assert.match(
    workflow,
    /name: Revoke temporary Staging SSH ingress\s+if: always\(\) && env\.STAGING_SSH_SOURCE_CIDR != ''/u,
  );
  assert.match(workflow, /aliyun ecs RevokeSecurityGroup/u);
  assert.match(workflow, /ssh-keyscan -T 10 -t ed25519/u);
  assert.doesNotMatch(workflow, /compatibilityEvidenceDigest|N\/N\+1/u);
  assert.doesNotMatch(workflow, /--clobber/u);
  const deployIndex = workflow.indexOf('Deploy exact Staging API, Worker and ACS artifacts');
  const migrationIndex = workflow.indexOf(
    'Verify migrations and create isolated Integration fixture',
  );
  const e2eIndex = workflow.indexOf('Run real browser and ACS E2E');
  assert.ok(deployIndex > 0 && deployIndex < migrationIndex && migrationIndex < e2eIndex);
  assert.ok(runScriptLines(workflow).every((line) => !/\$\{\{\s*inputs\./u.test(line)));
});

test('target deployment consumes bundles without source install/build and uses only Staging paths', async () => {
  const deploy = await readFile(deployPath, 'utf8');
  assert.doesNotMatch(deploy, /pnpm (install|build)|npm (install|run)/u);
  assert.doesNotMatch(deploy, /\/opt\/agent-saas-app|agent-saas-server@|active-color/u);
  assert.match(deploy, /\/opt\/agent-saas-staging/u);
  assert.match(deploy, /agent-saas-acs-orchestrator-staging\.service/u);
  assert.match(deploy, /kill -USR2/u);
  assert.match(deploy, /orchestratorArtifactDigest/u);
  assert.match(deploy, /sandboxImageDigest/u);
  assert.match(deploy, /rollback_root/u);
  assert.match(deploy, /deployment_committed=true/u);
  assert.match(deploy, /chown root:agent-saas-staging "\$server_env"/u);
  assert.match(deploy, /chown root:agent-saas-staging "\$acs_env"/u);
  assert.match(deploy, /trap finish EXIT/u);
  assert.match(deploy, /verify --root "\$target" --component server/u);
});

test('resource plan records provisioned resources ready for first deployment', async () => {
  const plan = JSON.parse(await readFile(resourcePath, 'utf8'));
  assert.equal(plan.environment, 'staging');
  assert.equal(plan.status, 'provisioned');
  assert.equal(plan.verificationStatus, 'pending');
  assert.equal(plan.firstDeploymentReadiness, 'ready');
  assert.deepEqual(plan.blockingConditions, []);
  assert.notEqual(plan.resources.acs.namespace, 'agent-saas-coding');
  assert.equal(plan.resources.acs.status, 'applied');
  assert.equal(plan.resources.acs.clusterId, 'c819935b09a7d4a2a844561ef22a17448');
  assert.equal(plan.resources.acs.sharedComputePool, true);
  assert.equal(plan.resources.database.instanceId, 'pgm-wz96n2735914490l');
  assert.equal(plan.resources.nas.isolationLevel, 'logical-shared-filesystem');
  assert.equal(plan.resources.releaseEvidence.status, 'active-authenticated-and-readback-verified');
  assert.equal(plan.resources.egressProxy.listen, '127.0.0.1:3128');
  assert.equal(plan.resources.e2eIdentity.status, 'created-password-hash-verified');
  assert.equal(plan.resources.e2eIdentity.integrationFixture.state, 'canceled');
  assert.equal(plan.defaults.cronEnabled, false);
  assert.equal(plan.defaults.productionOAuthEnabled, false);
  assert.ok(!JSON.stringify(plan).includes('UNASSIGNED'));
  assert.equal(plan.requiredEvidence.length, 7);
  assert.ok(
    plan.requiredEvidence.includes(
      'nas-client-is-all-squashed-and-mounted-to-staging-subdirectory',
    ),
  );
  assert.ok(plan.requiredEvidence.includes('sandbox-workspace-uses-staging-only-pvc-and-paths'));
});

test('Staging ACS binds a static shared-NAS subdirectory without using a missing dynamic class', async () => {
  const runtime = await readFile(acsRuntimePath, 'utf8');
  assert.match(runtime, /kind: PersistentVolume[\s\S]*name: agent-saas-staging-workspace/u);
  assert.match(runtime, /path: \/agent-saas-staging/u);
  assert.match(runtime, /volumeName: agent-saas-staging-workspace/u);
  assert.match(runtime, /storageClassName: agent-saas-staging-nas-csi/u);
  assert.doesNotMatch(runtime, /alibabacloud-cnfs-nas/u);
});

test('Evidence Service dependencies suppress their standalone CLIs when bundled', async () => {
  for (const path of [observationPath, isolationPath]) {
    const source = await readFile(path, 'utf8');
    assert.match(source, /process\.env\.AGENT_SAAS_EMBEDDED !== 'true'/u);
  }
});

test('Staging API and Worker keep mutable runtime data under the isolated NAS root', async () => {
  for (const path of [serverUnitPath, workerUnitPath]) {
    const unit = await readFile(path, 'utf8');
    assert.match(unit, /User=agent-saas-staging/u);
    assert.match(unit, /Group=agent-saas-staging/u);
    assert.match(unit, /WorkingDirectory=\/mnt\/agent-saas-staging\/runtime\/server/u);
    assert.match(unit, /ExecStart=.*\/opt\/agent-saas-staging\/current\/server\/dist\/index\.js/u);
  }
});

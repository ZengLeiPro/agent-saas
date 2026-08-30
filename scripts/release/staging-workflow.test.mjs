import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowPath = new URL('../../.github/workflows/deploy-staging.yml', import.meta.url);
const acceptanceWorkflowPath = new URL(
  '../../.github/workflows/staging-acceptance.yml',
  import.meta.url,
);
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
const serverPackagePath = new URL('../../server/package.json', import.meta.url);
const scenarioRoutesPath = new URL('../../server/src/routes/scenarios.ts', import.meta.url);
const staticDataCopyPath = new URL('../../server/scripts/copy-static-data.mjs', import.meta.url);
const e2eHelpersPath = new URL('../../e2e/staging/helpers.ts', import.meta.url);
const e2eConfigPath = new URL('../../e2e/playwright.config.ts', import.meta.url);
const e2eGlobalSetupPath = new URL('../../e2e/staging/global-setup.ts', import.meta.url);
const chatInputPath = new URL('../../web/src/components/ChatInput.tsx', import.meta.url);

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
  assert.match(workflow, /VITE_API_BASE: https:\/\/api\.agent\.kaiyan\.net/u);
  assert.match(workflow, /VITE_WEB_ORIGIN: https:\/\/agent\.kaiyan\.net/u);
  assert.doesNotMatch(workflow, /VITE_API_BASE: \$\{\{ env\.STAGING_API_URL \}\}/u);
  assert.doesNotMatch(workflow, /vars\.STAGING_E2E_INTEGRATION_TASK_ID/u);
  assert.doesNotMatch(workflow, /STAGING_E2E_PASSWORD|playwright test|playwright-report/u);
  assert.match(workflow, /ensure-integration-fixture\.mjs/u);
  assert.match(workflow, /infra\/staging\/resource-plan\.json/u);
  assert.match(workflow, /plan\.firstDeploymentReadiness !== 'ready'/u);
  assert.match(workflow, /blockers\.length > 0/u);
  assert.match(workflow, /REUSE_RC=true/u);
  assert.match(workflow, /state staging_deployed/u);
  assert.match(workflow, /state verified/u);
  assert.match(workflow, /deterministic-deployment-gates-v1/u);
  assert.match(workflow, /--arg stagingRunId "\$GITHUB_RUN_ID"/u);
  assert.match(workflow, /web-oss-readback/u);
  assert.match(
    workflow,
    /oss cp "\$RUNNER_TEMP\/web-assets\/" "\$STAGING_WEB_OSS_URI\/"[\s\S]*--recursive --force --exclude index\.html --exclude release-identity\.json/u,
  );
  assert.doesNotMatch(workflow, /oss sync|--delete/u);
  const webIdentityIndex = workflow.indexOf('"$STAGING_WEB_OSS_URI/release-identity.json" --force');
  const webEntryIndex = workflow.indexOf('"$STAGING_WEB_OSS_URI/index.html" --force');
  assert.ok(webIdentityIndex > 0 && webIdentityIndex < webEntryIndex);
  assert.match(workflow, /manifest-digest: \$MANIFEST_DIGEST/u);
  assert.match(workflow, /publish-release-record\.mjs/u);
  assert.match(workflow, /\.artifacts\.stagingRuntimeAssets\.path/u);
  assert.match(workflow, /test "\$runtime_path" = staging-runtime-assets\.tgz/u);
  assert.match(workflow, /STAGING_RUNTIME_ASSETS_PATH='\$remote\/staging-runtime-assets\.tgz'/u);
  assert.match(workflow, /--argjson runtimeSummary/u);
  assert.match(workflow, /stagingRuntimeAssetsDigest/u);
  assert.match(workflow, /\$\{\{ runner\.temp \}\}\/staging-runtime-summary\.json/u);
  assert.match(workflow, /name: Verify completed Staging evidence bundle\s+if: success\(\)/u);
  assert.match(workflow, /test -f "\$RUNNER_TEMP\/\$evidence"/u);
  assert.match(workflow, /if-no-files-found: warn/u);
  assert.match(workflow, /name: Authorize current runner for Staging SSH/u);
  assert.match(workflow, /https:\/\/api\.ipify\.org/u);
  assert.match(workflow, /\.resources\.api\.securityGroupId/u);
  assert.match(workflow, /aliyun --region cn-shenzhen ecs AuthorizeSecurityGroup/u);
  assert.match(workflow, /--SourceCidrIp "\$source_cidr"/u);
  assert.doesNotMatch(workflow, /--SourceCidrIp 0\.0\.0\.0\/0/u);
  assert.match(
    workflow,
    /name: Revoke temporary Staging SSH ingress\s+if: always\(\) && env\.STAGING_SSH_SOURCE_CIDR != ''/u,
  );
  assert.match(workflow, /aliyun --region cn-shenzhen ecs RevokeSecurityGroup/u);
  assert.match(workflow, /ssh-keyscan -T 10 -t ed25519/u);
  assert.match(
    workflow,
    /daemon-packaging\/systemd\/agent-saas-server-staging\.service\.template/u,
  );
  assert.match(
    workflow,
    /daemon-packaging\/systemd\/agent-saas-runtime-worker-staging\.service\.template/u,
  );
  assert.match(
    workflow,
    /daemon-packaging\/systemd\/agent-saas-acs-orchestrator-staging\.service\.template/u,
  );
  assert.match(workflow, /UNIT_DIR='\$remote'/u);
  assert.doesNotMatch(workflow, /compatibilityEvidenceDigest|N\/N\+1/u);
  assert.doesNotMatch(workflow, /--clobber/u);
  const deployIndex = workflow.indexOf('Deploy exact Staging API, Worker and ACS artifacts');
  const migrationIndex = workflow.indexOf('Verify migrations and isolated Integration fixture');
  const isolationIndex = workflow.indexOf('Verify live reverse-isolation evidence');
  const recordIndex = workflow.indexOf('Record deterministic Staging deployment and verification');
  assert.ok(
    deployIndex > 0 &&
      deployIndex < migrationIndex &&
      migrationIndex < isolationIndex &&
      isolationIndex < recordIndex,
  );
  assert.ok(runScriptLines(workflow).every((line) => !/\$\{\{\s*inputs\./u.test(line)));
});

test('full browser and Agent acceptance is optional, release-bound, and outside deployment attestations', async () => {
  const workflow = await readFile(acceptanceWorkflowPath, 'utf8');
  assert.match(workflow, /name: Staging Acceptance/u);
  assert.match(workflow, /workflow_dispatch:[\s\S]*release_id:/u);
  assert.match(workflow, /group: staging-acceptance\s+cancel-in-progress: false/u);
  assert.match(workflow, /\[\[ "\$RELEASE_ID_INPUT" =~ \^rc-/u);
  assert.match(workflow, /ref: refs\/tags\/\$\{\{ inputs\.release_id \}\}/u);
  assert.match(workflow, /Verify exact RC is still active on Staging/u);
  assert.match(workflow, /staging-web-identity\.json/u);
  assert.match(workflow, /staging-api-ready\.json/u);
  assert.match(workflow, /Run browser and Agent acceptance suite/u);
  assert.match(workflow, /playwright test -c e2e\/playwright\.config\.ts/u);
  assert.match(workflow, /summarize-e2e\.mjs/u);
  assert.match(workflow, /Clean and read back Staging acceptance fixtures\s+if: always\(\)/u);
  assert.match(workflow, /retention-days: 14/u);
  assert.doesNotMatch(workflow, /releaseAttestationCli|state approved|deploy-staging-release\.sh/u);
  assert.ok(runScriptLines(workflow).every((line) => !/\$\{\{\s*inputs\./u.test(line)));
});

test('Staging browser authentication is preloaded without recording the password and uses a stable composer label', async () => {
  const helpers = await readFile(e2eHelpersPath, 'utf8');
  const config = await readFile(e2eConfigPath, 'utf8');
  const globalSetup = await readFile(e2eGlobalSetupPath, 'utf8');
  const chatInput = await readFile(chatInputPath, 'utf8');
  assert.match(config, /globalSetup: '\.\/staging\/global-setup\.ts'/u);
  assert.match(config, /storageState: stagingStorageStatePath/u);
  assert.match(config, /maxFailures: process\.env\.CI \? 1 : 0/u);
  assert.match(config, /trace: 'off'/u);
  assert.match(config, /testMatch: \/\(\?:auth\|chat-stream\)\\\.spec\\\.ts\/u/u);
  assert.match(globalSetup, /fetch\(`\$\{apiUrl\}\/api\/auth\/login`/u);
  assert.match(globalSetup, /writeFile\([\s\S]*\{ mode: 0o600 \}/u);
  assert.match(globalSetup, /chromium\.launch\(\)/u);
  assert.match(globalSetup, /getByRole\('textbox', \{ name: '消息输入' \}\)\.waitFor/u);
  assert.doesNotMatch(helpers, /getByLabel\('密码'\)\.fill/u);
  assert.match(helpers, /getByRole\('textbox', \{ name: '消息输入' \}\)/u);
  assert.match(chatInput, /aria-label="消息输入"/u);
});

test('target deployment consumes bundles without source install/build and uses only Staging paths', async () => {
  const deploy = await readFile(deployPath, 'utf8');
  assert.doesNotMatch(deploy, /pnpm (install|build)|npm (install|run)/u);
  assert.doesNotMatch(deploy, /\/opt\/agent-saas-app|agent-saas-server@|active-color/u);
  assert.match(deploy, /\/opt\/agent-saas-staging/u);
  assert.match(deploy, /UNIT_DIR:\?UNIT_DIR is required/u);
  assert.match(deploy, /install_staging_unit/u);
  assert.match(deploy, /systemctl daemon-reload/u);
  assert.match(deploy, /\/mnt\/agent-saas-staging\/runtime\/server/u);
  assert.match(
    deploy,
    /runuser -u agent-saas-staging -- sh -c[\s\S]*umask 027; mkdir -p -- "\$1"/u,
  );
  assert.doesNotMatch(
    deploy,
    /install -d -o agent-saas-staging -g agent-saas-staging[\s\S]*\/mnt\/agent-saas-staging\/runtime\/server/u,
  );
  assert.match(deploy, /Staging runtime directory is not \$\{access\}-accessible/u);
  assert.match(deploy, /does not use the persistent Staging runtime directory/u);
  assert.match(deploy, /does not execute the immutable Staging server entrypoint/u);
  assert.match(deploy, /agent-saas-acs-orchestrator-staging\.service/u);
  assert.match(deploy, /kill -USR2/u);
  assert.match(deploy, /orchestratorArtifactDigest/u);
  assert.match(deploy, /sandboxImageDigest/u);
  assert.match(deploy, /rollback_root/u);
  assert.match(deploy, /deployment_committed=true/u);
  assert.match(deploy, /if \[ -L "\$current" \]; then/u);
  assert.match(deploy, /readlink -f -- "\$current"/u);
  assert.match(deploy, /had_previous_release=false/u);
  assert.match(deploy, /if \[ "\$had_previous_release" = true \]; then/u);
  assert.match(deploy, /systemctl stop agent-saas-acs-orchestrator-staging\.service/u);
  assert.match(deploy, /rm -f \/run\/agent-saas-staging\/server\.pid/u);
  assert.match(deploy, /\/run\/agent-saas-staging\/acs-orchestrator\.pid/u);
  assert.match(deploy, /systemctl reset-failed agent-saas-runtime-worker-staging\.service/u);
  assert.match(deploy, /Staging ACS configuration is missing \$\{key\}/u);
  assert.match(deploy, /Staging ACS shared-cidr mode has no configured CIDR/u);
  assert.match(deploy, /aliyun_cli="\$\(command -v aliyun\)"/u);
  assert.match(
    deploy,
    /Staging ACS SNAT is enabled but the aliyun CLI runtime dependency is missing/u,
  );
  assert.match(
    deploy,
    /runuser -u agent-saas-staging -- env HOME=\/var\/lib\/agent-saas-staging\/acs/u,
  );
  assert.match(deploy, /"\$aliyun_cli" vpc DescribeSnatTableEntries/u);
  assert.match(deploy, /Staging ACS SNAT runtime identity cannot read the configured SNAT table/u);
  assert.match(deploy, /STAGING_RELEASE_ROOT="\$target"/u);
  assert.match(
    deploy,
    /systemctl show agent-saas-runtime-worker-staging\.service --property Environment --value/u,
  );
  assert.match(deploy, /AGENT_SAAS_READYFILE=\/run\/agent-saas-staging\/runtime-worker\.ready/u);
  assert.match(deploy, /does not publish the canonical readyfile/u);
  assert.match(
    deploy,
    /AGENT_SAAS_ACTIVE_RUNTIME_WORKER_READYFILE=\/run\/agent-saas-staging\/runtime-worker\.ready/u,
  );
  assert.match(deploy, /does not observe the canonical Runtime Worker readyfile/u);
  assert.match(deploy, /Staging server bundle must contain server\/dist\/index\.js/u);
  assert.match(deploy, /Staging ACS bundle must contain acs-orchestrator\/dist\/index\.js/u);
  assert.match(deploy, /STAGING_RUNTIME_ASSETS_PATH:\?STAGING_RUNTIME_ASSETS_PATH is required/u);
  assert.match(
    deploy,
    /STAGING_RUNTIME_ASSETS_DIGEST:\?STAGING_RUNTIME_ASSETS_DIGEST is required/u,
  );
  assert.match(deploy, /sha256sum "\$STAGING_RUNTIME_ASSETS_PATH"/u);
  assert.match(deploy, /staging-runtime-assets\.tgz/u);
  assert.match(deploy, /\.ky-agent\/skills-pool\/_manifest\.json/u);
  assert.match(deploy, /Staging runtime assets are missing \$required_asset/u);
  assert.match(
    deploy,
    /tar -xzf "\$candidate\/\.release\/staging-runtime-assets\.tgz"[\s\S]*-C "\$candidate\/server\/workspace-shared"/u,
  );
  assert.match(deploy, /Staging runtime directory must be a real immutable directory/u);
  assert.doesNotMatch(deploy, /shared_root=\/mnt\/agent-saas-staging\/workspace-shared/u);
  assert.match(
    deploy,
    /sharedDir: '\/opt\/agent-saas-staging\/current\/server\/workspace-shared'/u,
  );
  assert.match(deploy, /cp -a "\$server_config" "\$rollback_root\/config\.json"/u);
  assert.match(deploy, /cp -a "\$rollback_root\/config\.json" "\$server_config"/u);
  assert.match(deploy, /chmod 0640 "\$server_config"/u);
  assert.match(deploy, /tar -xzf "\$candidate\/\.release\/server-bundle\.tgz" -C "\$candidate"/u);
  assert.match(
    deploy,
    /tar -xzf "\$candidate\/\.release\/acs-orchestrator\.tgz" -C "\$candidate"/u,
  );
  assert.match(deploy, /SELECT current_database\(\) AS database, current_user AS username/u);
  assert.match(deploy, /Staging database runtime preflight failed/u);
  assert.ok(
    deploy.indexOf('Staging database runtime preflight failed') <
      deploy.indexOf('ln -sfn "$target" "$current"'),
  );
  assert.match(deploy, /Staging runtime profile preflight failed/u);
  assert.match(deploy, /dispatch\.env must be empty/u);
  assert.match(deploy, /memory\.index must be absent/u);
  assert.ok(
    deploy.indexOf('Staging runtime profile preflight failed') <
      deploy.indexOf('ln -sfn "$target" "$current"'),
  );
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
  assert.deepEqual(plan.resources.acs.egressNat, {
    mode: 'shared-cidr',
    regionId: 'cn-shenzhen',
    snatTableId: 'stb-wz94jmf2krggpzh4jek3p',
    publicIp: '120.77.218.94',
    isolationLevel: 'shared-production-egress-control-plane',
    configurationStatus: 'applied-and-live-readback-verified',
  });
  assert.equal(plan.resources.database.instanceId, 'pgm-wz96n2735914490l');
  assert.deepEqual(plan.resources.database.transportSecurity, {
    endpoint: 'private-vpc',
    rdsSslEnabled: false,
    clientSslMode: 'disable',
    alignmentStatus: 'matched-to-shared-rds-live-readback',
  });
  assert.equal(plan.resources.nas.isolationLevel, 'logical-shared-filesystem');
  assert.deepEqual(plan.resources.runtime.dependencies.aliyunCli, {
    path: '/usr/local/bin/aliyun',
    version: '3.4.2',
    size: 93146374,
    digest: 'sha256:e633bd422cecab86a4a33cd4f60b8497a5e000e6286ccc84778f868207bca9f4',
    status: 'installed-and-production-byte-identical',
    authentication: {
      mode: 'EcsRamRole',
      roleName: 'AgentSaasAcsSnatRole',
      instanceAttachment: 'verified',
      serviceHome: '/var/lib/agent-saas-staging/acs',
      profileStatus: 'configured-and-live-snat-readback-verified',
    },
  });
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

test('Staging API and Worker keep mutable process data isolated while executing immutable code', async () => {
  for (const path of [serverUnitPath, workerUnitPath]) {
    const unit = await readFile(path, 'utf8');
    assert.match(unit, /User=agent-saas-staging/u);
    assert.match(unit, /Group=agent-saas-staging/u);
    assert.match(unit, /WorkingDirectory=\/mnt\/agent-saas-staging\/runtime\/server/u);
    assert.match(unit, /ExecStart=.*\/opt\/agent-saas-staging\/current\/server\/dist\/index\.js/u);
    assert.match(unit, /Environment=KB_PREVIEW_AUTO_GENERATE=false/u);
    assert.match(unit, /Environment=AGENT_SAAS_STAGING_RELEASE_ROOT=\/opt\/agent-saas-staging/u);
  }

  const workerUnit = await readFile(workerUnitPath, 'utf8');
  assert.match(
    workerUnit,
    /Environment=AGENT_SAAS_READYFILE=\/run\/agent-saas-staging\/runtime-worker\.ready/u,
  );
  assert.doesNotMatch(workerUnit, /AGENT_SAAS_WORKER_READY_FILE/u);

  const serverUnit = await readFile(serverUnitPath, 'utf8');
  assert.match(
    serverUnit,
    /Environment=AGENT_SAAS_ACTIVE_RUNTIME_WORKER_READYFILE=\/run\/agent-saas-staging\/runtime-worker\.ready/u,
  );
});

test('Server build ships scenario libraries beside the bundle without depending on process cwd', async () => {
  const packageJson = JSON.parse(await readFile(serverPackagePath, 'utf8'));
  const routes = await readFile(scenarioRoutesPath, 'utf8');
  const copyScript = await readFile(staticDataCopyPath, 'utf8');

  assert.match(packageJson.scripts.build, /node scripts\/copy-static-data\.mjs/u);
  assert.match(routes, /basename\(import\.meta\.dirname\) === "dist"/u);
  assert.doesNotMatch(routes, /process\.cwd\(\)[\s\S]*workflow-library-v3\.json/u);
  assert.match(copyScript, /scenario-library-v1\.json/u);
  assert.match(copyScript, /workflow-library-v3\.json/u);
  assert.match(copyScript, /dist['"], 'data', 'scenarios/u);
});

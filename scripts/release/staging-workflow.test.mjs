import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { validateExpectedConfigIdentityObservers } from './read-production-state.mjs';

const workflowPath = new URL('../../.github/workflows/deploy-staging.yml', import.meta.url);
const acrWaitPath = new URL('./wait-for-acr-image.sh', import.meta.url);
const acceptanceWorkflowPath = new URL(
  '../../.github/workflows/staging-acceptance.yml',
  import.meta.url,
);
const deployPath = new URL('./deploy-staging-release.sh', import.meta.url);
const resourcePath = new URL('../../infra/staging/resource-plan.json', import.meta.url);
const acsRuntimePath = new URL('../../infra/staging/acs-runtime.yaml', import.meta.url);
const observationPath = new URL('./observe-production.mjs', import.meta.url);
const stagingBindingPath = new URL('./verify-staging-release-binding.mjs', import.meta.url);
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
const e2eAuthPath = new URL('../../e2e/staging/auth.spec.ts', import.meta.url);
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

test('Staging workflow locks the dispatch SHA, single slot, and dedicated ACR read identity', async () => {
  const [workflow, acrWait] = await Promise.all([
    readFile(workflowPath, 'utf8'),
    readFile(acrWaitPath, 'utf8'),
  ]);
  assert.match(workflow, /workflow_dispatch:[\s\S]*reason:/u);
  assert.doesNotMatch(workflow, /release_sha:/u);
  assert.match(workflow, /group: staging-runtime\s+cancel-in-progress: false/u);
  assert.match(
    workflow,
    /prepare-evidence:[\s\S]*environment: production[\s\S]*build-deploy-verify:[\s\S]*needs: prepare-evidence[\s\S]*environment: staging/u,
  );
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/u);
  assert.match(workflow, /test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"/u);
  assert.match(
    workflow,
    /created_at="\$\(node -e "process\.stdout\.write\(new Date\(process\.argv\[1\]\)\.toISOString\(\)\)" "\$created_at"\)"/u,
  );
  assert.match(workflow, /environment: staging/u);
  const acrResolveStep = workflow.slice(
    workflow.indexOf('- name: Resolve exact ACS image when required'),
    workflow.indexOf('- name: Build immutable artifacts once'),
  );
  assert.match(acrResolveStep, /secrets\.ACR_READ_ACCESS_KEY_ID/u);
  assert.match(acrResolveStep, /secrets\.ACR_READ_ACCESS_KEY_SECRET/u);
  assert.match(acrResolveStep, /Missing staging secret ACR_READ_ACCESS_KEY_ID/u);
  assert.match(acrResolveStep, /Missing staging secret ACR_READ_ACCESS_KEY_SECRET/u);
  assert.match(acrWait, /list-acr-build-records\.sh/u);
  assert.doesNotMatch(acrWait, /--PageNo 1 --PageSize 100/u);
  assert.match(acrWait, /ListRepoBuildRecordLog/u);
  assert.match(acrWait, /verify-acr-build-revision\.mjs/u);
  assert.equal(acrWait.match(/GetRepoTag/gu)?.length, 2);
  assert.match(acrWait, /acr-build-records-confirmed\.json/u);
  assert.match(acrWait, /first_digest#sha256:/u);
  assert.match(acrWait, /confirmed_digest#sha256:/u);
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
  assert.match(
    workflow,
    /find "\$WEB_ASSETS_ROOT" -type f -print0 \| \\\s+xargs -0 -r -P 8 -n 1 bash -euo pipefail -c/u,
  );
  assert.match(workflow, /cmp "\$source" "\$target"/u);
  assert.doesNotMatch(workflow, /done < <\(find "\$RUNNER_TEMP\/web-assets" -type f -print0\)/u);
  assert.doesNotMatch(workflow, /oss sync|--delete/u);
  const webIdentityIndex = workflow.indexOf('"$STAGING_WEB_OSS_URI/release-identity.json" --force');
  const webEntryIndex = workflow.indexOf('"$STAGING_WEB_OSS_URI/index.html" --force');
  assert.ok(webIdentityIndex > 0 && webIdentityIndex < webEntryIndex);
  assert.match(workflow, /manifest-digest: \$MANIFEST_DIGEST/u);
  assert.match(workflow, /Materialize and verify selected Manifest artifacts/u);
  assert.match(workflow, /publish-release-record\.mjs/u);
  assert.match(workflow, /\.artifacts\.stagingRuntimeAssets\.path/u);
  assert.match(workflow, /test "\$staging_runtime_path" = staging-runtime-assets\.tgz/u);
  assert.match(workflow, /STAGING_RUNTIME_ASSETS_PATH='\$remote\/staging-runtime-assets\.tgz'/u);
  assert.match(workflow, /--argjson runtimeSummary/u);
  assert.match(workflow, /stagingRuntimeAssetsDigest/u);
  assert.ok(
    workflow.indexOf('staging-runtime-summary.json') <
      workflow.indexOf('publish-release-record.mjs'),
  );
  assert.match(workflow, /\$\{\{ runner\.temp \}\}\/staging-runtime-summary\.json/u);
  assert.match(workflow, /publish-release-record\.mjs[\s\S]*\$RUNNER_TEMP\/selected/u);
  assert.ok(
    workflow.indexOf('Materialize and verify selected Manifest artifacts') <
      workflow.indexOf('Create immutable RC tag, Release and built attestation'),
  );
  assert.ok(
    workflow.indexOf('verify-selected-release-artifacts.mjs') <
      workflow.indexOf('publish-release-record.mjs'),
  );
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
  assert.match(
    workflow,
    /--arg releaseSha "\$\(jq -r \.components\.web\.sourceSha "\$RUNNER_TEMP\/manifest\.json"\)"/u,
  );
  assert.ok(runScriptLines(workflow).every((line) => !/\$\{\{\s*inputs\./u.test(line)));
});

test('预发固定使用稳态基线，拒绝配置身份缺失与漂移', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  assert.doesNotMatch(workflow, /production_config_identity_stage:|legacy-pre-upgrade-baseline/u);
  assert.match(workflow, /PRODUCTION_CONFIG_IDENTITY_STAGE: steady-state/u);
  assert.match(
    workflow,
    /read-production-state\.mjs' --config-identity-stage '\$PRODUCTION_CONFIG_IDENTITY_STAGE'/u,
  );
  assert.throws(
    () => validateExpectedConfigIdentityObservers(undefined, undefined),
    /completely absent during steady-state/u,
  );

  const expected = {
    schemaVersion: 1,
    digest: `sha256:${'a'.repeat(64)}`,
  };
  const apiSummary = {
    schemaVersion: 1,
    status: 'consistent',
    releaseId: 'rc-20260904-01',
    expected,
    observed: {
      ...expected,
      credentialVersionDigest: null,
      versionResolution: 'resolved',
      secretRefCount: 0,
    },
  };
  for (const [trusted, api] of [
    [expected, undefined],
    [undefined, apiSummary],
  ]) {
    assert.throws(
      () =>
        validateExpectedConfigIdentityObservers(trusted, api, {
          configIdentityStage: 'steady-state',
        }),
      /missing from/u,
    );
  }
  assert.throws(
    () =>
      validateExpectedConfigIdentityObservers(
        expected,
        {
          ...apiSummary,
          expected: { ...expected, digest: `sha256:${'b'.repeat(64)}` },
          observed: { ...apiSummary.observed, digest: `sha256:${'b'.repeat(64)}` },
        },
        { configIdentityStage: 'steady-state' },
      ),
    /disagrees across observers/u,
  );
});

test('full browser and Agent acceptance is optional, release-bound, and outside deployment attestations', async () => {
  const [workflow, stagingBinding, authSpec] = await Promise.all([
    readFile(acceptanceWorkflowPath, 'utf8'),
    readFile(stagingBindingPath, 'utf8'),
    readFile(e2eAuthPath, 'utf8'),
  ]);
  assert.match(workflow, /name: 预发验收/u);
  assert.match(workflow, /NODE_VERSION: '22\.23\.1'/u);
  assert.match(workflow, /node-version: \$\{\{ env\.NODE_VERSION \}\}/u);
  assert.match(workflow, /workflow_dispatch:[\s\S]*release_id:/u);
  assert.match(workflow, /group: staging-runtime\s+cancel-in-progress: false/u);
  assert.match(workflow, /\[\[ "\$RELEASE_ID_INPUT" =~ \^rc-/u);
  assert.match(workflow, /ref: refs\/tags\/\$\{\{ inputs\.release_id \}\}/u);
  assert.match(workflow, /Setup exact Runtime contract Node/u);
  assert.match(workflow, /Verify exact RC is still active on Staging/u);
  assert.match(workflow, /staging-web-identity\.json/u);
  assert.match(workflow, /staging-api-ready\.json/u);
  assert.match(workflow, /staging-acs-health\.json/u);
  assert.match(workflow, /Prepare browser and Agent acceptance suite/u);
  assert.match(workflow, /Re-verify exact RC immediately before acceptance execution/u);
  assert.match(workflow, /staging-web-identity-critical\.json/u);
  assert.match(workflow, /staging-api-ready-critical\.json/u);
  assert.match(workflow, /staging-acs-health-critical\.json/u);
  const criticalRecheck = workflow.indexOf(
    '      - name: Re-verify exact RC immediately before acceptance execution',
  );
  const acceptanceExecution = workflow.indexOf(
    '      - name: Run browser and Agent acceptance suite',
  );
  assert.ok(criticalRecheck > 0 && acceptanceExecution > criticalRecheck);
  assert.match(
    workflow.slice(criticalRecheck, acceptanceExecution),
    /verify-staging-release-binding\.mjs[\s\S]*--expected-manifest-digest "\$MANIFEST_DIGEST"/u,
  );
  assert.match(workflow, /playwright test -c e2e\/playwright\.config\.ts/u);
  assert.match(workflow, /summarize-e2e\.mjs/u);
  assert.match(workflow, /Clean and read back Staging acceptance fixtures\s+if: always\(\)/u);
  assert.match(workflow, /Verify Staging Manifest and component identities remained unchanged/u);
  assert.ok(
    workflow.indexOf('Verify Staging Manifest and component identities remained unchanged') <
      workflow.indexOf('Revoke temporary Staging SSH ingress'),
  );
  assert.match(workflow, /staging-web-identity-critical\.json/u);
  assert.match(workflow, /staging-web-identity-final\.json/u);
  assert.match(workflow, /staging-api-ready-final\.json/u);
  assert.match(workflow, /staging-acs-health-final\.json/u);
  assert.match(workflow, /release-final\/manifest\.json/u);
  assert.equal(workflow.match(/verify-staging-release-binding\.mjs/gu)?.length, 3);
  assert.equal(workflow.match(/--acs-health/gu)?.length, 3);
  assert.equal(workflow.match(/127\.0\.0\.1:3410\/health/gu)?.length, 3);
  assert.match(workflow, /releaseIdentityAttested|--acs-health/u);
  assert.match(workflow, /--expected-manifest-digest "\$MANIFEST_DIGEST"/u);
  assert.match(
    workflow,
    /api_source_sha="\$\(jq -r \.components\.api\.sourceSha "\$RUNNER_TEMP\/release\/manifest\.json"\)"/u,
  );
  assert.match(workflow, /echo "STAGING_API_SOURCE_SHA=\$api_source_sha"/u);
  assert.doesNotMatch(workflow, /STAGING_API_SOURCE_SHA=\$release_sha/u);
  assert.match(
    authSpec,
    /body\.release\.releaseSha\)\.toBe\(required\('STAGING_API_SOURCE_SHA'\)\)/u,
  );
  assert.doesNotMatch(authSpec, /required\('STAGING_RELEASE_SHA'\)/u);
  assert.match(stagingBinding, /configFingerprint/u);
  assert.match(stagingBinding, /webDigest/u);
  assert.match(stagingBinding, /apiSourceSha/u);
  assert.match(stagingBinding, /webSourceSha/u);
  assert.match(stagingBinding, /acsSourceSha/u);
  assert.match(stagingBinding, /serverDigest/u);
  assert.match(stagingBinding, /acsOrchestratorDigest/u);
  assert.match(stagingBinding, /acsSandboxImageDigest/u);
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

test('installed Staging units accept the persistent config path and reject the legacy path', async () => {
  const deploy = await readFile(deployPath, 'utf8');
  const functionStart = deploy.indexOf('verify_staging_unit_environment() {');
  const functionEnd = deploy.indexOf('\n}\n\nruntime_dir=', functionStart);
  assert.ok(functionStart >= 0 && functionEnd > functionStart);
  const verifier = deploy.slice(functionStart, functionEnd + 2);
  const config = 'AGENT_SAAS_CONFIG_PATH=/var/lib/agent-saas-staging/config/config.json';
  const api = `${config} AGENT_SAAS_ACTIVE_RUNTIME_WORKER_READYFILE=/run/agent-saas-staging/runtime-worker.ready AGENT_SAAS_CONFIG_IDENTITY_PATH=/run/agent-saas-staging/config-identity.json`;
  const worker = `${config} AGENT_SAAS_READYFILE=/run/agent-saas-staging/runtime-worker.ready AGENT_SAAS_CONFIG_IDENTITY_PATH=/run/agent-saas-staging/runtime-worker-config-identity.json`;
  const run = (apiEnvironment, workerEnvironment) =>
    spawnSync('bash', [
      '-c',
      `${verifier}\nverify_staging_unit_environment "$1" "$2"`,
      'bash',
      apiEnvironment,
      workerEnvironment,
    ]);

  assert.equal(run(api, worker).status, 0);
  assert.notEqual(
    run(api, worker.replace('runtime-worker-config-identity.json', 'config-identity.json')).status,
    0,
  );
  assert.notEqual(
    run(api.replace('config-identity.json', 'runtime-worker-config-identity.json'), worker).status,
    0,
  );
  assert.notEqual(
    run(
      api.replace(
        '/var/lib/agent-saas-staging/config/config.json',
        '/etc/agent-saas-staging/config.json',
      ),
      worker,
    ).status,
    0,
  );
  assert.notEqual(
    run(
      api,
      worker.replace(
        '/var/lib/agent-saas-staging/config/config.json',
        '/etc/agent-saas-staging/config.json',
      ),
    ).status,
    0,
  );
});

test('target deployment consumes bundles without source install/build and uses only Staging paths', async () => {
  const [deploy, workflow] = await Promise.all([
    readFile(deployPath, 'utf8'),
    readFile(workflowPath, 'utf8'),
  ]);
  assert.doesNotMatch(deploy, /pnpm (install|build)|npm (install|run)/u);
  assert.doesNotMatch(deploy, /\/opt\/agent-saas-app|agent-saas-server@|active-color/u);
  assert.match(deploy, /\/opt\/agent-saas-staging/u);
  assert.match(deploy, /UNIT_DIR:\?UNIT_DIR is required/u);
  assert.match(deploy, /install_staging_unit/u);
  assert.match(deploy, /systemctl daemon-reload/u);
  assert.match(deploy, /\/mnt\/agent-saas-staging\/runtime\/server/u);
  assert.match(deploy, /\/mnt\/agent-saas-staging\/runtime\/artifacts/u);
  assert.match(
    deploy,
    /runuser -u agent-saas-staging -- sh -c[\s\S]*umask 027; mkdir -p -- "\$1" "\$2"/u,
  );
  assert.doesNotMatch(deploy, /install -d[^\n]*"\$runtime_dir"/u);
  assert.match(deploy, /Artifact directory owner does not match the persistent runtime owner/u);
  assert.match(deploy, /persistent directory is not \$\{access\}-accessible/u);
  assert.match(deploy, /does not use the persistent Staging runtime directory/u);
  assert.match(deploy, /does not execute the immutable Staging server entrypoint/u);
  assert.match(deploy, /validateCandidateReleaseReadiness/u);
  assert.match(deploy, /\/run\/agent-saas-staging\/config-identity\.json/u);
  assert.match(deploy, /\/run\/agent-saas-staging\/runtime-worker-config-identity\.json/u);
  assert.match(deploy, /'AGENT_SAAS_CONFIG_IDENTITY_PATH'/u);
  assert.match(
    deploy,
    /rm -f "\$run_root\/runtime-worker\.ready" \\\n  "\$api_config_identity_snapshot" "\$worker_config_identity_snapshot"/u,
  );
  assert.doesNotMatch(deploy, /api\.configIdentity/u);
  assert.match(deploy, /agent-saas-acs-orchestrator-staging\.service/u);
  assert.match(deploy, /Missing shared ConfigIdentity readiness contract module/u);
  assert.match(
    workflow,
    /read-production-state\.mjs scripts\/release\/read-runtime-identity\.mjs/u,
  );
  assert.match(deploy, /kill -USR2/u);
  assert.match(deploy, /orchestratorArtifactDigest/u);
  assert.match(deploy, /sandboxImageDigest/u);
  assert.match(deploy, /rollback_root/u);
  assert.match(deploy, /deployment_committed=true/u);
  assert.match(deploy, /if \[ -L "\$current" \]; then/u);
  assert.match(deploy, /readlink -f -- "\$current"/u);
  assert.match(deploy, /had_previous_release=false/u);
  assert.match(deploy, /trap 'exit 129' HUP/u);
  assert.match(deploy, /trap 'exit 130' INT/u);
  assert.match(deploy, /trap 'exit 143' TERM/u);
  assert.match(deploy, /if \[ "\$had_previous_release" = true \]; then/u);
  assert.match(deploy, /systemctl stop agent-saas-acs-orchestrator-staging\.service/u);
  assert.match(deploy, /rm -f "\$run_root\/server\.pid"/u);
  assert.match(deploy, /"\$run_root\/acs-orchestrator\.pid"/u);
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
  assert.match(
    deploy,
    /AGENT_SAAS_CONFIG_PATH=\/var\/lib\/agent-saas-staging\/config\/config\.json/u,
  );
  assert.match(deploy, /API and Runtime Worker must use the shared Staging config/u);
  assert.match(
    deploy,
    /verify_staging_unit_environment "\$api_unit_environment" "\$worker_unit_environment"/u,
  );
  assert.match(deploy, /config_root="\$state_root\/config"/u);
  assert.match(deploy, /legacy_server_config="\$etc_root\/config\.json"/u);
  assert.match(deploy, /install -d -o agent-saas-staging -g agent-saas-staging -m 0700/u);
  assert.match(deploy, /Staging mutable config must be a regular non-symlink file/u);
  assert.match(deploy, /artifact\.backend must be local/u);
  assert.match(deploy, /artifact\.rootDir must use the shared NAS Artifact directory/u);
  assert.match(deploy, /artifact\.signedUrlSecret must be independent from auth\.jwtSecret/u);
  assert.match(deploy, /artifact\.readUrlTtlSeconds must be 300/u);
  assert.match(deploy, /artifact\.maxBlobBytes must be 104857600/u);
  assert.match(deploy, /artifact\.retentionDays must be 90/u);
  assert.match(deploy, /artifact\.gcIntervalMs must be 86400000/u);
  assert.match(deploy, /Artifact persistence probe did not survive the service restart/u);
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
  assert.match(
    deploy,
    /restore_optional_file "\$had_server_config" "\$rollback_root\/config\.json" "\$server_config"/u,
  );
  assert.match(deploy, /chown agent-saas-staging:agent-saas-staging "\$server_config"/u);
  assert.match(deploy, /chmod 0600 "\$server_config"/u);
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
  assert.match(deploy, /enabled memory index requires embedding\.apiKeyRef/u);
  assert.match(deploy, /enabled Codex requires a Staging credentialRef/u);
  assert.match(deploy, /group\.responses_transport === 'codex_subscription'/u);
  assert.doesNotMatch(deploy, /memory\.enabled must be false/u);
  assert.ok(
    deploy.indexOf('Staging runtime profile preflight failed') <
      deploy.indexOf('ln -sfn "$target" "$current"'),
  );
  assert.match(deploy, /AGENT_SAAS_RELEASE_SHA: manifest\.components\.api\.sourceSha/u);
  assert.doesNotMatch(deploy, /AGENT_SAAS_RELEASE_SHA: manifest\.releaseSha/u);
  assert.match(deploy, /chown root:agent-saas-staging "\$server_env"/u);
  assert.match(deploy, /chown root:agent-saas-staging "\$acs_env"/u);
  assert.match(deploy, /trap finish EXIT # one-shot dispatcher/u);
  assert.match(deploy, /restore_optional_file "\$had_server_unit"/u);
  assert.ok(
    deploy.indexOf('trap finish EXIT # one-shot dispatcher') <
      deploy.indexOf(
        'install_staging_unit \\\n  "$UNIT_DIR/agent-saas-server-staging.service.template"',
      ),
  );
  assert.match(deploy, /ACS_SANDBOX_LIFECYCLE_ENABLED=true/u);
  assert.match(deploy, /ACS_SANDBOX_LIFECYCLE_POLICY_MODE=enforce/u);
  assert.match(deploy, /acs\.lifecycle\?\.enabled !== true/u);
  assert.match(deploy, /acs\.lifecyclePolicyMode !== 'enforce'/u);
  assert.match(deploy, /trap finish EXIT/u, 'deployment must retain its cleanup trap');
  assert.match(deploy, /verify --root "\$target" --component server/u);
});

test('Staging deploy cleanup is best-effort and every temporary path is run-attempt isolated', async () => {
  const [deploy, workflow] = await Promise.all([
    readFile(deployPath, 'utf8'),
    readFile(workflowPath, 'utf8'),
  ]);
  assert.match(deploy, /GITHUB_RUN_ATTEMPT:\?GITHUB_RUN_ATTEMPT is required/u);
  assert.match(
    workflow,
    /remote="\/tmp\/agent-saas-staging-\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT"/u,
  );
  assert.match(
    deploy,
    /printf '%s:%s' "\$GITHUB_RUN_ID" "\$GITHUB_RUN_ATTEMPT" \| grep -Eq '\^\[1-9\]\[0-9\]\*:\[1-9\]\[0-9\]\*\$'/u,
  );
  assert.match(deploy, /deployment_attempt_id="\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT"/u);
  assert.match(
    workflow,
    /GITHUB_RUN_ID='\$GITHUB_RUN_ID' GITHUB_RUN_ATTEMPT='\$GITHUB_RUN_ATTEMPT' bash/u,
  );
  for (const pathFixture of [
    'config.json.migrate-$deployment_attempt_id',
    'candidate-${deployment_attempt_id}',
    'candidate-$deployment_attempt_id',
    'rollback-$release_id-$deployment_attempt_id',
    '.release-persistence-$release_id-$deployment_attempt_id',
    'acs-health-$deployment_attempt_id.json',
    'api-ready-$deployment_attempt_id.json',
  ]) {
    assert.ok(deploy.includes(pathFixture), `missing run-attempt path fixture: ${pathFixture}`);
  }
  assert.match(deploy, /candidatePath = `\$\{configPath\}\.candidate-\$\{deploymentAttemptId\}`/u);
  assert.match(deploy, /candidatePath = `\$\{envPath\}\.candidate-\$\{deploymentAttemptId\}`/u);
  assert.match(deploy, /trap '' HUP INT TERM[\s\S]{0,800}set \+e/u);
  assert.match(deploy, /Rollback backups stay on disk for manual recovery/u);
  assert.match(
    deploy,
    /rm -rf "\$candidate"[\s\S]{0,320}if \[ "\$deployment_committed" = false \]; then\s+rollback/u,
  );
  assert.match(
    deploy,
    /if \[ "\$deployment_committed" = false \]; then\s+rollback\s+fi\s+return "\$status"/u,
  );
});

test('Staging health gate rejects shadow mode before commit so EXIT trap rolls back', async () => {
  const deploy = await readFile(deployPath, 'utf8');
  const validator = deploy.match(
    /node - "\$MANIFEST_PATH" "\$acs_health_probe" <<'NODE'\n([\s\S]*?)\nNODE\n\ninstall -m 0444/u,
  )?.[1];
  assert.ok(
    validator,
    'Staging ACS health validator must remain executable as an isolated contract',
  );
  assert.ok(
    deploy.indexOf("acs.lifecyclePolicyMode !== 'enforce'") <
      deploy.indexOf('deployment_committed=true'),
  );
  assert.match(
    deploy,
    /if \[ "\$deployment_committed" = false \]; then\s+rollback\s+fi\s+return "\$status"/u,
  );

  const root = await mkdtemp(join(tmpdir(), 'staging-health-'));
  try {
    const manifest = {
      releaseId: 'release-1',
      releaseSha: 'sha-1',
      components: {
        api: { sourceSha: 'api-sha' },
        acs: {
          sourceSha: 'acs-sha',
          orchestratorArtifactDigest: 'sha256:orchestrator',
          sandboxImageDigest: 'sha256:sandbox',
        },
      },
    };
    const acs = {
      environment: 'staging',
      releaseId: manifest.releaseId,
      sourceSha: manifest.components.acs.sourceSha,
      orchestratorArtifactDigest: manifest.components.acs.orchestratorArtifactDigest,
      sandboxImageDigest: manifest.components.acs.sandboxImageDigest,
      namespace: 'agent-saas-staging',
      lifecycle: { enabled: true },
      lifecyclePolicyMode: 'shadow',
    };
    const paths = [join(root, 'manifest.json'), join(root, 'acs.json')];
    await Promise.all([
      writeFile(paths[0], JSON.stringify(manifest)),
      writeFile(paths[1], JSON.stringify(acs)),
    ]);
    const shadow = spawnSync(process.execPath, ['-', ...paths], {
      input: validator,
      encoding: 'utf8',
    });
    assert.notEqual(shadow.status, 0, 'shadow response must fail the deployment health gate');

    await writeFile(
      paths[1],
      JSON.stringify({ ...acs, lifecycle: { enabled: false }, lifecyclePolicyMode: 'enforce' }),
    );
    const disabled = spawnSync(process.execPath, ['-', ...paths], {
      input: validator,
      encoding: 'utf8',
    });
    assert.notEqual(
      disabled.status,
      0,
      'disabled lifecycle controller must fail the deployment health gate',
    );

    await writeFile(paths[1], JSON.stringify({ ...acs, lifecyclePolicyMode: 'enforce' }));
    const enforce = spawnSync(process.execPath, ['-', ...paths], {
      input: validator,
      encoding: 'utf8',
    });
    assert.equal(enforce.status, 0, enforce.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
  assert.match(
    workerUnit,
    /Environment=AGENT_SAAS_CONFIG_IDENTITY_PATH=\/run\/agent-saas-staging\/runtime-worker-config-identity\.json/u,
  );
  assert.match(
    workerUnit,
    /ExecStartPre=\/usr\/bin\/rm -f \/run\/agent-saas-staging\/runtime-worker\.ready \/run\/agent-saas-staging\/runtime-worker-config-identity\.json/u,
  );
  assert.doesNotMatch(workerUnit, /AGENT_SAAS_WORKER_READY_FILE/u);

  const serverUnit = await readFile(serverUnitPath, 'utf8');
  assert.match(
    serverUnit,
    /Environment=AGENT_SAAS_ACTIVE_RUNTIME_WORKER_READYFILE=\/run\/agent-saas-staging\/runtime-worker\.ready/u,
  );
  assert.match(
    serverUnit,
    /Environment=AGENT_SAAS_CONFIG_IDENTITY_PATH=\/run\/agent-saas-staging\/config-identity\.json/u,
  );
  assert.match(
    serverUnit,
    /ExecStartPre=\/usr\/bin\/rm -f \/run\/agent-saas-staging\/config-identity\.json/u,
  );
  assert.notEqual(serverUnit.indexOf('Environment=AGENT_SAAS_CONFIG_IDENTITY_PATH='), -1);
  assert.ok(
    serverUnit.indexOf('Environment=AGENT_SAAS_CONFIG_IDENTITY_PATH=') >
      serverUnit.indexOf('EnvironmentFile=/etc/agent-saas-staging/server.env'),
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

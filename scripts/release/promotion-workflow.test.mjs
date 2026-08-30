import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowPath = new URL('../../.github/workflows/promote-release.yml', import.meta.url);
const deployPath = new URL('./deploy-production-release.sh', import.meta.url);
const acsUnitPath = new URL(
  '../../daemon-packaging/systemd/agent-saas-acs-orchestrator.service.template',
  import.meta.url,
);
const serverUnitPath = new URL(
  '../../daemon-packaging/systemd/agent-saas-server@.service.template',
  import.meta.url,
);
const workerUnitPath = new URL(
  '../../daemon-packaging/systemd/agent-saas-runtime-worker@.service.template',
  import.meta.url,
);

function ordered(text, markers) {
  let cursor = -1;
  for (const marker of markers) {
    const next = text.indexOf(marker);
    assert.ok(next > cursor, `${marker} must appear in the required order`);
    cursor = next;
  }
}

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

test('promotion accepts only an approved release id and serializes production mutation', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /release_id:/u);
  assert.doesNotMatch(workflow, /^\s+(?:release_sha|artifact_url|image_tag):/mu);
  assert.match(workflow, /group: production-promotion/u);
  assert.match(workflow, /cancel-in-progress: false/u);
  assert.match(workflow, /environment: production/u);
  assert.match(workflow, /PRODUCTION_SSH_HOST_KEY_SHA256/u);
  assert.match(workflow, /RELEASE_ID_INPUT: \$\{\{ inputs\.release_id \}\}/u);
  assert.match(workflow, /\[\[ "\$RELEASE_ID_INPUT" =~ \^rc-/u);
  assert.doesNotMatch(workflow, /printf[^\n]*\$\{\{ inputs\./u);
  assert.match(workflow, /Latest release attestation is not approved|--state approved/u);
  assert.match(workflow, /deployments\/\$deployment_id\/statuses/u);
  assert.match(workflow, /actions\/runs\/\$e2e_run_id/u);
  assert.match(workflow, /runtime_summary=/u);
  assert.match(workflow, /stagingRuntimeAssetsDigest/u);
  assert.match(workflow, /expected_runtime_summary/u);
});

test('malicious multiline dispatch input cannot pass release-id validation or reach shell syntax', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  assert.ok(
    runScriptLines(workflow).every((line) => !/\$\{\{\s*inputs\.(?:release_id|reason)/u.test(line)),
  );
  const result = spawnSync('bash', ['-c', '[[ "$RELEASE_ID_INPUT" =~ ^rc-[0-9]{8}-[0-9]{2,}$ ]]'], {
    env: {
      ...process.env,
      RELEASE_ID_INPUT: 'rc-20260827-01\nMALICIOUS=$(touch should-not-run)',
    },
  });
  assert.notEqual(result.status, 0);
});

test('all validation and prefetch precede mutation, then ACS, App, and Web converge in order', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  ordered(workflow, [
    '- name: Read authoritative production baseline before any write',
    '- name: Prefetch and verify all selected artifacts',
    '- name: Mark and persist promotion started before any production write',
    '- name: Upload immutable deploy payload and managed units',
    '- name: Deploy exact ACS Orchestrator and Sandbox digest first',
    '- name: Deploy API blue-green and hand off Runtime Worker',
    '- name: Publish Web entry last and retain prior hashed assets',
  ]);
  assert.match(workflow, /components\.acs\.sandboxImageDigest/u);
  assert.match(workflow, /aliyun cr ListRepoTag/u);
  assert.match(workflow, /sha256sum/u);
  assert.match(workflow, /built\/artifact-index\.json/u);
  assert.match(workflow, /built_base="\$RELEASE_RECORD_OSS_URI\/\$RELEASE_ID"/u);
  assert.match(workflow, /\.artifacts\[\] \| \.path/u);
  assert.doesNotMatch(workflow, /selected\/artifact-index\.json/u);
  assert.match(workflow, /release-identity\.json/u);
  assert.match(workflow, /web-oss-readback/u);
  assert.match(workflow, /keep without restart/u);
  assert.doesNotMatch(workflow, /--clobber/u);
  assert.ok(runScriptLines(workflow).every((line) => !/\$\{\{\s*inputs\./u.test(line)));
});

test('workflow preserves partial matrices, rollback evidence, migrations, and observation boundaries', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const deploy = await readFile(deployPath, 'utf8');
  const acsUnit = await readFile(acsUnitPath, 'utf8');
  const serverUnit = await readFile(serverUnitPath, 'utf8');
  const workerUnit = await readFile(workerUnitPath, 'utf8');
  assert.match(workflow, /read-live-production-components\.mjs/u);
  assert.match(workflow, /target_match=false/u);
  assert.match(workflow, /write-production-identity\.mjs/u);
  assert.match(workflow, /verify-installed-release\.mjs/u);
  assert.match(workflow, /duration-ms 900000/u);
  assert.match(workflow, /separate_release/u);
  assert.doesNotMatch(workflow, /compatibilityEvidenceDigest|appAcsCompatibility/u);
  assert.match(workflow, /confirmed_after_observation/u);
  assert.match(workflow, /businessAcceptanceEvidenceDigest/u);
  assert.match(workflow, /observationReportDigest/u);
  assert.match(workflow, /contractExecuted:false/u);
  assert.match(workflow, /restore_web_entry/u);
  assert.match(workflow, /rollback_attempted=true/u);
  assert.match(workflow, /Persist ACS operation receipt/u);
  assert.match(workflow, /Persist ACS operation start receipt/u);
  assert.match(workflow, /Persist API and Worker operation start receipts/u);
  assert.match(workflow, /Persist Web operation start receipt/u);
  assert.match(workflow, /Persist API and Worker operation receipts/u);
  assert.match(workflow, /Persist Web operation receipt/u);
  assert.match(deploy, /cleanup_app_failure/u);
  assert.match(deploy, /cleanup_acs_failure/u);
  assert.match(deploy, /if \[ -L \/opt\/agent-saas\/acs-current \]; then/u);
  assert.match(deploy, /Existing ACS release path must be a symlink/u);
  assert.doesNotMatch(
    deploy,
    /previous="\$\(readlink -f \/opt\/agent-saas\/acs-current 2>\/dev\/null \|\| true\)"/u,
  );
  assert.match(deploy, /verify --root "\$target" --component acs >\/dev\/null/u);
  assert.match(deploy, /verify --root "\$target" --component server >\/dev\/null/u);
  assert.match(deploy, /verify --root "\$target" --component server/u);
  assert.match(deploy, /releases\/\$artifact_digest/u);
  assert.match(deploy, /mkdir -p "\$target\/server\/data" "\$target\/workspace-shared"/u);
  assert.match(deploy, /r\.environment !== 'production'/u);
  assert.match(
    deploy,
    /systemctl show "agent-saas-runtime-worker@\$worker_idle" --property Environment --value/u,
  );
  assert.match(deploy, /grep -Fx 'AGENT_SAAS_ENVIRONMENT=production'/u);
  assert.match(deploy, /app_committed=true/u);
  assert.match(deploy, /printf '%s\\n' "\$api_active" >\/etc\/agent-saas\/active-color/u);
  assert.match(deploy, /rollback_root\/nginx-upstream\.conf/u);
  assert.match(deploy, /exit 20/u);
  assert.doesNotMatch(deploy, /pnpm (?:install|build)/u);
  assert.match(acsUnit, /^User=root$/mu);
  assert.match(acsUnit, /^Group=root$/mu);
  assert.match(
    acsUnit,
    /^Environment=ACS_RELEASE_IDENTITY_FILE=\/etc\/agent-saas\/acs-release-identity\.json$/mu,
  );
  assert.match(
    serverUnit,
    /^BindPaths=\/mnt\/agent-saas\/server-data:\/opt\/agent-saas-app\/color\/%i\/server\/data$/mu,
  );
  assert.match(
    serverUnit,
    /^BindPaths=\/opt\/agent-saas\/workspace-shared:\/opt\/agent-saas-app\/color\/%i\/workspace-shared$/mu,
  );
  assert.match(
    workerUnit,
    /^BindPaths=\/mnt\/agent-saas\/server-data:\/opt\/agent-saas-app\/worker\/%i\/server\/data$/mu,
  );
  assert.match(
    workerUnit,
    /^BindPaths=\/opt\/agent-saas\/workspace-shared:\/opt\/agent-saas-app\/worker\/%i\/workspace-shared$/mu,
  );
  execFileSync('bash', ['-n', deployPath.pathname]);
});

#!/usr/bin/env bash
# ============================================================================
# ACS 影响分类（acs-sandbox.yml 的 changes job、bundle 输入清单与 build-deploy 门禁共用）
# ----------------------------------------------------------------------------
# 用法: acs-classify.sh <changed_files_path> [base_sha]
#   changed_files_path: 变更文件清单（每行一个仓库相对路径）
#   base_sha:           package.json runtime 字段对比的基准 commit。
#                       为空或不可读时保守判定 package.json 影响 ACS。
# 输出（stdout, `key=value` 四行）:
#   publish=true|false        需要 ACS 镜像发布（跑 gate, dispatch 时可部署）
#   contract_check=true|false 仅需契约门禁（typecheck + test, 不判定需部署）
#   reason=...                publish/contract 命中原因（分号分隔; 无则 none）
#   skipped=...               未命中 ACS 面的输入（分号分隔; 无则 none）
# 注意: managed unit 与安装 helper 属于 ACS 生产运行契约，任一变化都必须发布。
# ACS/release、workload descriptor 契约与纯测试文件归 contract_check；
#   它们只跑测试门禁，不触发全量部署。
# ============================================================================
set -euo pipefail

changed_files="${1:?usage: acs-classify.sh <changed_files_path> [base_sha]}"
base_sha="${2:-}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
bundle_inputs="$repo_root/.github/acs-bundle-inputs.txt"

publish=false
contract_check=false
reasons=()
skipped=()

if [ ! -f "$bundle_inputs" ]; then
  echo "missing ACS bundle inputs: $bundle_inputs" >&2
  exit 1
fi

package_json_affects_acs() {
  if [ -z "$base_sha" ] || ! git cat-file -e "$base_sha:package.json" 2>/dev/null; then
    return 0
  fi

  BASE_SHA="$base_sha" node <<'NODE'
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const baseSha = process.env.BASE_SHA;

function readJsonAt(ref, file) {
  return JSON.parse(execFileSync('git', ['show', `${ref}:${file}`], { encoding: 'utf8' }));
}

function pickRuntimeFields(pkg) {
  return {
    packageManager: pkg.packageManager,
    postinstall: pkg.scripts?.postinstall,
    dependencies: pkg.dependencies,
    devDependencies: pkg.devDependencies,
    optionalDependencies: pkg.optionalDependencies,
    peerDependencies: pkg.peerDependencies,
    pnpm: pkg.pnpm,
    overrides: pkg.overrides,
    resolutions: pkg.resolutions,
    patchedDependencies: pkg.patchedDependencies,
  };
}

try {
  const before = pickRuntimeFields(readJsonAt(baseSha, 'package.json'));
  const after = pickRuntimeFields(JSON.parse(fs.readFileSync('package.json', 'utf8')));
  process.exit(JSON.stringify(before) === JSON.stringify(after) ? 1 : 0);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(0);
}
NODE
}

is_packaged_runtime_path() {
  awk -v path="$1" '$1 !~ /^#/ && $2 == path { found = 1 } END { exit !found }' \
    "$repo_root/.github/acs-runtime-inputs.txt"
}

# Keep esbuild source inputs centralized instead of duplicating them in the case list below.
is_bundle_input_path() {
  while IFS= read -r pattern; do
    [ -n "$pattern" ] || continue
    case "$pattern" in \#*) continue ;; esac
    [[ "$1" == $pattern ]] && return 0
  done < "$bundle_inputs"
  return 1
}

is_publish_path() {
  if is_bundle_input_path "$1" || is_packaged_runtime_path "$1"; then
    return 0
  fi
  case "$1" in
    acs-orchestrator/*.test.ts|acs-orchestrator/*TestFixtures.ts|acs-orchestrator/*TestHelpers.ts)
      # 纯测试及其辅助文件不判定需要发布（归 contract_check）
      return 1
      ;;
  esac
  case "$1" in
    Dockerfile|.dockerignore|.npmrc|pnpm-workspace.yaml|.github/acs-bundle-inputs.txt|.github/acs-runtime-inputs.txt|.github/workflows/acs-sandbox.yml|.github/workflows/ci.yml|.github/scripts/acs-classify.sh|.github/scripts/redeliver_acr_webhook.py|scripts/apply-orchestrator-env.py|scripts/deploy-acs-orchestrator.sh|scripts/release/deploy-staging-release.sh|scripts/release/deploy-production-release.sh|scripts/release/manage-acs-systemd-unit.sh|scripts/release/upload-oss-object-immutable.sh|scripts/release/runtime-dependency.mjs|scripts/release/artifact-lib.mjs|daemon-packaging/systemd/agent-saas-acs-orchestrator.service.template|config/runtime-dependency-contract.json|scripts/acs-browser-lease-e2e.mjs|workspace-shared/.ky-agent/skills-pool/browser/scripts/acs_browser.py)
      return 0
      ;;
    acs-orchestrator/*|patches/*|server/package.json|server/src/data/tenants/types.ts)
      return 0
      ;;
    server/src/agent/toolRuntime.ts|server/src/agent/workspaceHandTools.ts|server/src/agent/toolOutput.ts|server/src/agent/shellOutputFiles.ts|server/src/agent/containerExecutionProvider.ts|server/src/agent/memorySearchToolProvider.ts|server/src/agent/tools/descriptionLoader.ts)
      return 0
      ;;
    server/src/agent/descriptions/Read.md|server/src/agent/descriptions/Write.md|server/src/agent/descriptions/List.md|server/src/agent/descriptions/Shell.md|server/src/agent/descriptions/WaitForWorkspaceReady.md|server/src/agent/descriptions/Edit.md|server/src/agent/descriptions/Glob.md|server/src/agent/descriptions/Grep.md|server/src/agent/descriptions/CreateArtifact.md|server/src/agent/descriptions/MemorySearch.md|server/src/agent/descriptions/MemoryList.md)
      return 0
      ;;
    server/src/runtime/handProtocol.ts|server/src/runtime/httpTransport.ts|server/src/runtime/inProcessTransport.ts|server/src/runtime/clientDaemonTransport.ts|server/src/runtime/handStore.ts|server/src/runtime/networkPolicy.ts|server/src/app/runtime.ts|server/src/app/serverRemoteConfig.ts|server/src/channels/web/channel.ts|server/src/channels/web/channelConfig.ts|server/src/channels/web/channelHelpers.ts)
      return 0
      ;;
  esac
  return 1
}

# Workload/lifecycle wire, deletion routes, Web/PG admission, config and restore paths must run the ACS contract suite,
# including files that also require an ACS image publish and all contract tests themselves.
is_contract_check_path() {
  case "$1" in
    .github/workflows/deploy-staging.yml|.github/workflows/promote-release.yml|acs-orchestrator/*.test.ts|acs-orchestrator/*TestFixtures.ts|acs-orchestrator/*TestHelpers.ts|scripts/release/staging-workflow.test.mjs|scripts/release/promotion-workflow.test.mjs|scripts/acs-verify-per-session.py|scripts/test_acs_operational_scripts.py|scripts/test_acr_webhook_redelivery.py)
      return 0
      ;;
    shared/src/types/sandboxWorkload.ts|shared/src/types/index.ts|shared/src/index.ts|server/src/agent/types.ts|server/src/__tests__/acsDeployWorkflowContract.test.ts|server/src/__tests__/appConfig.test.ts|server/src/__tests__/appServerRemoteConfig.test.ts|server/src/__tests__/executionDispatchValidation.test.ts|server/src/__tests__/runtimeHandProvisionRace.test.ts|server/src/__tests__/runtimeTombstoneAdmission.test.ts|server/src/__tests__/runtimeWakeSessionRestore.test.ts|server/src/__tests__/sandboxLifecycleService.test.ts|server/src/__tests__/sandboxRunAdmissionFence.test.ts|server/src/__tests__/sandboxScopeActivity.pg.test.ts|server/src/__tests__/sandboxWarmup.test.ts|server/src/__tests__/serverRemoteConfig.test.ts|server/src/__tests__/sessionCatalog.test.ts|server/src/__tests__/webChannelPersistentInteractionRecovery.test.ts)
      return 0
      ;;
    server/src/runtime/rawAgentLoop.ts|server/src/runtime/rawRuntimeRunDispatch.ts|server/src/runtime/runtimeWakeSessionRestore.ts|server/src/runtime/runtimeHandRegistration.ts|server/src/runtime/serverRemoteHandRegistration.ts|server/src/runtime/sessionCatalog.ts|server/src/runtime/sandboxRunAdmissionFence.ts|server/src/runtime/sandboxWarmup.ts|server/src/runtime/sandboxTerminalOutboxStore.ts|server/src/runtime/sandboxLifecycleStore.ts|server/src/runtime/sandboxLifecycleService.ts|server/src/routes/sandboxSessionDeletion.ts|server/src/routes/sessionPermanentDeletion.ts|server/src/runtime/runStatusCas.ts|server/src/runtime/runStoreQueries.ts|server/src/runtime/runTerminalLifecycle.ts|server/src/runtime/runStoreLivenessQueries.ts|server/src/runtime/runStore.ts|server/src/runtime/types.ts|server/src/routes/sessions.ts|server/src/runtime/subagent/subagentRunner.ts|server/src/runtime/background/backgroundTaskMetadata.ts|server/src/runtime/background/backgroundTaskService.ts|server/src/app/config.ts|server/src/app/runtime.ts|server/src/app/serverRemoteConfig.ts|server/src/channels/web/channel.ts|server/src/channels/web/channelConfig.ts|server/src/channels/web/channelHelpers.ts)
      return 0
      ;;
    server/src/taskboard/*|server/src/dws/*|server/src/feishu/*|server/src/context/sync/dwsContextRuntime.ts|server/src/cron/executor.ts|server/src/memory/consolidation/engine.ts|server/src/notion/authFlow.ts|server/src/data/transcripts/meta.ts)
      return 0
      ;;
  esac
  return 1
}

while IFS= read -r file; do
  [ -n "$file" ] || continue

  if [ "$file" = "package.json" ]; then
    if package_json_affects_acs; then
      publish=true
      reasons+=("package.json runtime fields")
    else
      skipped+=("package.json scripts/non-runtime fields")
    fi
    continue
  fi

  if [ "$file" = "pnpm-lock.yaml" ]; then
    # lockfile 可独立改变 Orchestrator/server/shared 的解析版本；无法从路径证明无关时保守发布。
    publish=true
    reasons+=("pnpm-lock.yaml runtime dependency resolution")
    continue
  fi

  matched=false
  if is_publish_path "$file"; then
    publish=true
    reasons+=("$file")
    matched=true
  fi

  if is_contract_check_path "$file"; then
    contract_check=true
    reasons+=("$file contract check")
    matched=true
  fi

  if [ "$matched" = true ]; then
    continue
  fi
  skipped+=("$file")
done < "$changed_files"


join_items() {
  if [ "$#" -eq 0 ]; then
    printf 'none'
    return 0
  fi
  local first=true
  for item in "$@"; do
    if [ "$first" = true ]; then
      printf '%s' "$item"
      first=false
    else
      printf '; %s' "$item"
    fi
  done
}

if [ "${#reasons[@]}" -gt 0 ]; then
  reason="$(join_items "${reasons[@]}")"
else
  reason="none"
fi
if [ "${#skipped[@]}" -gt 0 ]; then
  skipped_out="$(join_items "${skipped[@]}")"
else
  skipped_out="none"
fi

echo "publish=$publish"
echo "contract_check=$contract_check"
echo "reason=$reason"
echo "skipped=$skipped_out"

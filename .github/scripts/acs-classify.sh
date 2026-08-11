#!/usr/bin/env bash
# ============================================================================
# ACS 影响分类（acs-sandbox.yml 的 changes job 与 build-deploy 必要性门禁共用）
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
# 注意: 纯测试文件 acs-orchestrator/**/*.test.ts 归 contract_check——测试代码
#   会 COPY 进 sandbox 镜像但不影响运行行为，只跑测试门禁、不触发全量部署。
# ============================================================================
set -euo pipefail

changed_files="${1:?usage: acs-classify.sh <changed_files_path> [base_sha]}"
base_sha="${2:-}"

publish=false
contract_check=false
reasons=()
skipped=()

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

is_publish_path() {
  case "$1" in
    acs-orchestrator/*.test.ts)
      # 纯测试文件不判定需要发布（归 contract_check）
      return 1
      ;;
  esac
  case "$1" in
    Dockerfile|.dockerignore|.npmrc|pnpm-workspace.yaml|.github/workflows/acs-sandbox.yml|.github/scripts/acs-classify.sh|scripts/apply-orchestrator-env.py)
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
    server/src/runtime/handProtocol.ts|server/src/runtime/httpTransport.ts|server/src/runtime/inProcessTransport.ts|server/src/runtime/clientDaemonTransport.ts|server/src/runtime/handStore.ts|server/src/runtime/networkPolicy.ts)
      return 0
      ;;
  esac
  return 1
}

is_contract_check_path() {
  case "$1" in
    server/src/runtime/rawAgentLoop.ts|server/src/runtime/rawRuntimeRunDispatch.ts|acs-orchestrator/*.test.ts|scripts/acs-verify-per-session.py|scripts/test_acs_operational_scripts.py)
      return 0
      ;;
  esac
  return 1
}

lock_changed=false
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
    lock_changed=true
    continue
  fi

  if is_publish_path "$file"; then
    publish=true
    reasons+=("$file")
    continue
  fi

  if is_contract_check_path "$file"; then
    contract_check=true
    reasons+=("$file contract check")
    continue
  fi

  skipped+=("$file")
done < "$changed_files"

if [ "$lock_changed" = true ]; then
  if [ "$publish" = true ]; then
    reasons+=("pnpm-lock.yaml paired with ACS publish path")
  else
    skipped+=("pnpm-lock.yaml without ACS package/source change")
  fi
fi

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

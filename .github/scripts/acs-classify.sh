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
# 注意: 纯测试文件 acs-orchestrator/**/*.test.ts 归 contract_check——测试代码
#   会 COPY 进 sandbox 镜像但不影响运行行为，只跑测试门禁、不触发全量部署。
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
      # 纯测试与测试辅助文件不判定需要发布（归 contract_check）
      return 1
      ;;
  esac
  case "$1" in
    Dockerfile|.dockerignore|.npmrc|pnpm-workspace.yaml|.github/acs-bundle-inputs.txt|.github/acs-runtime-inputs.txt|.github/workflows/acs-sandbox.yml|.github/workflows/ci.yml|.github/scripts/acs-classify.sh|.github/scripts/redeliver_acr_webhook.py|scripts/deploy-acs-orchestrator.sh|scripts/release/upload-oss-object-immutable.sh)
      return 0
      ;;
    acs-orchestrator/*|patches/*|server/package.json)
      return 0
      ;;
    server/src/runtime/handProtocol.ts)
      return 0
      ;;
  esac
  return 1
}

is_contract_check_path() {
  case "$1" in
    server/src/runtime/rawAgentLoop.ts|server/src/runtime/rawRuntimeRunDispatch.ts|acs-orchestrator/*.test.ts|acs-orchestrator/*TestFixtures.ts|acs-orchestrator/*TestHelpers.ts|scripts/acs-verify-per-session.py|scripts/test_acs_operational_scripts.py|scripts/test_acr_webhook_redelivery.py)
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

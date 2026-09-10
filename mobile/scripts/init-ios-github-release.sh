#!/usr/bin/env bash
set -euo pipefail
umask 077

REPOSITORY="ZengLeiPro/agent-saas"
CREDENTIALS_JSON=""
API_KEY_P8=""
API_KEY_ID=""
ISSUER_ID=""
BUILD_ONLY=false
APPLY=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo) REPOSITORY="${2:?--repo requires owner/name}"; shift 2 ;;
    --credentials-json) CREDENTIALS_JSON="${2:?--credentials-json requires a path}"; shift 2 ;;
    --api-key-p8) API_KEY_P8="${2:?--api-key-p8 requires a path}"; shift 2 ;;
    --api-key-id) API_KEY_ID="${2:?--api-key-id requires a value}"; shift 2 ;;
    --issuer-id) ISSUER_ID="${2:?--issuer-id requires a value}"; shift 2 ;;
    --build-only) BUILD_ONLY=true; shift ;;
    --apply) APPLY=true; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

case "$REPOSITORY" in */*) ;; *) echo '--repo must be owner/name' >&2; exit 2 ;; esac
[ -f "$CREDENTIALS_JSON" ] && [ ! -L "$CREDENTIALS_JSON" ] || { echo '--credentials-json must point to a regular credentials.json file' >&2; exit 2; }
if ! $BUILD_ONLY; then
  [ -f "$API_KEY_P8" ] && [ ! -L "$API_KEY_P8" ] || { echo '--api-key-p8 must point to a regular App Store Connect private key file' >&2; exit 2; }
  [[ "$API_KEY_ID" =~ ^[A-Z0-9]{10}$ ]] || { echo '--api-key-id must contain 10 uppercase letters or digits' >&2; exit 2; }
  [[ "$ISSUER_ID" =~ ^[0-9A-Fa-f-]{36}$ ]] || { echo '--issuer-id must be an App Store Connect issuer UUID' >&2; exit 2; }
  openssl pkey -in "$API_KEY_P8" -noout >/dev/null
fi

gh auth status >/dev/null
node - "$CREDENTIALS_JSON" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const credentialsPath = path.resolve(process.argv[2]);
const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
for (const target of ['AgentSaaS', 'AgentSaaSShare']) {
  const item = credentials.ios?.[target];
  if (!item?.distributionCertificate?.path || !item.distributionCertificate.password || !item.provisioningProfilePath) {
    throw new Error(`credentials.json is missing ${target}`);
  }
  for (const relative of [item.distributionCertificate.path, item.provisioningProfilePath]) {
    const resolved = path.resolve(path.dirname(credentialsPath), relative);
    if (!fs.statSync(resolved).isFile()) throw new Error(`credential is not a regular file: ${path.basename(resolved)}`);
  }
}
if (credentials.ios.AgentSaaS.distributionCertificate.password !== credentials.ios.AgentSaaSShare.distributionCertificate.password) {
  throw new Error('main app and Share Extension P12 passwords differ; create one reviewed distribution P12 before initialization');
}
NODE

if ! $APPLY; then
  echo 'Preflight passed. Re-run with --apply to create main-only environments and write encrypted GitHub settings.'
  exit 0
fi

configure_environment() {
  local environment="$1" policies
  policies="$(gh api "repos/$REPOSITORY/environments/$environment/deployment-branch-policies" --jq '.branch_policies[]? | [.name,.type] | @tsv' 2>/dev/null || true)"
  if [ -n "$policies" ] && [ "$policies" != $'main\tbranch' ]; then
    echo "$environment has unexpected deployment branch policies; refusing to replace them" >&2
    exit 1
  fi
  printf '%s' '{"wait_timer":0,"prevent_self_review":false,"reviewers":[],"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}' |
    gh api --method PUT "repos/$REPOSITORY/environments/$environment" --input - >/dev/null
  if [ -z "$policies" ]; then
    printf '%s' '{"name":"main","type":"branch"}' |
      gh api --method POST "repos/$REPOSITORY/environments/$environment/deployment-branch-policies" --input - >/dev/null
  fi
}

credential_raw() {
  node -e 'const fs=require("node:fs"),path=require("node:path");const file=path.resolve(process.argv[1]);const value=process.argv[2].split(".").reduce((item,key)=>item[key],JSON.parse(fs.readFileSync(file,"utf8")));process.stdout.write(String(value));' "$CREDENTIALS_JSON" "$1"
}

credential_path() {
  node -e 'const fs=require("node:fs"),path=require("node:path");const file=path.resolve(process.argv[1]);const value=process.argv[2].split(".").reduce((item,key)=>item[key],JSON.parse(fs.readFileSync(file,"utf8")));process.stdout.write(path.resolve(path.dirname(file),value));' "$CREDENTIALS_JSON" "$1"
}

APP_P12="$(credential_path ios.AgentSaaS.distributionCertificate.path)"
APP_PROFILE="$(credential_path ios.AgentSaaS.provisioningProfilePath)"
SHARE_PROFILE="$(credential_path ios.AgentSaaSShare.provisioningProfilePath)"

configure_environment mobile-build-production
openssl base64 -A -in "$APP_P12" | gh secret set IOS_DISTRIBUTION_P12_BASE64 --repo "$REPOSITORY" --env mobile-build-production --body -
credential_raw ios.AgentSaaS.distributionCertificate.password | gh secret set IOS_DISTRIBUTION_P12_PASSWORD --repo "$REPOSITORY" --env mobile-build-production --body -
openssl base64 -A -in "$APP_PROFILE" | gh secret set IOS_APP_PROFILE_BASE64 --repo "$REPOSITORY" --env mobile-build-production --body -
openssl base64 -A -in "$SHARE_PROFILE" | gh secret set IOS_SHARE_PROFILE_BASE64 --repo "$REPOSITORY" --env mobile-build-production --body -

if ! $BUILD_ONLY; then
  configure_environment mobile-submit-ios-store
  gh secret set APP_STORE_CONNECT_API_KEY_P8 --repo "$REPOSITORY" --env mobile-submit-ios-store < "$API_KEY_P8"
  gh variable set APP_STORE_CONNECT_API_KEY_ID --repo "$REPOSITORY" --env mobile-submit-ios-store --body "$API_KEY_ID"
  gh variable set APP_STORE_CONNECT_ISSUER_ID --repo "$REPOSITORY" --env mobile-submit-ios-store --body "$ISSUER_ID"
fi

echo "GitHub iOS release initialization completed for $REPOSITORY (build-only=$BUILD_ONLY)."

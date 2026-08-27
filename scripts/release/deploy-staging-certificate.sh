#!/usr/bin/env bash
set -euo pipefail

cert_path=${STAGING_CERT_PATH:-/etc/agent-saas-staging/tls/fullchain.pem}
key_path=${STAGING_KEY_PATH:-/etc/agent-saas-staging/tls/privkey.pem}
acme_account=${ACME_ACCOUNT_PATH:-/root/.acme.sh/account.conf}
state_path=${STAGING_CERT_STATE_PATH:-/var/lib/agent-saas-staging/cert-state.json}
bucket=${STAGING_WEB_BUCKET:-agent-saas-web-staging}
web_domain=${STAGING_WEB_DOMAIN:-staging-agent.kaiyan.net}
api_domain=${STAGING_API_DOMAIN:-staging-agent-api.kaiyan.net}
oss_region=${STAGING_OSS_REGION:-cn-shenzhen}
oss_endpoint=${STAGING_OSS_ENDPOINT:-oss-cn-shenzhen.aliyuncs.com}

log() {
  printf '[%s] %s\n' "$(date -Iseconds)" "$*"
}

test -s "$cert_path"
test -s "$key_path"
test -s "$acme_account"
test "$(stat -c '%a' "$key_path")" = 600
openssl x509 -in "$cert_path" -noout -checkend 2592000

san_text=$(openssl x509 -in "$cert_path" -noout -ext subjectAltName)
grep -Fq "DNS:$web_domain" <<<"$san_text"
grep -Fq "DNS:$api_domain" <<<"$san_text"

cert_public_key=$(openssl x509 -in "$cert_path" -pubkey -noout | openssl sha256)
private_public_key=$(openssl pkey -in "$key_path" -pubout | openssl sha256)
test "$cert_public_key" = "$private_public_key"

# acme.sh 的 DNS 插件会将专用 RAM 凭据以 mode 0600 保存到 account.conf。
# OSS 更新复用同一最小权限身份，避免再落一份永久 AccessKey。
set +u
# shellcheck disable=SC1090
source "$acme_account"
set -u
: "${SAVED_Ali_Key:?AliDNS AccessKey ID is missing}"
: "${SAVED_Ali_Secret:?AliDNS AccessKey secret is missing}"
export OSS_ACCESS_KEY_ID=$SAVED_Ali_Key
export OSS_ACCESS_KEY_SECRET=$SAVED_Ali_Secret

work=$(mktemp -d /run/agent-saas-staging-cert.XXXXXX)
trap 'rm -rf "$work"' EXIT
chmod 700 "$work"
jq -n \
  --arg domain "$web_domain" \
  --rawfile certificate "$cert_path" \
  --rawfile privateKey "$key_path" \
  '{Cname:{Domain:$domain,CertificateConfiguration:{Certificate:$certificate,PrivateKey:$privateKey,Force:true}}}' \
  >"$work/cname.json"
chmod 600 "$work/cname.json"

/usr/local/bin/ossutil api put-cname \
  --bucket "$bucket" \
  --region "$oss_region" \
  --endpoint "$oss_endpoint" \
  --mode AK \
  --cname-configuration "file://$work/cname.json" \
  --quiet

nginx -t
if systemctl is-active --quiet nginx; then
  systemctl reload nginx
fi

curl -fsS --retry 5 --retry-all-errors --connect-timeout 10 --max-time 30 \
  "https://$web_domain/resource-ready.txt" >/dev/null

fingerprint=$(openssl x509 -in "$cert_path" -noout -fingerprint -sha256 | cut -d= -f2)
not_after=$(openssl x509 -in "$cert_path" -noout -enddate | cut -d= -f2-)
install -d -m 0750 "$(dirname "$state_path")"
jq -n \
  --arg updatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg fingerprint "$fingerprint" \
  --arg notAfter "$not_after" \
  --arg webDomain "$web_domain" \
  --arg apiDomain "$api_domain" \
  '{schemaVersion:1,updatedAt:$updatedAt,fingerprintSha256:$fingerprint,notAfter:$notAfter,webDomain:$webDomain,apiDomain:$apiDomain}' \
  >"$work/cert-state.json"
install -m 0640 "$work/cert-state.json" "$state_path"
log "Staging certificate deployed to OSS and Nginx; fingerprint=$fingerprint; notAfter=$not_after"

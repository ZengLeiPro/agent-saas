#!/usr/bin/env bash
# Compatible with the Bash 3.2 shipped on the pinned macOS runner.
set -euo pipefail
umask 077

profile="${1:?profile required}"
artifact="${2:?artifact path required}"
source_json="${3:?authorized source JSON required}"
output="${4:?output JSON required}"
case "$profile" in ios-store|android-store|android-enterprise) ;; *) echo '[M60-04] invalid artifact profile' >&2; exit 1;; esac
test -f "$artifact" && test ! -L "$artifact" || { echo '[M60-04] artifact must be a regular non-symlink file' >&2; exit 1; }
test -f "$source_json" || { echo '[M60-04] source authorization is missing' >&2; exit 1; }
expected_profile="$(jq -er .profile "$source_json")"
test "$profile" = "$expected_profile" || { echo '[M60-04] profile/source mismatch' >&2; exit 1; }
expected_app="$(jq -er .appId "$source_json")"
expected_version="$(jq -er .version "$source_json")"
artifact_hash="sha256:$(shasum -a 256 "$artifact" | awk '{print $1}')"
artifact_size="$(wc -c < "$artifact" | tr -d ' ')"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT

normalize_fp() { sed -E 's/.*(=|SHA256:)[[:space:]]*//' | tr '[:upper:]' '[:lower:]' | tr -cd '0-9a-f' | awk '{print "sha256:" $0}'; }
reject_debug_subject() { if printf '%s' "$1" | grep -Eiq 'Android Debug|AndroidDebugKey|CN[=:][[:space:]]*debug'; then echo '[M60-04] debug signer rejected' >&2; exit 1; fi; }

verify_ios_store_profile() {
  bundle="$1"
  bundle_id="$2"
  entitlements_plist="$3"
  profile_plist="$4"
  label="$5"
  expected_team="$6"
  expected_app_group="$7"

  test -f "$bundle/embedded.mobileprovision" || { echo "[M60-04] $label embedded provisioning profile missing" >&2; exit 1; }
  security cms -D -i "$bundle/embedded.mobileprovision" > "$profile_plist"
  profile_team="$(plutil -extract TeamIdentifier.0 raw -o - "$profile_plist")"
  profile_prefix="$(plutil -extract ApplicationIdentifierPrefix.0 raw -o - "$profile_plist")"
  profile_entitlements="$(plutil -extract Entitlements json -o - "$profile_plist" | jq -S -c .)"
  signed_entitlements="$(plutil -convert json -o - "$entitlements_plist" | jq -S -c .)"
  test "$profile_team" = "$expected_team" || { echo "[M60-04] $label provisioning profile Apple Team mismatch" >&2; exit 1; }
  if plutil -extract ProvisionedDevices raw -o - "$profile_plist" >/dev/null 2>&1 \
    || plutil -extract ProvisionsAllDevices raw -o - "$profile_plist" 2>/dev/null | grep -Fxq true \
    || ! printf '%s' "$profile_entitlements" | jq -e '.["get-task-allow"] != true and .["beta-reports-active"] == true' >/dev/null; then
    echo "[M60-04] $label provisioning profile is not App Store distribution" >&2
    exit 1
  fi
  expiration="$(plutil -extract ExpirationDate raw -o - "$profile_plist")"
  node -e '
    const expires = Date.parse(process.argv[1]);
    if (!Number.isFinite(expires) || expires <= Date.now()) process.exit(1);
  ' "$expiration" || { echo "[M60-04] $label provisioning profile is expired or invalid" >&2; exit 1; }

  if printf '%s' "$signed_entitlements" | jq -e '.["get-task-allow"] == true' >/dev/null; then
    echo "[M60-04] $label signed development entitlement rejected" >&2
    exit 1
  fi
  if printf '%s' "$signed_entitlements" | jq -e 'has("aps-environment")' >/dev/null; then
    echo "[M60-04] $label unexpected push entitlement is outside iOS V1 scope" >&2
    exit 1
  fi

  test "$(printf '%s' "$signed_entitlements" | jq -er '.["com.apple.developer.team-identifier"]')" = "$expected_team" || { echo "[M60-04] $label signed Apple Team entitlement mismatch" >&2; exit 1; }
  test "$(printf '%s' "$signed_entitlements" | jq -er '.["application-identifier"]')" = "$profile_prefix.$bundle_id" || { echo "[M60-04] $label signed application identifier mismatch" >&2; exit 1; }
  profile_app_id="$(printf '%s' "$profile_entitlements" | jq -er '.["application-identifier"]')"
  test "$profile_app_id" = "$profile_prefix.$bundle_id" || { echo "[M60-04] $label provisioning profile application identifier mismatch" >&2; exit 1; }
  printf '%s' "$profile_entitlements" | jq -e --arg group "$expected_app_group" '.["com.apple.security.application-groups"] | index($group) != null' >/dev/null || { echo "[M60-04] $label provisioning profile App Group mismatch" >&2; exit 1; }

  codesign -d --extract-certificates="$work/$label-signing-cert-" "$bundle" >/dev/null 2>&1
  test -f "$work/$label-signing-cert-0" || { echo "[M60-04] $label signing certificate unavailable" >&2; exit 1; }
  signing_cert_sha="$(shasum -a 256 "$work/$label-signing-cert-0" | awk '{print $1}')"
  {
    certificate_index=0
    while certificate="$(plutil -extract "DeveloperCertificates.$certificate_index" raw -o - "$profile_plist" 2>/dev/null)"; do
      printf '%s' "$certificate" | openssl base64 -d -A | shasum -a 256 | awk '{print $1}'
      certificate_index=$((certificate_index + 1))
    done
  } | grep -Fxq "$signing_cert_sha" || { echo "[M60-04] $label signer is absent from its provisioning profile" >&2; exit 1; }
}

if [ "$profile" = ios-store ]; then
  command -v codesign >/dev/null && command -v security >/dev/null && command -v plutil >/dev/null && command -v openssl >/dev/null || { echo '[M60-04] macOS signing tools are required' >&2; exit 1; }
  case "$artifact" in *.ipa) ;; *) echo '[M60-04] iOS Store artifact must be IPA' >&2; exit 1;; esac
  unzip -q "$artifact" -d "$work/ipa"
  shopt -s nullglob
  apps=("$work"/ipa/Payload/*.app)
  test "${#apps[@]}" -eq 1 && test -d "${apps[0]}" || { echo '[M60-04] IPA must contain exactly one app' >&2; exit 1; }
  app="${apps[0]}"; info="$app/Info.plist"
  app_id="$(plutil -extract CFBundleIdentifier raw -o - "$info")"
  version="$(plutil -extract CFBundleShortVersionString raw -o - "$info")"
  build_number="$(plutil -extract CFBundleVersion raw -o - "$info")"
  expected_team="$(jq -er .iosTeamId "$source_json")"
  expected_app_group="$(jq -er .iosAppGroup "$source_json")"
  expected_source_sha="$(jq -er .sourceGitSha "$source_json")"
  test "$app_id" = "$expected_app" && test "$version" = "$expected_version" || { echo '[M60-04] IPA identity/version mismatch' >&2; exit 1; }
  test "$build_number" = "$(jq -er '.buildNumber|tostring' "$source_json")" || { echo '[M60-04] IPA build number mismatch' >&2; exit 1; }
  test "$(plutil -extract AgentSaaSReleaseSourceGitSHA raw -o - "$info")" = "$expected_source_sha" || { echo '[M60-04] IPA signed source Git SHA mismatch' >&2; exit 1; }
  codesign --verify --deep --strict "$app" >/dev/null
  codesign -d --entitlements :- "$app" > "$work/entitlements.plist" 2>/dev/null
  if plutil -extract get-task-allow raw -o - "$work/entitlements.plist" 2>/dev/null | grep -Fxq true; then echo '[M60-04] development entitlement rejected' >&2; exit 1; fi
  verify_ios_store_profile "$app" "$expected_app" "$work/entitlements.plist" "$work/profile.plist" main-app "$expected_team" "$expected_app_group"
  signer_subject="$(openssl x509 -inform DER -in "$work/main-app-signing-cert-0" -noout -subject)"; reject_debug_subject "$signer_subject"
  signer="$(openssl x509 -inform DER -in "$work/main-app-signing-cert-0" -noout -fingerprint -sha256 | normalize_fp)"
  permissions="$(plutil -convert json -o - "$work/entitlements.plist" | jq -S -c .)"
  printf '%s' "$permissions" | jq -e --arg group "$expected_app_group" '.["com.apple.security.application-groups"] | index($group) != null' >/dev/null || { echo '[M60-04] signed App Group entitlement mismatch' >&2; exit 1; }
  printf '%s' "$permissions" | jq -e --arg group "$profile_prefix.$expected_app_group" '.["keychain-access-groups"] | index($group) != null' >/dev/null || { echo '[M60-04] signed Keychain Group entitlement mismatch' >&2; exit 1; }
  if printf '%s' "$permissions" | jq -e 'has("aps-environment")' >/dev/null; then echo '[M60-04] unexpected push entitlement is outside iOS V1 scope' >&2; exit 1; fi
  appex=("$app"/PlugIns/*.appex)
  test "${#appex[@]}" -eq 1 && test -d "${appex[0]}" || { echo '[M60-04] IPA must contain exactly one Share Extension' >&2; exit 1; }
  extension="${appex[0]}"
  extension_id="$(plutil -extract CFBundleIdentifier raw -o - "$extension/Info.plist")"
  test "$extension_id" = "$expected_app.share-extension" || { echo '[M60-04] Share Extension bundle identifier mismatch' >&2; exit 1; }
  codesign --verify --strict "$extension" >/dev/null
  codesign -d --entitlements :- "$extension" > "$work/extension-entitlements.plist" 2>/dev/null
  verify_ios_store_profile "$extension" "$expected_app.share-extension" "$work/extension-entitlements.plist" "$work/extension-profile.plist" share-extension "$expected_team" "$expected_app_group"
  extension_permissions="$(plutil -convert json -o - "$work/extension-entitlements.plist" | jq -S -c .)"
  printf '%s' "$extension_permissions" | jq -e --arg group "$expected_app_group" '.["com.apple.security.application-groups"] | index($group) != null' >/dev/null || { echo '[M60-04] Share Extension App Group entitlement mismatch' >&2; exit 1; }
  version_code=null
else
  command -v java >/dev/null && command -v keytool >/dev/null || { echo '[M60-04] Java signing tools are required' >&2; exit 1; }
  if [ "$profile" = android-store ]; then
    case "$artifact" in *.aab) ;; *) echo '[M60-04] Android Store artifact must be AAB' >&2; exit 1;; esac
    : "${BUNDLETOOL_JAR:?BUNDLETOOL_JAR is required}"
    test -f "$BUNDLETOOL_JAR" || { echo '[M60-04] pinned bundletool jar missing' >&2; exit 1; }
    jarsigner -verify -strict -certs "$artifact" >/dev/null
    java -jar "$BUNDLETOOL_JAR" dump manifest --bundle "$artifact" > "$work/manifest.xml"
    badging="$(head -c 200000 "$work/manifest.xml")"
    app_id="$(printf '%s' "$badging" | sed -nE 's/.*package="([^"]+)".*/\1/p' | head -1)"
    version="$(printf '%s' "$badging" | sed -nE 's/.*android:versionName="([^"]+)".*/\1/p' | head -1)"
    version_code="$(printf '%s' "$badging" | sed -nE 's/.*android:versionCode="([0-9]+)".*/\1/p' | head -1)"
    permissions="$(printf '%s' "$badging" | grep -oE '<uses-permission[^>]+android:name="[^"]+"' | sed -nE 's/.*android:name="([^"]+)"/\1/p' | LC_ALL=C sort -u | jq -Rsc 'split("\n")|map(select(length>0))')"
  else
    case "$artifact" in *.apk) ;; *) echo '[M60-04] Android Enterprise artifact must be APK' >&2; exit 1;; esac
    command -v apksigner >/dev/null && command -v aapt >/dev/null || { echo '[M60-04] apksigner and aapt are required' >&2; exit 1; }
    apksigner verify --verbose --print-certs "$artifact" > "$work/apksigner.txt"
    badging="$(aapt dump badging "$artifact")"
    app_id="$(printf '%s\n' "$badging" | sed -nE "s/^package: name='([^']+)'.*/\1/p")"
    version="$(printf '%s\n' "$badging" | sed -nE "s/^package: .* versionName='([^']+)'.*/\1/p")"
    version_code="$(printf '%s\n' "$badging" | sed -nE "s/^package: .* versionCode='([0-9]+)'.*/\1/p")"
    permissions="$(aapt dump permissions "$artifact" | sed -nE "s/^uses-permission(-sdk-[0-9]+)?: name='([^']+)'.*/\2/p" | LC_ALL=C sort -u | jq -Rsc 'split("\n")|map(select(length>0))')"
    grep -Fqx 'android.permission.REQUEST_INSTALL_PACKAGES' < <(printf '%s' "$permissions" | jq -r '.[]') || { echo '[M60-04] enterprise install permission missing' >&2; exit 1; }
  fi
  test "$app_id" = "$expected_app" && test "$version" = "$expected_version" || { echo '[M60-04] Android identity/version mismatch' >&2; exit 1; }
  test "$version_code" = "$(jq -er '.versionCode|tostring' "$source_json")" || { echo '[M60-04] Android versionCode mismatch' >&2; exit 1; }
  if [ "$profile" = android-store ]; then ! printf '%s' "$permissions" | jq -e 'index("android.permission.REQUEST_INSTALL_PACKAGES")' >/dev/null || { echo '[M60-04] Store install permission rejected' >&2; exit 1; }; fi
  if printf '%s' "$badging" | grep -Eiq 'android:debuggable="true"|application-debuggable'; then echo '[M60-04] debuggable release rejected' >&2; exit 1; fi
  signer_record="$(keytool -printcert -jarfile "$artifact" 2>&1)"; reject_debug_subject "$signer_record"
  signer="$(printf '%s\n' "$signer_record" | grep -m1 'SHA256:' | normalize_fp)"
  build_number=null
fi

test "$signer" != 'sha256:' && printf '%s' "$signer" | grep -Eq '^sha256:[0-9a-f]{64}$' || { echo '[M60-04] signer fingerprint unavailable' >&2; exit 1; }
permissions_hash="sha256:$(printf '%s' "$permissions" | shasum -a 256 | awk '{print $1}')"
jq -nS \
  --arg profile "$profile" --arg appId "$app_id" --arg version "$version" \
  --argjson buildNumber "$build_number" --argjson versionCode "$version_code" \
  --arg artifactSha256 "$artifact_hash" --argjson size "$artifact_size" \
  --arg signerFingerprint "$signer" --arg permissionsSha256 "$permissions_hash" \
  '{profile:$profile,appId:$appId,version:$version,buildNumber:$buildNumber,versionCode:$versionCode,artifactSha256:$artifactSha256,size:$size,signerFingerprint:$signerFingerprint,permissionsSha256:$permissionsSha256}' > "$output"
echo "M60-04 artifact verified profile=$profile digest=$artifact_hash"

# M60-04 mobile release evidence

The release contract has three boundaries. **Build never submits; submit never rebuilds; rollout accepts only a signed submit receipt.** The reviewed local iOS path is `pnpm --filter mobile build:ios:only`, followed by `pnpm --filter mobile submit:ios -- <verified-ipa>`. The repository does not expose an active GitHub Actions release entry point. A live CI release workflow must be reviewed and added only after the protected environments, organization credentials, provider adapters, and runners are provisioned.

## Protected configuration (fail closed)

Repository variables:

- `MOBILE_RELEASE_CONFIGURED=true`, `MOBILE_SUBMIT_CONFIGURED=true`, `MOBILE_ROLLOUT_CONFIGURED=true` only after the integration is provisioned.
- `MOBILE_RELEASE_EVIDENCE_KEY_ID`, public identity for the organization evidence robot key.
- `MOBILE_BUNDLETOOL_1_17_2_SHA256`, reviewed checksum for the exact bundletool binary.
- Store integration variables: `APP_STORE_CONNECT_API_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`, `MOBILE_ENTERPRISE_SUBMIT_ENDPOINT`, `MOBILE_STORE_BUILD_LOOKUP_ENDPOINT`, `MOBILE_ROLLOUT_ENDPOINT`.

Protected environment secrets (organization robot credentials only):

- `EXPO_ORG_ROBOT_TOKEN` (never a personal Expo token).
- `MOBILE_RELEASE_EVIDENCE_PRIVATE_KEY_PEM` and trusted `MOBILE_RELEASE_EVIDENCE_PUBLIC_KEY_PEM`.
- Submit adapters: `APP_STORE_CONNECT_API_KEY_P8`, `ANDROID_PLAY_SERVICE_ACCOUNT_JSON`, or `ENTERPRISE_MDM_ROBOT_TOKEN`; `MOBILE_STORE_LOOKUP_ROBOT_TOKEN` performs the post-submit store build reverse lookup.
- Rollout adapter: `MOBILE_ROLLOUT_ROBOT_TOKEN`.

A future release integration must provision `mobile-build-production`, `mobile-submit-<profile>`, and `mobile-rollout-<profile>` with required reviewers and self-review prevention. It must query and hash the protection rules and fail if approval metadata cannot be obtained. Build, submit, and rollout approvals remain intentionally separate.

## Source and artifact contract

`mobile/scripts/authorize-mobile-release-source.mjs` accepts only an annotated `mobile-vX.Y.Z-rc.N` tag contained in `main`, or an exact reviewed commit that is on `main` or is the current head of an open, non-draft PR with a current non-author approval. Any future release integration must verify the checked-out SHA, clean tree, frozen lock digest, release manifest identity/version/profile, and M60-03 policy gate before EAS. A production manifest may set `target.distribution` to `both` to authorize Store AAB and Enterprise APK from the same SHA; the EAS profile still selects one concrete distribution.

Downloaded IPA/AAB/APK files are verified with platform tools before evidence is sealed. Evidence does not contain credentials or temporary EAS download URLs. `mobile/scripts/mobile-release-evidence.mjs` validates canonical digest, Ed25519 signature, nonce, approvals, one to three unique same-SHA release profiles, SBOM/provenance binding, and submit/rollout boundaries offline when supplied a trusted public-key store. An iOS-first release therefore contains only `ios-store`; Android facts are neither required nor invented.

Repository tests never create an environment, store release, or live EAS build. The local iOS build wrapper additionally requires a clean source commit already contained in `origin/main`, embeds that commit in the signed main-app `Info.plist`, uses remote EAS credentials for the independent `com.agentsaas.mobile` app, rejects artifact overwrite, and verifies the signed main app plus Share Extension before the separate submit step. Submission is pinned to the independent App Store Connect app `6808382989`, rebuilds the expected identity from the reviewed manifest, and uploads the reverified IPA through an inherited read-only descriptor after unlinking its private snapshot pathname.

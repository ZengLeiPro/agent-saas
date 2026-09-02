# M60-04 mobile release evidence

The release contract has three boundaries. **Build never submits; submit never rebuilds; rollout accepts only a signed submit receipt.** The repository currently validates these boundaries in CI but does not expose an active GitHub Actions release entry point. A live release workflow must be reviewed and added only after the protected environments, organization credentials, provider adapters, and runners are provisioned.

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

Downloaded IPA/AAB/APK files are verified with platform tools before evidence is sealed. Evidence does not contain credentials or temporary EAS download URLs. `mobile/scripts/mobile-release-evidence.mjs` validates canonical digest, Ed25519 signature, nonce, approvals, all three same-SHA profiles, SBOM/provenance binding, and submit/rollout boundaries offline when supplied a trusted public-key store.

No environment, store release, or live EAS build is created by repository tests.

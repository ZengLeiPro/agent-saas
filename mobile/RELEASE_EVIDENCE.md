# M60-04 mobile release evidence

The release contract has three boundaries. **Build never submits; submit never rebuilds; rollout accepts only a signed submit receipt.** The reviewed local iOS path is `pnpm --filter mobile build:ios:only`, followed by `pnpm --filter mobile submit:ios -- <verified-ipa>`.

## iOS-only GitHub Actions entry point

`.github/workflows/mobile-ios-release.yml` exposes **iOS 构建与发布** with `build`, `build-and-submit`, and `submit` operations. It runs `expo prebuild`, CocoaPods, and `xcodebuild` on a GitHub-hosted macOS runner, signs the main app and Share Extension with environment-scoped Apple Distribution credentials, and stores the verified IPA plus source/verification sidecars. It uploads that same IPA with Apple's native tooling, waits for App Store Connect processing, submits the existing App Store version for review, and selects automatic release after approval. It does not use EAS cloud builds, EAS credential storage, or EAS Submit. See `docs/mobile-ios-github-actions.md` for initialization, credentials, versioning, and submit-only recovery.

The entry point accepts only an exact source commit on main with successful latest push-main CI. The build workflow SHA is recorded separately from the app source SHA. PR checks cannot use signing or submission secrets. The `github-ios-build` and `github-ios-submit` records bind GitHub run/attempt/artifact metadata, actual toolchain, checksums, the manual workflow dispatch, and the main-only environment policy. They are **not** the Ed25519 M60 evidence envelopes described below and cannot satisfy M70 rollout admission. The workflow does not claim real-device validation, Apple review approval, store availability or rollout completion. No Android release entry point is introduced.

The iOS entry point uses `mobile-build-production` for the Distribution P12 and two App Store provisioning profiles, and `mobile-submit-ios-store` for the App Store Connect `.p8`, key ID, and issuer ID. Both environments must have an explicit main-only branch policy and no required reviewer: one manual workflow dispatch is the normal release authorization. Environments and external credentials must be provisioned before a live dispatch; a green PR only proves the tested code/toolchain contracts.

## Full M60/M70 protected configuration (fail closed)

The following configuration belongs to the complete signed-evidence / provider / rollout integration, not to an assertion that the iOS-only handoff already implements that integration.

Repository variables:

- `MOBILE_RELEASE_CONFIGURED=true`, `MOBILE_SUBMIT_CONFIGURED=true`, `MOBILE_ROLLOUT_CONFIGURED=true` only after the corresponding integration is provisioned.
- `MOBILE_RELEASE_EVIDENCE_KEY_ID`, public identity for the organization evidence robot key.
- `MOBILE_BUNDLETOOL_1_17_2_SHA256`, reviewed checksum for the exact bundletool binary.
- Store integration variables: `APP_STORE_CONNECT_API_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`, `MOBILE_ENTERPRISE_SUBMIT_ENDPOINT`, `MOBILE_STORE_BUILD_LOOKUP_ENDPOINT`, `MOBILE_ROLLOUT_ENDPOINT`.

Protected environment secrets (organization robot credentials only):

- `EXPO_ORG_ROBOT_TOKEN` (never a personal Expo token).
- `MOBILE_RELEASE_EVIDENCE_PRIVATE_KEY_PEM` and trusted `MOBILE_RELEASE_EVIDENCE_PUBLIC_KEY_PEM`.
- Submit adapters: `APP_STORE_CONNECT_API_KEY_P8`, `ANDROID_PLAY_SERVICE_ACCOUNT_JSON`, or `ENTERPRISE_MDM_ROBOT_TOKEN`; `MOBILE_STORE_LOOKUP_ROBOT_TOKEN` performs the post-submit store build reverse lookup.
- Rollout adapter: `MOBILE_ROLLOUT_ROBOT_TOKEN`.

The full release integration must provision `mobile-build-production`, `mobile-submit-<profile>`, and `mobile-rollout-<profile>` with required reviewers and self-review prevention. It must query and hash the protection rules and fail if approval metadata cannot be obtained. Build, submit, and rollout approvals remain intentionally separate. The iOS-only entry does not configure or invoke rollout.

## Source and artifact contract

`mobile/scripts/authorize-mobile-release-source.mjs` accepts only an annotated `mobile-vX.Y.Z-rc.N` tag contained in `main`, or an exact reviewed commit that is on `main` or is the current head of an open, non-draft PR with a current non-author approval. The iOS Actions entry deliberately uses the stricter main-only subset. A full release integration must verify the checked-out SHA, clean tree, frozen lock digest, release manifest identity/version/profile, and M60-03 policy gate before building. A production manifest may set `target.distribution` to `both` to authorize Store AAB and Enterprise APK from the same SHA; the Android EAS profile still selects one concrete distribution.

Downloaded IPA/AAB/APK files are verified with platform tools before evidence is sealed. Evidence does not contain credentials or temporary EAS download URLs. `mobile/scripts/mobile-release-evidence.mjs` validates canonical digest, Ed25519 signature, nonce, approvals, one to three unique same-SHA release profiles, SBOM/provenance binding, and submit/rollout boundaries offline when supplied a trusted public-key store. An iOS-first signed-evidence release therefore contains only `ios-store`; Android facts are neither required nor invented.

Repository tests never create an environment, upload a build, submit a review, or release an app. The iOS build wrapper requires a clean source commit already contained in `origin/main`, embeds that commit in the signed main-app `Info.plist`, uses a temporary keychain and two explicit App Store profiles for `com.agentsaas.mobile`, rejects artifact overwrite, and verifies the signed main app plus Share Extension before the separate submit step. Submission is pinned to App Store Connect app `6808382989`, rebuilds the expected identity from the reviewed manifest and artifact build number, uploads a private reverified IPA snapshot through an inherited read-only descriptor, waits for Apple processing, and records the review submission and `AFTER_APPROVAL` state.

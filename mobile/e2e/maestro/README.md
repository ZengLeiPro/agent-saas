# M60-02 native E2E

This directory is the authoritative native-device automation surface. Browser viewports, Web tests, simulators and emulators are never accepted as physical-device evidence.

## Local deterministic gate

```bash
pnpm -F mobile lint:maestro
pnpm -F mobile test:m60-02
pnpm -F mobile test:m60-02:prebuild
```

`lint:maestro` reports when the Maestro CLI is unavailable and still runs deterministic static flow/config checks. CI does not download a device provider or invent a receipt.

## Real-device runner contract

`run-native-e2e.mjs` requires these CLI fields:

- `platform`, `device`, `osVersion`, `osRole`, `deviceClass`
- `buildSha`, `appId`, `version`, `signingFingerprint`, `testRunId`, `slot`
- `providerExecutable`, `outputDir`

Secrets/fixtures are injected only through `MOBILE_E2E_ACCOUNTS_JSON`, `MOBILE_E2E_SERVICE_ORIGIN`, `MOBILE_E2E_OTP`, `MOBILE_E2E_FIXTURE_SERVER_ORIGIN`, `MOBILE_E2E_FIXTURE_TOKEN`, `MOBILE_E2E_ARTIFACTS_JSON`, and `MOBILE_E2E_RECEIPT_HMAC_KEY`. Missing or malformed values fail closed. The account JSON contains A/B usernames/passwords and A phone. Artifact JSON contains fixture image/PDF/HTML names, picker/share names and the expected server `attachmentId`. Origins must be HTTPS.

The fixture server must implement authenticated `POST /native-e2e/reset` and `/native-e2e/cleanup`, returning `{ "ok": true, "fixtureVersion": "..." }`. It must use dedicated synthetic, non-PII accounts/content so screenshots are evidence-safe; account A's display name equals its injected username. Every flow receives a reset and cleanup. `fresh-install-login` requires provider uninstall/reinstall before its clear-state launch. Flow `10-upgrade-pending` additionally requires the provider to install the injected old app, create the old-version durable pending submission, and upgrade in place before Maestro starts.

## Injectable provider interface

No vendor or runner label is guessed. The configured executable receives:

```text
providerExecutable prepare-run <context.json>
providerExecutable prepare-flow <context.json>
providerExecutable network-offline <context.json>
providerExecutable network-online <context.json>
providerExecutable cleanup-flow <context.json>
providerExecutable cleanup-run <context.json>
```

`prepare-run` installs/attaches the exact signed build and writes `provider-attestation.json` at the context path. Required attestation fields are `schemaVersion: "1"`, `evidenceKind: "real-device-attestation"`, matching `platform`, `physical: true`, `virtual: false`, `browser: false`, plus non-empty `providerName`, `providerRunId`, `issuedAt`, SHA-256 `deviceIdentifierHash`, and exact `buildSha`, `appId`, `version`, and `signingFingerprint` from the installed signed binary. Provider flow preparation also supplies picker media; for the independent Share Intent flow it authenticates A and sends the native share before launch. For the lifecycle composite, the runner calls `network-offline` and `network-online` between Maestro segments, so iOS and Android use provider-controlled physical connectivity rather than simulator-only toggles. The provider also supplies permission state and old-build upgrade setup where required. A provider or signed-build identity mismatch prevents a real receipt.

## Evidence

A run writes an exclusive, read-only HMAC-sealed `receipt.json`, `junit.xml`, `screenshots.json`, screenshot digests and a redacted log capped at 64 KiB. The temporary raw log is deleted before artifact upload, including failure paths. Failed runs retain only bounded sanitized log evidence and cannot satisfy release validation.

`validate-evidence.mjs` requires exactly these slots on one Git HEAD/build, app version and flow hash:

1. `ios-minimum`
2. `ios-latest`
3. `android-flagship`
4. `android-low-end-small`

It rejects tampering, cross-SHA evidence, simulator/browser claims, replayed receipt/test/provider IDs, failed flows, missing/extra slots and artifact digest mismatches. Checked-in deterministic fixtures are marked `deterministic-mock`; they pass only `--mode mock` and are rejected by the default real-device validator.

`.github/workflows/mobile-native-e2e.yml` supports both `workflow_dispatch` and `workflow_call`. Real jobs exist only when `configured=true` and the exact four-slot matrix passes validation. Secrets are scoped to the real-device and validator jobs; this workflow never runs from pull requests, so fork PRs cannot receive them.

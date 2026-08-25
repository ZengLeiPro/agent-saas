# Release preflight

`scripts/release/preflight.mjs` is a local-only, fail-closed release gate. It does not deploy, mutate Git state, or contact a network service. Its standard output is one JSON object; a blocked result exits with status `1` and lists every `blockingReasons` entry.

```sh
node scripts/release/preflight.mjs \
  --target <40-character-target-sha> \
  --baseline <40-character-baseline-sha> \
  --identity ./runtime-identity.production.json \
  --main main
```

## Checks

1. `target` and `baseline` are complete 40-character Git SHAs.
2. `target` is reachable from the configured `main` ref.
3. `baseline` is an ancestor of `target`.
4. The identity is read from a local filesystem path only and is complete production JSON.
5. Changed files are obtained using `git diff --name-only <baseline>...<target>` and mapped to release components. Any unmapped path blocks the release.

Path mapping is intentionally narrow:

| Path prefix | Component |
| --- | --- |
| `web/` | `web` |
| `server/`, `shared/`, `workspace-shared/` | `api` |
| `hand-server/` | `runtimeWorker` |
| `acs-orchestrator/` | `acs` |

For a component-only inspection, run:

```sh
node scripts/release/classify-components.mjs --baseline <sha> --target <sha>
```

## Runtime identity contract

The identity file must be JSON with this complete shape. It is an input to the gate and must be produced or copied locally before running the command.

```json
{
  "schemaVersion": 1,
  "environment": "production",
  "gitSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "components": {
    "web": { "gitSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "deployedAt": "2026-08-25T00:00:00.000Z" },
    "api": { "gitSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "deployedAt": "2026-08-25T00:00:00.000Z" },
    "runtimeWorker": { "gitSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "deployedAt": "2026-08-25T00:00:00.000Z" },
    "acs": { "gitSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "deployedAt": "2026-08-25T00:00:00.000Z" }
  }
}
```

No URL, `file:` URI, or remote identity source is accepted. The scripts expose their core functions for `node:test`; Git execution and local-file reading are injectable in tests.

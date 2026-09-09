# ACS / DWS design decisions (D01–D10)

Audit: `30cacdc2e05a993f9a47a79c6dc035deffeb9171`. Decisions are implementation targets, not claims that the current code or production already satisfies them. These decisions were first recorded in the isolated local worktree before logic edits; the container transport subsequently failed, so branch-only authoring and non-production CI are used instead. The user handoff 03 overrides errors in 02; 01 invariants remain binding.

## D01 — Separate caller outcome from resource ownership

Use requestId for one HTTP waiter, operationId for shared work, invocationId for the caller's logical task, attemptId for a particular dispatch and leaseKey for its durable fence. A caller result settles once. The resource states are not_started, reserved, running, stop_requested, stopped, background_owned and unknown. A cancelled/timed-out caller is not a stopped resource. Unknown never expires into permission to write. Late receipts may reconcile the exact resource owner but cannot overwrite the settled caller outcome.

A disconnected follower only detaches itself. Explicit operation cancellation targets an operation owner, not all followers or all tasks in a shared runner. Existing invocation lease keys already contain a UUID; use that unique key on the daemon wire rather than the reusable logical invocationId.

## D02 — Phase budgets, not an overall drain execution cap

Budgets and remaining time are specified in 02-budgets-and-ownership.md. Monotonic local elapsed time governs waiting. Persisted UTC deadlines are observations, never evidence of remote termination. Legal foreground Shell defaults/maxima remain 30 minutes; legacy DWS calls can be 24 hours; background work keeps its existing separate ownership.

PR #606 is not reverted. The historical release wait/ACS drain configuration is not automatically restored. The shared SNAT quiesce field is an explicit, deferred compatibility decision: retain the deployed relationship until a separately reviewed configuration migration separates those budgets. No new environment variable or env-scan workaround is introduced.

## D03 — Shared leaders and independently cancellable waiters

One provisioning recipe hash has one owner. Equal-recipe followers can detach without cancelling it. Different recipes may start only after the previous resource owner is proved safe, not merely after the previous HTTP promise rejects. Ensure/delete/prewarm maps keep owner identity checks. A 202 warmup response ends an HTTP waiter, not its background owner. Unresolved writable storage protects equal and ancestor/descendant mount paths across sandbox scopes; string-prefix siblings such as a/b and a/b2 are different paths.

## D04 — Bounded local transport and isolated remote attempts

Local process supervision separately observes error, exit and close, escalates TERM to KILL, bounds waiting for inherited stdio, handles pre-aborted signals and retains UTF-8 decoder state. child.killed only indicates a signal was sent. Local process termination yields remote=unknown, not stopped.

A remote task must not share the daemon control event loop with blocking tool setup/execution. Use a separately bundled per-attempt worker, an independent control plane and exact UID/generation/attempt process identity. A single task timeout does not close the shared daemon. Detached background tasks are inventory-owned and are not accidentally killed with the foreground attempt. Failure to prove descendant termination, PID identity, receipt durability or a detached launch remains unknown. No additional privilege, host PID namespace or writable shared mount is assumed.

## D05 — Durable ownership and fail-closed readers

The selected cross-process journal is a namespace-scoped Kubernetes ConfigMap, updated with resourceVersion compare-and-swap. It records only bounded identifiers, normalized writable storage scope, pinned sandbox UID, attempt/owner generation and resource state; never commands, credentials or stdout. Reserve before dispatch so a crash before an unknown-state update still leaves a blocker. Malformed/future-version records fail closed. Quotas are checked before admission: 128 records and 512 KiB, with 2 KiB diagnostic fields. Terminal retention is bounded; unresolved records are never TTL-deleted.

All readers listed in 02 must participate: admission, lifecycle/capacity, pause/delete/recreate, archive/reset, restart, diagnostics, drain and rollback. A persistence failure after dispatch retains a truthful local blocker. A 403/read error is not an empty journal. RBAC and compatibility are deployment prerequisites, not assumptions. Existing executing/malformed lease residues cannot be released merely because background inventory is empty.

## D06 — Reader-first compatibility and rollback floor

A prepares all ownership readers before B enables new writers. Daemon capabilities are negotiated rather than assumed from optional fields. Legacy daemons may continue compatible work, but a lost legacy stop acknowledgement stays unknown. C requires the dedicated durable-receiver protocol; it must not fall back to a lossy Shell presentation stream.

Legacy DWS readers must exclude accounts migrated to durable-v1 in both listRunnable and direct startAccount. The first safe rollback floor after durable state is written is the reader-capable A release plus its RBAC. Rolling below that floor is blocked unless all new ownership/account states have been resolved under a separately approved operation. See the explicit matrix in 03; optional fields alone are not compatibility evidence.

## D07 — Authenticated, dependency-independent diagnostics

GET operation list/detail and drain diagnostics use bounded in-memory snapshots and the existing bearer-auth boundary. They must remain available while health/kubectl is hung. POST cancellation addresses an exact operation/attempt and reports requested versus remotely confirmed termination truthfully. Separate HTTP waiters, owned work and unresolved recovery counters. No commands, tokens, environment or event bodies are exposed in diagnostics.

Deployment drain may stop waiting for a request only if its resource is stopped or durably handed off to readers that understand it. Otherwise keep the blocker. Existing protocol-1 terminal-publication failure and timed-out drain behavior remain fail closed: no false successful drain and no forced process exit.

## D08 — DWS durable receive, cursor/ACK, account owner and business idempotence

A dedicated receiver consumes raw NDJSON before presentation truncation, persists bounded frames on the durable account workspace with fsync/atomic publication and exposes short structured start/adopt/renew/status/read/ACK/stop operations. Receiver ownership is real background ownership and enters the actual image/bundle paths. A local spool cursor is not an upstream replay cursor.

Use a PostgreSQL-issued monotonic account owner epoch plus revision and receiver identity fences. Old or expired owners cannot renew themselves or ACK a newer owner's data. A source process and a server consumer have distinct identities, permitting safe adoption without gratuitously restarting the source. File/process locks require actual shared-storage validation and may not be deleted merely on a TTL.

ACK follows a fenced durable business-inbox transaction. Re-reading after a crash is deduplicated by account/eventId in PostgreSQL and the existing business-effect/outbox idempotence. In-memory seen sets are not delivery guarantees. Quota exhaustion backpressures/stops visibly; malformed/unsupported events are retained or durably dead-lettered, never silently dropped. Upstream reconnect replay and pre-receive ACK behavior are unverified, so no lossless-switch or end-to-end exactly-once claim is allowed.

## D09 — T0 is a separate, authorized migration

Old running processes do not acquire new capabilities when new code is committed. T0 inventories the real deployed image, account owner, invocation, UID and writable mount. Rehearse readers/RBAC/rollback on an authorized staging RC. Old listener termination requires exact remote proof, not a boolean HTTP cancel. Without that proof, stop the migration or request a clearly scoped controlled interruption with a recorded risk window. Never substitute routine sandbox deletion/restart for the root fix.

Historical DWS incident times and business effects in the handoff are evidence leads only. Production inspection/reconciliation and any replay remain separately authorized. Source code or inflight=0 cannot establish historical event completeness.

## D10 — Cohesive modules and exact artifact provenance

Production source limit is 1000 lines, new tests 800; grandfathered files must not grow. Extract cohesive logic instead of deleting comments or increasing ratchet baselines. Node 22.23.1, pnpm 10.18.3 and locked devDependencies are required. New workers enter package build, root Dockerfile sandbox bundle/smoke, release component classification and CI test selection.

The release route is PR + exact-SHA CI -> authorized staging RC -> promotion of that same RC. ci.yml is not a Server/API/Worker deployment entrypoint; no extra acs-sandbox.yml production dispatch is performed for this work. A/B/C acceptance, staging, production and business evidence are separate verdicts.

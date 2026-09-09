# Compatibility, API contract and operations runbook

Status: design and authorization contract; implementation/evidence status is recorded separately. No commands in this document have been executed against staging or production.

## Compatibility matrix

| Combination | Required behavior |
| --- | --- |
| Baseline ACS + baseline runner | Existing behavior only; no new ownership writer is enabled |
| A readers + baseline runner | Reads unknown/future ownership conservatively; legacy cancellation cannot claim remote stop without proof |
| B owner + baseline runner | Capability negotiation; compatible work allowed only with durable fallback ownership, unsupported stop proof remains blocked |
| B owner + owned-attempt runner | Exact attempt-key/UID/generation receipt and per-attempt supervision; peers remain alive |
| C consumer + durable receiver | Account epoch + revision + receiver identity, durable frame reads and ACK after inbox commit |
| C consumer + missing receiver capability | Explicit unsupported/blocker; no fallback to Shell output stream |
| B/C state + rollback to reader-capable A | New ownership remains protected; legacy gateway excludes durable-v1 accounts in list and direct start |
| B/C state + rollback below A | Unsafe: promotion/rollback must be blocked unless a separately approved reconciliation proves all new state resolved |
| Future/malformed journal, lease or receiver state | Fail closed; never TTL-delete or reinterpret as idle |

The minimum safe rollback release is a concrete reader-capable A artifact digest with required RBAC, not a branch name or an optional field. That digest is NOT_YET_AVAILABLE. CI alone does not establish mixed-image behavior.

## Authenticated API contract

Use existing bearer authentication for operation list/detail, exact-operation cancellation and drain diagnostics. Diagnostics expose bounded identifiers, phases, elapsed/remaining budgets and waiter/owner/recovery counts; no command, stdout, environment, credential or raw DWS payload. Snapshot routes must not call health, kubectl or a remote tool. Cancellation reports requested, already terminal, or remote unknown; never return a successful remote-stop claim from local transport closure.

Receiver controls require accountId, revision, owner epoch, receiver identity and an exact operation. Raw event data remains in the authorized receiver read path, not diagnostic APIs. ACK advances only a validated contiguous cursor already committed to the business inbox under the same account ownership fence.

## T0 first migration

1. Obtain explicit authorization for the exact environment, RC, accounts and actions. This task currently authorizes code/PR/non-production CI only.
2. Read deployed source/image digests, release identity, drain protocol/config and actual DWS owner/invocation/UID/mount inventory. Compare with handoff evidence; do not treat historical observations as current state.
3. Rehearse reader-first rollout, journal RBAC failures, mixed runner images and rollback floor using the exact staging RC. Keep unknown blockers visible and test diagnostic availability independently of health.
4. Handle the old long listener before assuming the new process can drain it. The old process cannot use new cancellation/receiver features. Require exact old remote-stop proof and record the last durable business event/local cursor. A boolean cancellation response is insufficient.
5. Without verified upstream replay, label the handoff interval as a potential gap. A controlled interruption, restart or sandbox deletion requires separate explicit authorization and a bounded account-scoped plan; it is not performed automatically.
6. Start/adopt the durable receiver only after the source-owner fence is established. Verify epoch/revision, spool head, committed inbox cursor and replay deduplication. Record RC/source SHA/run attempt/image digests and logs.
7. Promote the same authorized staging RC. Do not run a second ACS production dispatch. Abort safely if legacy work still owns the drain or compatibility/ownership cannot be proved.

## Daily operation and recovery

Read dependency-independent diagnostics first, then inspect the exact operation/attempt. Distinguish HTTP waiters, executing owners, background owners and unresolved recovery. Cancellation is account/operation scoped. Do not clear a Map, lease, lock or journal record to make a counter zero. Reconcile only against pinned UID/generation/attempt and authoritative remote receipts. A missing process or expired timestamp without identity evidence is not enough.

Spool pressure must produce an observable retained error/backpressure. Do not discard old frames, silently advance cursor, or bulk replay business effects. Malformed events require durable quarantine and a reviewed disposition. PostgreSQL account ownership and inbox/outbox idempotence remain authoritative.

## Rollback

Before rollback, compare target reader capability and journal/account state against the recorded rollback floor. Keep unresolved old work and new receiver ownership intact. Never reset the production drain deadline as a rollback side effect. Never replay events as part of infrastructure rollback. Below-floor rollback, forced interruption and data repair need separate authorization and explicit evidence of the resulting risks.

## Historical DWS business impact

NOT_RUN / BLOCKED pending authorized production evidence. Required evidence: actual source connection gaps, upstream replay/ACK semantics, account owner transitions, spool/inbox event IDs, conversation/run/outbox records and visible replies. Reconcile counts and event identifiers across the incident window; separate upstream absence from local truncation and business suppression. No historical completeness or successful compensation is claimed.

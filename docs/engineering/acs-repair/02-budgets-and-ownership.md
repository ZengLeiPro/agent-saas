# Timeout budgets and ownership inventory

These are design budgets, not measured production results. Timing tests use fake clocks only around actual modules; container/process/cluster claims require separate integration evidence.

## Budgets

| Phase | Budget | Expiry behavior |
| --- | --- | --- |
| HTTP waiter | Contract-specific; never a resource lifetime | Detach waiter; preserve owner |
| Ensure/isolation owner phase | 10 minutes | Fail caller with owned/unknown blocker; no Map eviction admitting a successor |
| Daemon ready | 3 seconds | Bounded local transport failure; no tool dispatch |
| Control heartbeat | Stale at 40 seconds, watchdog tick 10 seconds | Per-attempt uncertainty; never use output or pending count to fake control health |
| Foreground Shell | Existing default and maximum 30 minutes | Respect tool contract; drain is not a lower execution cap |
| Legacy DWS call | 24 hours | Remains legal while migrating to independent durable receiver |
| Background Shell | Existing default 1 hour, maximum 24 hours | Independent background ownership |
| Provision setup | Default 60 seconds, clamp 1–600 seconds | Remote uncertainty retained on transport timeout |
| Provision bootstrap | max(setup budget, 360 seconds) | Same ownership rules as setup |
| Receipt read/write | 10 seconds each | Unknown/failed commit remains owned; cannot return false success |
| Local TERM grace | 2 seconds | Escalate regardless of child.killed unless actual exit was observed |
| Local KILL/stdio grace | 2 seconds | Settle local caller as remote unknown; retain remote owner |
| Final persistence attempt | 10 seconds | Transfer to supervised recovery; no silent owner release |
| DWS short control RPC | 15 seconds | Retry with exact account/epoch/receiver identity |
| DWS account lease | 60 seconds, renew every 20 seconds | Expired owner cannot resurrect or ACK |
| Receiver control lease | At most 40 seconds and below remaining account ownership | Fenced pause/stop/adoption; expiry does not authorize deleting another source process |
| DWS spool | 128 MiB/account, 10,000 frames, 1 MiB/frame | Visible backpressure or retained fault, never truncation |
| Ownership journal | 128 records, 512 KiB, diagnostics 2 KiB/record | Admission rejection before new dispatch; unknown records are not swept |
| Deployment drain | Existing historical 1200-second release / 1140-second ACS relationship | Preserve existing timed-out/failed publication behavior; no task kill |
| SNAT quiesce | Existing coupled configuration | Separate migration required; no silent reset in this PR |

## Ownership writers and readers

| State / writer | Required readers and safety boundary |
| --- | --- |
| HTTP withInflight and deployment drain | Diagnostics, SNAT/release wait; distinguish caller count from resource count |
| ActiveSandboxRegistry: executor/provisioner/warmup/probe | Busy checks, lifecycle, capacity; release only exact acquisition |
| Executor logical invocation map | Cancellation, duplicate admission, recovery; wire uses unique attempt lease key |
| Persistent daemon pending attempts | Waiters, control health, reconnect; a single cancel cannot close peers |
| Manager ensure/delete/prewarm maps; executor ensure; provisioner inFlight | Shared leader/follower joins, recipe change, destructive operation gates; retain owner after waiter timeout |
| Invocation lease annotations: monitor/completion/lifecycle mutations | Policy, inventory, restart, mutation gates, cleanup, safe delete/pause, drift/recreate, capacity |
| Background task files and protection generation | Strict inventory, task control, restart, annotation readers; inventory emptiness is not foreground-stop proof |
| Activity/deletion generations | Completion, scope deletion and late callbacks; pin UID/resourceVersion/generation |
| Durable operation journal | Every admission and final destructive gate, cross-scope writable mounts, list/lifecycle/capacity, archive/reset, restart, drain and rollback |
| Remote attempt worker/receipt | Exact UID + generation + attempt identity; local kubectl close is insufficient |
| PostgreSQL DWS owner/revision/epoch | Gateway, renew, markEvent, receiver controls and transactional inbox insertion |
| DWS deliveryProtocol | Both account listRunnable and direct legacy startAccount; reader-capable rollback floor |
| DWS spool head/ACK cursor | Read pagination, quotas, restart/adoption, fenced ACK; commit durable business inbox first |
| DWS business inbox and effect/outbox stores | Account/event dedup, conversation FIFO, deterministic runs, visible reply idempotence; preserve existing routing safeguards |

Inventory must be rechecked after each implementation batch. A new writer cannot be declared complete while a listed reader is unmodified, unproved, or silently treats an unknown state as absence. Runtime scans and destructive checks must not collapse malformed/forbidden/unavailable inventory into an empty result.

# ACS / DWS implementation evidence

## Exact source checkpoints

| Source SHA | Meaning | Verification |
| --- | --- | --- |
| `30cacdc2e05a993f9a47a79c6dc035deffeb9171` | Handoff audit baseline | Historical reference, not the current production claim |
| `8df72aaa3f3eaf4fc47ae3b24314b51b17d5b8b4` | Reader/primitive preparation plus synchronized main | Evidence run 34376525189 attempt 1: real regression tests 5 PASS / 4 FAIL; primitive tests 14 PASS; typecheck, ratchets and ACS bundle PASS |
| `fe4f6669c7312f17c3239ef86653dd69abffaacf` | Independent invocation pump, shared work owners and retained attempt queue | New actual modules; not a baseline reproduction claim |
| `83f2b920c8b012c073036829ab8546c398861a95` | Runtime integration into executor, manager, local transport, lifecycle and diagnostics | Authored by isolated branch job in run 34381134050; exact-source tests pending |

A bot-authored source commit must be checked by exact SHA, not by the earlier plan commit. This document commit intentionally starts PR checks on the source that includes the applied runtime integration.

## Scope still being implemented

The task is A/B/C, not just the initial four red regressions. Remote attempt supervision, durable reconciliation, the DWS receiver/account/inbox chain, migration compatibility and release rollback fencing remain separate work items until their implementation and tests are recorded here. An unknown owner retained forever is safer than duplicate execution, but is not by itself complete recovery.

Production and shared staging mutations are not authorized by this task. Their validation status remains NOT_RUN. Historical DWS completeness and upstream replay capability remain unverified. Neither a green unit-test suite nor inflight=0 establishes those facts.

## Available validation route

Code is read and committed through the connected GitHub APIs. An existing, temporary branch-only authoring workflow applies explicit, base-SHA-guarded replacements in an isolated checkout; it cannot target main or a runtime. Normal PR CI validates the result. The temporary authoring helper will be removed before final readiness. No local toolchain or container success is assumed.

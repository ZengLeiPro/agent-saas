# ACS / DWS repair evidence index

Audit base and independently read main: `30cacdc2e05a993f9a47a79c6dc035deffeb9171`.

This draft is not a completed root fix. Source-only regression tests precede implementation. A red test is useful only if it fails an expected assertion in a real baseline module; a missing dependency/type failure is not a reproduction. Historical semantic experiments are separate, not counted as regression passes.

Scope remains A (bounded waiting, diagnostics, truthful blockers), B (remote attempt supervision and durable ownership, reader-first compatibility) and C (DWS dedicated durable receiver, account owner, local cursor/ACK and business idempotence). The first test batch covers R01/R02/R03/R04/R05/R06/R10/R14/R26; it does not waive the other requirements.

No merge, staging mutation, production promotion/rollback/restart/delete, runtime-config mutation or business replay has been authorized/performed. No #606 revert, deadline restore or extra ACS production dispatch. Required release route remains exact SHA CI -> authorized staging RC -> same RC promotion.

Initial local source snapshot tree was verified against upstream. Node 22.23.1 / pnpm 10.18.3 and locked development dependencies were obtained by read-only CI; local tool transport timed out during extraction. Local full tests are NOT_RUN, not PASS. Authoritative evidence comes from exact-SHA CI and explicitly recorded commands.

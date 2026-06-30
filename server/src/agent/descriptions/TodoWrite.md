Replace the in-session TODO list (full set, not incremental).
Each item: `content` (imperative), `status` (pending/in_progress/completed), and optional `activeForm` (present continuous form shown while in_progress).
Returns the persisted list.
Stored per-session in memory (LRU 1024 sessions); survives within the same server lifetime.

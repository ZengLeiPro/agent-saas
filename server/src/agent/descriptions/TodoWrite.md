Maintain the visible TODO list for the current session.
Use it for non-trivial multi-step work (usually 3+ real steps), multiple user requests, explicit todo/checklist requests, or when new required steps are discovered during execution.
Do not use it for single-step, trivial, or purely informational requests, and do not update it after every tool call.
Each call sends the complete list and replaces the previous list; send `todos: []` to clear the visible list when the work is fully done and reported.
Each item: `content` (short imperative label), `status` (pending/in_progress/completed), and optional `activeForm` (present-continuous UI label shown while in_progress).
While active work remains, keep exactly one item `in_progress`.
Mark a task `completed` immediately after it is fully done, then move the next task to `in_progress`.
Do not mark completed if tests fail, implementation is partial, dependencies/files are missing, or blockers/errors remain.
Remove items that are no longer relevant.
Returns the persisted list.
Stored per-session in memory (LRU 1024 sessions); survives within the same server lifetime.

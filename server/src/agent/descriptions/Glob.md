Find files matching a glob pattern inside the current workspace.
Supports `*` (no slash), `**` (cross dirs, must be a standalone segment), `?`, character classes `[abc]` / negation `[!abc]`.
Returns paths sorted by mtime (newest first).
Skips node_modules/.git/.venv/.ky-agent/build/dist and symlinks. Max depth 12.

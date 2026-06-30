Search file contents inside the workspace using a JavaScript regex.
Pattern is capped at 256 chars; each file ≤5MB is read fully; total wall-clock ≤5s.
Binary files and symlinks are skipped. Returns matching `path:line:text`.

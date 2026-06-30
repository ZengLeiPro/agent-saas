Run a shell command in the current workspace runtime. Requires Web approval. Authenticated users, including platform admins, default to an isolated workspace runtime; platform admins may explicitly override runtime execution settings. Treat the command environment as the current runtime, not the platform host.

The command starts with cwd set to the current workspace. Put durable outputs, downloaded files, project worktrees, and deliverables under the workspace, preferably `assets/YYYYMMDD/`, `downloads/YYYYMMDD/`, or `projects/`. Use `/tmp`, `$HOME`, and other system paths only for disposable cache.

Large stdout/stderr is allowed up to a hard capture limit. The final tool result is summarized with exit code, wall time, output byte/line counts, and head/tail truncation instead of failing solely because output is over the model-visible budget. For full large outputs, redirect to a workspace file and inspect it with Read/Grep.

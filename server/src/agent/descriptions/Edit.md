Perform an exact string replacement in a workspace text file.
`old_string` must match exactly once (or pass `replace_all: true`).
For new files, use Write. Files >1MB or sensitive paths
(.ky-agent/settings.json, .env, .git/, .ssh/, .npmrc) are rejected.

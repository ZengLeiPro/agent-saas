List the current user's own recent activity: messages the user actively sent (web / DingTalk) across all of their sessions within a time window.
Returns timestamped user messages grouped by session, most recent sessions first. Automated cron prompts and subagent sessions are excluded.
Identity is always the current session's owner — there is no way to query another user. Use `hours` to adjust the lookback window (default 48, max 168).
Typical use: daily memory maintenance, answering "what have I been working on recently".

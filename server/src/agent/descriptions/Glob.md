在当前工作区内按 glob 模式查找文件。
支持 `*`（不跨斜杠）、`**`（跨目录，必须是独立段）、`?`、字符类 `[abc]` / 排除 `[!abc]`。
返回按 mtime 排序的路径（最新在前）。
跳过 node_modules/.git/.venv/.ky-agent/build/dist 与符号链接。最大深度 12。

#!/bin/bash
# playwright-cli wrapper: 强制 per-user browser profile 隔离
#
# 硬约束：无论 AI agent 传入什么 --profile 参数，都会被替换为
# 环境变量 AGENT_BROWSER_PROFILE 指定的路径。
# 这防止了 prompt injection 绕过用户隔离。
#
# 环境变量（由 dispatch.ts 在 agent 启动时注入）：
#   AGENT_BROWSER_PROFILE  - 用户的 browser profile 绝对路径（admin 不设置）

REAL_CLI="/Users/admin/.nvm/versions/node/v22.20.0/bin/playwright-cli"

# admin 用户不设 AGENT_BROWSER_PROFILE，直接透传
if [[ -z "$AGENT_BROWSER_PROFILE" ]]; then
    exec "$REAL_CLI" "$@"
fi

# 检测是否包含 open 子命令
HAS_OPEN=false
ARGS=()
for arg in "$@"; do
    if [[ "$arg" == "open" ]]; then
        HAS_OPEN=true
    fi
    # 剥掉任何 --profile=* 参数（防止 prompt injection 指定别人的 profile）
    if [[ "$arg" == --profile=* ]]; then
        continue
    fi
    ARGS+=("$arg")
done

if $HAS_OPEN; then
    # 强制注入用户的 profile 路径
    exec "$REAL_CLI" "${ARGS[@]}" --profile="$AGENT_BROWSER_PROFILE"
else
    exec "$REAL_CLI" "${ARGS[@]}"
fi

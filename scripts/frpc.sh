#!/bin/bash
# Bypass macOS system proxy for frpc
export NO_PROXY="*"
export ALL_PROXY=""
export all_proxy=""
export HTTP_PROXY=""
export http_proxy=""
export HTTPS_PROXY=""
export https_proxy=""
exec /opt/homebrew/bin/frpc -c ~/.config/frp/frpc.toml

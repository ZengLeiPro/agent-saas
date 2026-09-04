#!/usr/bin/env bash
set -euo pipefail

echo 'Direct OSS rollback is disabled because it cannot prove continuous Production lock ownership. Use the controlled Production Promotion or compatibility compensation workflow.' >&2
exit 1

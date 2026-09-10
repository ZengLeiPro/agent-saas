#!/usr/bin/env bash
set -euo pipefail

KUBECTL_BIN="${KUBECTL_BIN:-kubectl}"
NAMESPACE="${ACS_NAMESPACE:-agent-saas-coding}"
JOURNAL_NAME=acs-operation-ownership-v1
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RBAC_MANIFEST="$ROOT_DIR/acs-orchestrator/k8s/ownership-journal-rbac.yaml"

existing="$($KUBECTL_BIN -n "$NAMESPACE" get configmap "$JOURNAL_NAME" --ignore-not-found -o name)"
if [ -z "$existing" ]; then
  $KUBECTL_BIN -n "$NAMESPACE" create configmap "$JOURNAL_NAME" \
    --from-literal='journal.json={"protocolVersion":1,"records":[]}'
fi

$KUBECTL_BIN apply -f "$RBAC_MANIFEST"

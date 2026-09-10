"""Short authenticated, exact-fence status/cancel RPC; never kill by process name.

A cancellation intent can precede launch. It is not a stopped acknowledgement.
Failure to read or verify a receipt leaves ownership unresolved.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from process_control import read_json, safe_directory, utc_ms, validate_fence  # noqa: E402
from signed_receipts import (  # noqa: E402
    envelope_budget, receipt_key, secure_control_process, verify_document, write_signed,
)


def handle(request: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(request, dict) or request.get("protocolVersion") != 1:
        raise ValueError("unsupported control protocol")
    fence = validate_fence(request.get("fence"))
    key = receipt_key(request.get("receiptKey"))
    action = request.get("action")
    if action not in ("status", "cancel"):
        raise ValueError("unsupported control action")
    root = request.get("workspaceRoot")
    if not isinstance(root, str) or not Path(root).is_absolute():
        raise ValueError("invalid control workspace")
    directory = safe_directory(root, ".ky-agent", "runtime", "attempt-receipts",
                               hashlib.sha256(fence["attemptId"].encode()).hexdigest())
    path = directory / "receipt.json"
    envelope = read_json(path, envelope_budget(16 * 1024)) if path.exists() else None
    receipt = verify_document(envelope, key) if envelope is not None else None
    if receipt is not None and receipt.get("fence") != fence:
        raise ValueError("foreign attempt receipt")
    terminal = receipt is not None and receipt.get("resource") in ("stopped", "not_started", "background_owned")
    requested = False
    if action == "cancel" and not terminal:
        write_signed(directory / "cancel.json", {
            "protocolVersion": 1, "kind": "cancel", "fence": fence, "requestedAtMs": utc_ms(),
        }, key)
        requested = True
    return {"protocolVersion": 1, "receipt": envelope, "cancelRequested": requested,
            "remoteStopped": bool(receipt and receipt.get("resource") in ("stopped", "not_started"))}


def main() -> None:
    secure_control_process()
    raw = sys.stdin.buffer.read(16 * 1024 + 1)
    if len(raw) > 16 * 1024:
        raise ValueError("control input exceeds byte budget")
    result = handle(json.loads(raw))
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        print(json.dumps({"protocolVersion": 1, "error": "attempt_control_unavailable", "remoteStopped": False}))
        sys.exit(1)

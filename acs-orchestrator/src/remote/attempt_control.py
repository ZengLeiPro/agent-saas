"""Short, exact-fence status/cancel RPC. No process-name or stale-PID fallback."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
import sys

from process_control import atomic_json, read_json, safe_directory, validate_fence


def control(request: dict) -> dict:
    fence = validate_fence(request.get("fence"))
    root = Path(request["workspaceRoot"]).resolve(strict=True)
    directory = root / ".ky-agent/runtime/attempt-receipts" / hashlib.sha256(fence["attemptId"].encode()).hexdigest()
    if not directory.resolve(strict=True).is_relative_to(root):
        raise ValueError("receipt path escapes workspace")
    receipt = read_json(directory / "receipt.json")
    if receipt.get("protocolVersion") != 1 or receipt.get("fence") != fence:
        raise ValueError("receipt identity/protocol mismatch")
    if request.get("action") == "cancel":
        if receipt.get("resource") not in ("stopped", "not_started", "background_owned"):
            atomic_json(directory / "cancel.json", {"protocolVersion": 1, "fence": fence})
    elif request.get("action") != "status":
        raise ValueError("unsupported attempt control action")
    return {"protocolVersion": 1, "receipt": receipt, "remoteStopped": receipt.get("resource") in ("stopped", "not_started")}


if __name__ == "__main__":
    try:
        raw = sys.stdin.buffer.read(16 * 1024 + 1)
        if len(raw) > 16 * 1024:
            raise ValueError("control request exceeds budget")
        print(json.dumps(control(json.loads(raw)), separators=(",", ":")))
    except BaseException:
        print(json.dumps({"protocolVersion": 1, "error": "attempt_control_unavailable", "remoteStopped": False}))
        sys.exit(1)

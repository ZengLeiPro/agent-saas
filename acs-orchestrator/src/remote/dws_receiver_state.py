"""Verify an exact DWS source handoff from the attempt subreaper."""
from __future__ import annotations

from datetime import datetime, timezone
import os
from typing import Any

from dws_control import validate_source
from dws_spool import DwsSpool, SpoolError, validate_owner
from process_control import process_identity, resolve_pod_uid


def verified_receiver_handoff(workspace_root: str, value: Any, children: list[int]) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("action") != "start":
        raise SpoolError("invalid_receiver_handoff")
    source = validate_source(value.get("source"))
    owner = validate_owner(value.get("owner"))
    try:
        pod_uid = resolve_pod_uid()
    except RuntimeError as error:
        raise SpoolError("pod_uid_mismatch") from error
    spool = DwsSpool(workspace_root, source, pod_uid)
    with spool.locked():
        meta = spool.load()
        recorded = meta.get("process")
        if not isinstance(recorded, dict) or meta.get("state") not in ("reserved", "running"):
            raise SpoolError("receiver_handoff_state_unavailable")
        pid = recorded.get("pid")
        actual = process_identity(pid) if isinstance(pid, int) else None
        if (not actual or pid not in children or actual.get("parentPid") != os.getpid()
                or actual.get("startTime") != recorded.get("startTime") or actual.get("state") == "Z"):
            raise SpoolError("receiver_handoff_process_mismatch")
        if meta.get("owner") != owner:
            raise SpoolError("receiver_handoff_owner_mismatch")
    protected_until = datetime.fromtimestamp(owner["expiresAtMs"] / 1000, timezone.utc).isoformat().replace("+00:00", "Z")
    return {"kind": "dws", "receiverId": source["receiverId"],
            "source": {"pid": pid, "startTime": actual["startTime"]},
            "protectedUntil": protected_until}

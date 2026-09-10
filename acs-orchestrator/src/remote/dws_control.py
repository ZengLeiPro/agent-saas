"""Short DWS source control RPC. No arbitrary command, output stream or TTL takeover."""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import subprocess
import sys

# 隔离模式不会加入脚本目录；只加载镜像内的受信模块，不恢复工作区搜索路径。
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from dws_spool import DwsSpool, SpoolError, positive_integer, validate_owner
from process_control import POD_IDENTITY_PATH, process_identity


def validate_source(value):
    if not isinstance(value, dict):
        raise SpoolError("invalid_source")
    for key in ("accountId", "receiverId", "profileId", "identityUpdatedAt"):
        text = value.get(key)
        if not isinstance(text, str) or not text or len(text) > 512 or "\0" in text:
            raise SpoolError("invalid_source_identity")
    if not re.fullmatch(r"drx-[A-Za-z0-9-]{1,100}", value["receiverId"]):
        raise SpoolError("invalid_receiver_id")
    if not re.fullmatch(r"[A-Za-z0-9._:@-]+", value["profileId"]) or value["profileId"].startswith("-"):
        raise SpoolError("invalid_profile")
    kinds = value.get("eventKinds")
    if not isinstance(kinds, list) or not kinds or len(kinds) > 2 or any(kind not in ("at_me", "all_direct") for kind in kinds):
        raise SpoolError("invalid_event_kinds")
    return {key: value[key] for key in ("accountId", "receiverId", "profileId", "identityUpdatedAt")} | {"eventKinds": sorted(set(kinds))}


def handle(request):
    if not isinstance(request, dict) or request.get("protocolVersion") != 1:
        raise SpoolError("unsupported_receiver_protocol")
    owner = validate_owner(request.get("owner"))
    source = validate_source(request.get("source"))
    uid = Path(POD_IDENTITY_PATH).read_text(encoding="utf8").strip()
    if not uid or request.get("podUid") != uid:
        raise SpoolError("pod_uid_mismatch")
    if source["accountId"] != owner["accountId"] or source["receiverId"] != owner["receiverId"]:
        raise SpoolError("source_owner_mismatch")
    root = request.get("workspaceRoot")
    if not isinstance(root, str) or not Path(root).is_absolute():
        raise SpoolError("invalid_workspace_root")
    spool = DwsSpool(root, source, uid)
    action = request.get("action")
    if action == "start":
        _meta, created = spool.reserve(owner)
        if created:
            descriptor = spool.source_lock()
            try:
                child = subprocess.Popen([sys.executable, str(Path(__file__).with_name("dws_receiver.py"))],
                                         stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                         pass_fds=(descriptor,), start_new_session=True, close_fds=True)
                # The child blocks on stdin until the durable process identity is published.
                spool.source_state("reserved", process=process_identity(child.pid))
                spec = {"protocolVersion": 1, "workspaceRoot": root, "source": source, "podUid": uid,
                        "lockFd": descriptor, "startBeforeMs": owner["expiresAtMs"], "identityPath": POD_IDENTITY_PATH}
                child.stdin.write((json.dumps(spec) + "\n").encode())
                child.stdin.close()
            finally:
                os.close(descriptor)
        # Retrying a start only inspects the old receipt. It never launches again.
        return spool.status(owner)
    if action == "adopt":
        return spool.adopt(owner)
    if action == "renew":
        return spool.renew(owner)
    if action == "status":
        return spool.status(owner)
    if action == "read":
        return spool.read(owner, positive_integer(request.get("after")), positive_integer(request.get("limit", 32), 1, 32))
    if action == "ack":
        return spool.ack(owner, positive_integer(request.get("through")))
    if action == "stop":
        return spool.stop(owner)
    raise SpoolError("unsupported_receiver_action")


def main():
    raw = sys.stdin.buffer.read(16 * 1024 + 1)
    if len(raw) > 16 * 1024:
        raise SpoolError("control_input_limit")
    result = handle(json.loads(raw))
    sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    try:
        main()
    except BaseException as error:
        code = str(error) if isinstance(error, SpoolError) else "receiver_control_unavailable"
        sys.stdout.write(json.dumps({"protocolVersion": 1, "error": code}) + "\n")
        sys.exit(1)

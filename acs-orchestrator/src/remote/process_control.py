"""Linux process identity and durable-file primitives for the sandbox control plane.

No process-name kill, negative-PID kill or TTL-based ownership deletion is used.
PR_SET_CHILD_SUBREAPER and pidfd are required; unsupported kernels fail closed.
"""
from __future__ import annotations

import ctypes
import errno
import json
import os
from pathlib import Path
import signal
import time
import uuid
from typing import Any

POD_IDENTITY_PATH = "/var/run/acs-identity/pod-uid"
MAX_CONTROL_BYTES = 16 * 1024


def enable_subreaper() -> None:
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        raise OSError(ctypes.get_errno(), "subreaper unavailable")
    enabled = ctypes.c_int(0)
    if libc.prctl(37, ctypes.byref(enabled), 0, 0, 0) != 0 or enabled.value != 1:
        raise RuntimeError("subreaper verification failed")
    fd = os.pidfd_open(os.getpid(), 0)
    try:
        signal.pidfd_send_signal(fd, 0, None, 0)
    finally:
        os.close(fd)


def child_parent_death() -> None:
    # Executed in the freshly forked child before exec. The parent check closes
    # the fork/prctl race; descendants remain the living supervisor's children.
    parent = os.getppid()
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0:  # PR_SET_PDEATHSIG
        os._exit(125)
    if os.getppid() != parent or parent == 1:
        os._exit(125)


def process_identity(pid: int) -> dict[str, Any] | None:
    try:
        text = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
        fields = text[text.rfind(")") + 2:].split()
        return {"pid": pid, "parentPid": int(fields[1]), "startTime": fields[19], "state": fields[0]}
    except FileNotFoundError:
        return None


def direct_children() -> list[int]:
    # /proc/<pid>/task/<tid>/children is the kernel's actual parent relation,
    # including double-forked descendants reparented to this subreaper.
    value = Path(f"/proc/self/task/{os.getpid()}/children").read_text(encoding="ascii")
    children = [int(item) for item in value.split()]
    if len(children) > 8192:
        raise RuntimeError("owned descendant capacity exceeded")
    return children


def signal_child(pid: int, sig: int) -> None:
    before = process_identity(pid)
    if not before or before["parentPid"] != os.getpid():
        return
    try:
        fd = os.pidfd_open(pid, 0)
    except ProcessLookupError:
        return
    try:
        after = process_identity(pid)
        if after and after["parentPid"] == os.getpid() and after["startTime"] == before["startTime"]:
            try:
                signal.pidfd_send_signal(fd, sig, None, 0)
            except ProcessLookupError:
                pass
    finally:
        os.close(fd)


def reap_children() -> tuple[bool, dict[int, int]]:
    exited: dict[int, int] = {}
    while True:
        try:
            pid, status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:  # ECHILD, not merely a missing PID.
            return True, exited
        except InterruptedError:
            continue
        if pid == 0:
            return False, exited
        exited[pid] = os.waitstatus_to_exitcode(status)


def utc_ms() -> int:
    return int(time.time() * 1000)


def safe_directory(root: str, *parts: str) -> Path:
    base = Path(root).resolve(strict=True)
    target = base
    for part in parts:
        if not part or part in (".", "..") or "/" in part or "\\" in part:
            raise ValueError("invalid control directory component")
        target = target / part
        target.mkdir(mode=0o700, exist_ok=True)
        if target.is_symlink() or not target.is_dir() or not target.resolve().is_relative_to(base):
            raise ValueError("control directory escapes the writable workspace")
    return target


def read_json(path: Path, max_bytes: int = MAX_CONTROL_BYTES) -> dict[str, Any]:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        with os.fdopen(fd, "rb") as stream:
            value = stream.read(max_bytes + 1)
    except BaseException:
        # fdopen owns fd once constructed.
        raise
    if len(value) > max_bytes:
        raise ValueError("control document exceeds its byte budget")
    result = json.loads(value)
    if not isinstance(result, dict):
        raise ValueError("control document is not an object")
    return result


def atomic_json(path: Path, value: dict[str, Any], max_bytes: int = MAX_CONTROL_BYTES) -> None:
    data = json.dumps(value, separators=(",", ":"), ensure_ascii=True).encode("ascii")
    if len(data) > max_bytes:
        raise ValueError("control document exceeds its byte budget")
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def validate_fence(value: Any, identity_path: str = POD_IDENTITY_PATH) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("protocolVersion") != 1:
        raise ValueError("unsupported execution fence")
    fields = ("operationId", "attemptId", "ownerId", "sandboxUid", "podUid")
    if any(not isinstance(value.get(key), str) or not value[key] or len(value[key]) > 512 for key in fields):
        raise ValueError("incomplete execution fence")
    actual_uid = Path(identity_path).read_text(encoding="utf-8").strip()
    if not actual_uid or actual_uid != value["podUid"]:
        raise ValueError("pod UID fence mismatch")
    deadline = value.get("startBeforeMs")
    if not isinstance(deadline, int) or isinstance(deadline, bool) or deadline <= 0:
        raise ValueError("invalid dispatch deadline")
    return {"protocolVersion": 1, **{key: value[key] for key in fields}, "startBeforeMs": deadline}


def is_errno(error: BaseException, code: int) -> bool:
    return isinstance(error, OSError) and error.errno == code

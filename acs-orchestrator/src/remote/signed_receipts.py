"""Authenticated control documents; keys never enter a tool's argv/env/workspace.

The control process must become non-dumpable before reading its first secret.
See Linux PR_SET_DUMPABLE(2const) and proc_pid(5). No extra capability is used.
"""
from __future__ import annotations

import base64
import ctypes
import hashlib
import hmac
import json
import re
from pathlib import Path
from typing import Any

from process_control import atomic_json, read_json

KEY_RE = re.compile(r"^[a-f0-9]{64}$")
MAX_PAYLOAD_BYTES = 12 * 1024


def secure_control_process() -> None:
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(4, 0, 0, 0, 0) != 0 or libc.prctl(3, 0, 0, 0, 0) != 0:
        raise RuntimeError("non-dumpable control process is required")


def receipt_key(value: Any) -> bytes:
    if not isinstance(value, str) or not KEY_RE.fullmatch(value):
        raise ValueError("receipt authority is unavailable")
    return bytes.fromhex(value)


def sign_document(value: dict[str, Any], key: bytes) -> dict[str, Any]:
    if not isinstance(key, bytes) or len(key) != 32:
        raise ValueError("invalid receipt authority")
    raw = json.dumps(value, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode("ascii")
    if len(raw) > MAX_PAYLOAD_BYTES:
        raise ValueError("receipt payload exceeds byte budget")
    payload = base64.b64encode(raw).decode("ascii")
    return {"envelopeVersion": 1, "payload": payload,
            "signature": hmac.new(key, payload.encode("ascii"), hashlib.sha256).hexdigest()}


def verify_document(value: Any, key: bytes) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("envelopeVersion") != 1:
        raise ValueError("unsigned control document")
    payload, signature = value.get("payload"), value.get("signature")
    if not isinstance(payload, str) or not payload or len(payload) > 4 * ((MAX_PAYLOAD_BYTES + 2) // 3):
        raise ValueError("invalid receipt payload")
    if not isinstance(signature, str) or not KEY_RE.fullmatch(signature):
        raise ValueError("invalid receipt signature")
    expected = hmac.new(key, payload.encode("ascii"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise ValueError("receipt authentication failed")
    raw = base64.b64decode(payload, validate=True)
    if len(raw) > MAX_PAYLOAD_BYTES or base64.b64encode(raw).decode("ascii") != payload:
        raise ValueError("non-canonical or oversized receipt")
    decoded = json.loads(raw)
    if not isinstance(decoded, dict):
        raise ValueError("invalid signed document")
    return decoded


def read_signed(path: Path, key: bytes) -> dict[str, Any]:
    return verify_document(read_json(path), key)


def write_signed(path: Path, value: dict[str, Any], key: bytes) -> dict[str, Any]:
    envelope = sign_document(value, key)
    atomic_json(path, envelope)
    return envelope

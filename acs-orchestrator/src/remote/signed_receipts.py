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
MAX_PAYLOAD_BYTES = 16 * 1024


def secure_control_process() -> None:
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(4, 0, 0, 0, 0) != 0 or libc.prctl(3, 0, 0, 0, 0) != 0:
        raise RuntimeError("non-dumpable control process is required")


def receipt_key(value: Any) -> bytes:
    if not isinstance(value, str) or not KEY_RE.fullmatch(value):
        raise ValueError("receipt authority is unavailable")
    return bytes.fromhex(value)


def envelope_budget(payload_budget: int) -> int:
    if not isinstance(payload_budget, int) or not 0 < payload_budget <= 4 * 1024 * 1024:
        raise ValueError("invalid signed document budget")
    return 4 * ((payload_budget + 2) // 3) + 256


def sign_document(value: dict[str, Any], key: bytes, max_payload_bytes: int = MAX_PAYLOAD_BYTES) -> dict[str, Any]:
    envelope_budget(max_payload_bytes)
    if not isinstance(key, bytes) or len(key) != 32:
        raise ValueError("invalid receipt authority")
    raw = json.dumps(value, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode("ascii")
    if len(raw) > max_payload_bytes:
        raise ValueError("receipt payload exceeds byte budget")
    payload = base64.b64encode(raw).decode("ascii")
    return {"envelopeVersion": 1, "payload": payload,
            "signature": hmac.new(key, payload.encode("ascii"), hashlib.sha256).hexdigest()}


def verify_document(value: Any, key: bytes, max_payload_bytes: int = MAX_PAYLOAD_BYTES) -> dict[str, Any]:
    envelope_budget(max_payload_bytes)
    if not isinstance(value, dict) or value.get("envelopeVersion") != 1:
        raise ValueError("unsigned control document")
    payload, signature = value.get("payload"), value.get("signature")
    if not isinstance(payload, str) or not payload or len(payload) > 4 * ((max_payload_bytes + 2) // 3):
        raise ValueError("invalid receipt payload")
    if not isinstance(signature, str) or not KEY_RE.fullmatch(signature):
        raise ValueError("invalid receipt signature")
    expected = hmac.new(key, payload.encode("ascii"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise ValueError("receipt authentication failed")
    raw = base64.b64decode(payload, validate=True)
    if len(raw) > max_payload_bytes or base64.b64encode(raw).decode("ascii") != payload:
        raise ValueError("non-canonical or oversized receipt")
    decoded = json.loads(raw)
    if not isinstance(decoded, dict):
        raise ValueError("invalid signed document")
    return decoded


def read_signed(path: Path, key: bytes, max_payload_bytes: int = MAX_PAYLOAD_BYTES) -> dict[str, Any]:
    return verify_document(read_json(path, envelope_budget(max_payload_bytes)), key, max_payload_bytes)


def write_signed(path: Path, value: dict[str, Any], key: bytes, max_payload_bytes: int = MAX_PAYLOAD_BYTES) -> dict[str, Any]:
    envelope = sign_document(value, key, max_payload_bytes)
    atomic_json(path, envelope, envelope_budget(max_payload_bytes))
    return envelope

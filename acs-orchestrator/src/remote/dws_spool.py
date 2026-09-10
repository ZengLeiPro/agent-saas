"""Durable account spool. The display/tool-output stream is never a data source.

Only ACK may prune a frame. An expired consumer lease never stops/replaces the
source, releases its process lock, or deletes unacknowledged data.
"""
from __future__ import annotations

import base64
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
from typing import Any, Iterator

from process_control import atomic_json, process_identity, read_json, safe_directory, utc_ms

FRAME_BYTES = 1024 * 1024
PAGE_BYTES = 2 * 1024 * 1024
PAGE_RECORDS = 32
SPOOL_BYTES = 256 * 1024 * 1024
SPOOL_RECORDS = 100_000
MAX_SEQUENCE = 9007199254740991


class SpoolError(Exception):
    """Fixed diagnostic codes only; no raw frame, profile secret or CLI output."""


def positive_integer(value: Any, minimum: int = 0, maximum: int = MAX_SEQUENCE) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum or value > maximum:
        raise SpoolError("invalid_integer")
    return value


def validate_owner(owner: Any) -> dict[str, Any]:
    if not isinstance(owner, dict):
        raise SpoolError("invalid_owner")
    for key in ("tenantId", "accountId", "receiverId", "ownerId"):
        value = owner.get(key)
        if not isinstance(value, str) or not value or len(value) > 256 or any(char.isspace() for char in value) or "\0" in value:
            raise SpoolError("invalid_owner_identity")
    epoch = owner.get("epoch")
    if not isinstance(epoch, str) or not epoch.isascii() or not epoch.isdecimal() or epoch.startswith("0") or len(epoch) > 19:
        raise SpoolError("invalid_owner_epoch")
    if int(epoch) > 9223372036854775807:
        raise SpoolError("invalid_owner_epoch")
    positive_integer(owner.get("revision"))
    positive_integer(owner.get("expiresAtMs"), 1)
    return dict(owner)


def owner_is_live(owner: dict[str, Any], now: int) -> None:
    # A clock problem can reject a valid lease, never grant indefinite ownership.
    if owner["expiresAtMs"] <= now or owner["expiresAtMs"] > now + 120_000:
        raise SpoolError("consumer_lease_expired_or_invalid")


class DwsSpool:
    def __init__(self, workspace: str, source: dict[str, Any], pod_uid: str):
        if not isinstance(source, dict) or not isinstance(source.get("accountId"), str) or not isinstance(source.get("receiverId"), str):
            raise SpoolError("invalid_source_identity")
        self.source = source
        self.pod_uid = pod_uid
        account_key = hashlib.sha256(source["accountId"].encode()).hexdigest()
        receiver_key = hashlib.sha256(source["receiverId"].encode()).hexdigest()
        self.account_directory = safe_directory(workspace, ".ky-agent", "runtime", "dws-receivers", account_key)
        self.directory = safe_directory(str(self.account_directory), receiver_key)
        self.events = safe_directory(str(self.directory), "events")
        self.meta_path = self.directory / "state.json"
        self.head_path = self.account_directory / "head.json"

    @contextmanager
    def locked(self) -> Iterator[None]:
        descriptor = os.open(self.account_directory / "state.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            # Control calls are short; their caller enforces a bounded RPC budget.
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            yield
        finally:
            os.close(descriptor)

    def source_lock(self) -> int:
        descriptor = os.open(self.account_directory / "source.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return descriptor
        except BaseException:
            os.close(descriptor)
            raise SpoolError("source_already_owned")

    def load(self) -> dict[str, Any]:
        meta = read_json(self.meta_path)
        if meta.get("protocolVersion") != 1 or meta.get("source") != self.source or meta.get("podUid") != self.pod_uid:
            raise SpoolError("source_identity_or_protocol_mismatch")
        for key in ("highestSequence", "acknowledgedSequence", "issuedThrough", "spoolBytes"):
            positive_integer(meta.get(key))
        if meta["acknowledgedSequence"] > meta["highestSequence"]:
            raise SpoolError("invalid_persisted_cursor")
        validate_owner(meta.get("owner"))
        return meta

    def store(self, meta: dict[str, Any]) -> None:
        atomic_json(self.meta_path, meta)

    def reserve(self, owner: dict[str, Any]) -> tuple[dict[str, Any], bool]:
        owner = validate_owner(owner)
        owner_is_live(owner, utc_ms())
        if owner["accountId"] != self.source["accountId"] or owner["receiverId"] != self.source["receiverId"]:
            raise SpoolError("source_owner_mismatch")
        with self.locked():
            if self.head_path.exists():
                head = read_json(self.head_path)
                if head.get("receiverId") != self.source["receiverId"]:
                    # Rotation is not a retry. An operator must reconcile the old
                    # receiver and its backlog before an explicitly approved migration.
                    raise SpoolError("previous_receiver_requires_reconciliation")
            else:
                atomic_json(self.head_path, {"protocolVersion": 1, "receiverId": self.source["receiverId"]})
            if self.meta_path.exists():
                meta = self.load()
                self._assert_owner(meta, owner)
                return meta, False
            meta = {"protocolVersion": 1, "source": self.source, "podUid": self.pod_uid, "owner": owner,
                    "state": "reserved", "highestSequence": 0, "acknowledgedSequence": 0,
                    "issuedThrough": 0, "issuedEpoch": owner["epoch"], "spoolBytes": 0,
                    "sourceReady": False, "stopRequested": False, "needsReconciliation": False}
            self.store(meta)  # Reserve BEFORE a detached process can be launched.
            return meta, True

    def _assert_owner(self, meta: dict[str, Any], owner: dict[str, Any]) -> None:
        owner = validate_owner(owner)
        owner_is_live(owner, utc_ms())
        current = meta["owner"]
        owner_is_live(current, utc_ms())
        for key in ("tenantId", "accountId", "receiverId", "ownerId", "epoch", "revision"):
            if current.get(key) != owner.get(key):
                raise SpoolError("stale_consumer_owner")

    def adopt(self, owner: dict[str, Any]) -> dict[str, Any]:
        owner = validate_owner(owner)
        owner_is_live(owner, utc_ms())
        with self.locked():
            meta = self.load()
            old = meta["owner"]
            for key in ("tenantId", "accountId", "receiverId"):
                if old[key] != owner[key]:
                    raise SpoolError("source_owner_mismatch")
            if int(owner["epoch"]) < int(old["epoch"]):
                raise SpoolError("stale_consumer_owner")
            if owner["epoch"] == old["epoch"]:
                self._assert_owner(meta, owner)  # Never revive an expired epoch.
                if owner["expiresAtMs"] < old["expiresAtMs"]:
                    raise SpoolError("stale_lease_renewal")
            elif owner["revision"] < old["revision"]:
                raise SpoolError("stale_account_revision")
            meta["owner"] = owner
            if meta["issuedEpoch"] != owner["epoch"]:
                meta["issuedEpoch"] = owner["epoch"]
                meta["issuedThrough"] = meta["acknowledgedSequence"]
            self.store(meta)
            return self._snapshot(meta)

    def renew(self, owner: dict[str, Any]) -> dict[str, Any]:
        with self.locked():
            meta = self.load()
            self._assert_owner(meta, owner)
            if owner["expiresAtMs"] < meta["owner"]["expiresAtMs"]:
                raise SpoolError("stale_lease_renewal")
            meta["owner"] = validate_owner(owner)
            self.store(meta)
            return self._snapshot(meta)

    def source_state(self, state: str, **fields: Any) -> None:
        with self.locked():
            meta = self.load()
            meta.update(fields)
            meta["state"] = state
            self.store(meta)

    def stopped_requested(self) -> bool:
        with self.locked():
            return self.load().get("stopRequested") is True

    def append(self, payload: bytes) -> int:
        if len(payload) > FRAME_BYTES:
            raise SpoolError("source_frame_limit")
        with self.locked():
            meta = self.load()
            self._recover_tail(meta)
            sequence = positive_integer(meta["highestSequence"] + 1, 1)
            frame = {"sequence": sequence, "receivedAtMs": utc_ms(),
                     "sha256": hashlib.sha256(payload).hexdigest(), "payloadBase64": base64.b64encode(payload).decode("ascii")}
            size = len(json.dumps(frame, separators=(",", ":"), ensure_ascii=True).encode("ascii"))
            if meta["spoolBytes"] + size > SPOOL_BYTES or sequence - meta["acknowledgedSequence"] > SPOOL_RECORDS:
                raise SpoolError("spool_quota_exhausted")
            atomic_json(self.events / f"{sequence:020d}.json", frame, PAGE_BYTES)
            meta["highestSequence"] = sequence
            meta["spoolBytes"] += size
            self.store(meta)
            return sequence

    def _recover_tail(self, meta: dict[str, Any]) -> None:
        # A frame may be durable while publication of the high-water mark failed.
        # There can be only one such append per live writer; never overwrite it.
        changed = False
        while (self.events / f"{meta['highestSequence'] + 1:020d}.json").exists():
            path = self.events / f"{meta['highestSequence'] + 1:020d}.json"
            frame = read_json(path, PAGE_BYTES)
            if frame.get("sequence") != meta["highestSequence"] + 1:
                raise SpoolError("spool_sequence_corruption")
            payload = base64.b64decode(frame["payloadBase64"], validate=True)
            if len(payload) > FRAME_BYTES or hashlib.sha256(payload).hexdigest() != frame.get("sha256"):
                raise SpoolError("spool_payload_corruption")
            meta["highestSequence"] += 1
            meta["spoolBytes"] += path.stat().st_size
            changed = True
        if changed:
            self.store(meta)

    def read(self, owner: dict[str, Any], after: int, limit: int = PAGE_RECORDS) -> dict[str, Any]:
        positive_integer(after)
        positive_integer(limit, 1, PAGE_RECORDS)
        with self.locked():
            meta = self.load()
            self._assert_owner(meta, owner)
            self._recover_tail(meta)
            if after != meta["acknowledgedSequence"]:
                raise SpoolError("cursor_must_start_at_last_ack")
            frames = []
            size = 2
            for sequence in range(after + 1, min(meta["highestSequence"], after + limit) + 1):
                path = self.events / f"{sequence:020d}.json"
                frame = read_json(path, PAGE_BYTES)
                cost = path.stat().st_size + 1
                if size + cost > PAGE_BYTES:
                    break
                if frame.get("sequence") != sequence:
                    raise SpoolError("spool_sequence_corruption")
                frames.append(frame)
                size += cost
            meta["issuedEpoch"] = owner["epoch"]
            meta["issuedThrough"] = max(meta["issuedThrough"], frames[-1]["sequence"] if frames else after)
            self.store(meta)
            return {**self._snapshot(meta), "records": frames}

    def ack(self, owner: dict[str, Any], through: int) -> dict[str, Any]:
        positive_integer(through)
        with self.locked():
            meta = self.load()
            self._assert_owner(meta, owner)
            if through < meta["acknowledgedSequence"] or through > meta["issuedThrough"] or meta["issuedEpoch"] != owner["epoch"]:
                raise SpoolError("ack_outside_issued_cursor")
            # The caller commits its fenced PG inbox transaction BEFORE this RPC.
            # Persist ACK before pruning; a crash can leak disk, never lose an unACKed frame.
            old_ack = meta["acknowledgedSequence"]
            meta["acknowledgedSequence"] = through
            self.store(meta)
            removed = 0
            for sequence in range(old_ack + 1, through + 1):
                path = self.events / f"{sequence:020d}.json"
                try:
                    removed += path.stat().st_size
                    path.unlink()
                except FileNotFoundError:
                    pass
            directory_fd = os.open(self.events, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
            meta["spoolBytes"] = max(0, meta["spoolBytes"] - removed)
            self.store(meta)
            return self._snapshot(meta)

    def stop(self, owner: dict[str, Any]) -> dict[str, Any]:
        with self.locked():
            meta = self.load()
            self._assert_owner(meta, owner)
            meta["stopRequested"] = True
            self.store(meta)
            return self._snapshot(meta)

    def status(self, owner: dict[str, Any]) -> dict[str, Any]:
        with self.locked():
            meta = self.load()
            self._assert_owner(meta, owner)
            self._recover_tail(meta)
            return self._snapshot(meta)

    def _snapshot(self, meta: dict[str, Any]) -> dict[str, Any]:
        recorded = meta.get("process", {})
        actual = process_identity(recorded.get("pid", -1)) if isinstance(recorded.get("pid"), int) and recorded["pid"] > 0 else None
        alive = bool(actual and actual["startTime"] == recorded.get("startTime") and actual["state"] != "Z")
        state = meta["state"]
        # A missing PID is NOT proof that its descendants stopped.
        if not alive and state not in ("stopped", "blocked", "reserved"):
            state = "unknown"
        snapshot = {"protocolVersion": 1, "accountId": self.source["accountId"], "receiverId": self.source["receiverId"],
                    "podUid": self.pod_uid, "ownerEpoch": meta["owner"]["epoch"], "state": state,
                    "highestSequence": meta["highestSequence"], "acknowledgedSequence": meta["acknowledgedSequence"],
                    "sourceReady": meta.get("sourceReady") is True, "sourceAlive": alive,
                    "upstreamReplay": "unverified", "needsReconciliation": meta.get("needsReconciliation") is True or state == "unknown"}
        for key in ("reasonCode", "proof"):
            if key in meta:
                snapshot[key] = meta[key]
        return snapshot

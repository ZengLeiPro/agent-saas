"""Dedicated account receiver. Only consumer RPCs depend on a consumer lease."""
import fcntl
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import time

from dws_control import validate_source
from dws_receive_stream import DurableRawFrames
from dws_spool import DwsSpool, SpoolError
from process_control import (POD_IDENTITY_PATH, child_parent_death, direct_children,
                             enable_subreaper, process_identity, reap_children, signal_child, utc_ms)


class Receiver:
    def __init__(self, spec):
        if spec.get("protocolVersion") != 1:
            raise SpoolError("unsupported_receiver_protocol")
        self.source = validate_source(spec.get("source"))
        uid = Path(spec.get("identityPath", POD_IDENTITY_PATH)).read_text().strip()
        if not uid or uid != spec.get("podUid"):
            raise SpoolError("pod_uid_mismatch")
        self.spool = DwsSpool(spec["workspaceRoot"], self.source, uid)
        self.lock_fd = spec["lockFd"]
        actual_lock = os.fstat(self.lock_fd)
        expected_lock = (self.spool.account_directory / "source.lock").stat()
        if (actual_lock.st_dev, actual_lock.st_ino) != (expected_lock.st_dev, expected_lock.st_ino):
            raise SpoolError("source_lock_mismatch")
        fcntl.flock(self.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        enable_subreaper()
        with self.spool.locked():
            meta = self.spool.load()
            identity = process_identity(os.getpid())
            saved = meta.get("process", {})
            if not identity or saved.get("pid") != identity["pid"] or saved.get("startTime") != identity["startTime"]:
                raise SpoolError("reserved_process_identity_mismatch")
            if meta["state"] != "reserved":
                raise SpoolError("receiver_already_launched")
            if utc_ms() >= spec["startBeforeMs"] or meta.get("stopRequested"):
                meta.update(state="stopped", proof="never_launched", reasonCode="launch_admission_expired")
                self.spool.store(meta)
                raise SpoolError("launch_admission_expired")
        self.frames = DurableRawFrames(self.spool)
        self.selector = selectors.DefaultSelector()
        self.stderr_tail = b""
        self.stdout_open = True
        self.stop_at = None
        self.reason = None
        self.reported_unknown = False
        keys = ["user_im_message_receive_at" if kind == "at_me" else "user_im_message_receive_o2o_all"
                for kind in self.source["eventKinds"]]
        command = ["dws", "event", "consume", *keys, "--flatten", "-f", "ndjson", "--profile", self.source["profileId"]]
        self.child = subprocess.Popen(command, cwd=spec["workspaceRoot"], stdin=subprocess.DEVNULL,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, close_fds=True,
                                      start_new_session=True, preexec_fn=child_parent_death)
        for stream, tag in ((self.child.stdout, "events"), (self.child.stderr, "diagnostics")):
            os.set_blocking(stream.fileno(), False)
            self.selector.register(stream, selectors.EVENT_READ, tag)
        self.spool.source_state("running", worker=process_identity(self.child.pid))
        for event in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(event, lambda _event, _frame: self.request_stop("receiver_signal"))

    def request_stop(self, reason):
        if self.stop_at is not None:
            return
        self.stop_at = time.monotonic()
        self.reason = reason
        try:
            self.spool.source_state("stopping", reasonCode=reason, needsReconciliation=reason != "stop_requested")
        finally:
            for pid in direct_children():
                signal_child(pid, signal.SIGTERM)

    def poll(self):
        for key, _events in self.selector.select(0.05):
            stream, tag = key.fileobj, key.data
            if tag == "events" and self.frames.blocked:
                self.selector.unregister(stream)
                continue
            try:
                data = os.read(stream.fileno(), 64 * 1024)
            except BlockingIOError:
                continue
            if not data:
                self.selector.unregister(stream)
                if tag == "events":
                    self.stdout_open = False
            elif tag == "events":
                try:
                    self.frames.accept(data)
                except (OSError, ValueError, SpoolError):
                    self.request_stop(self.frames.reason or "spool_persistence_unavailable")
            else:
                self.stderr_tail = (self.stderr_tail + data)[-65536:]
                if b"[event] ready" in self.stderr_tail:
                    self.spool.source_state("stopping" if self.stop_at else "running", sourceReady=True)
                self.stderr_tail = self.stderr_tail[-256:]

    def run(self):
        worker_gone_at = None
        while True:
            self.poll()
            if self.spool.stopped_requested():
                self.request_stop("stop_requested")
            no_children, exited = reap_children()
            if self.child.pid in exited:
                self.child.returncode = exited[self.child.pid]
                worker_gone_at = time.monotonic()
            if no_children:
                until = time.monotonic() + 2
                while self.stdout_open and not self.frames.blocked and time.monotonic() < until:
                    self.poll()
                complete = self.frames.finish() and not self.stdout_open
                reason = self.reason or "source_exited_replay_unverified"
                self.spool.source_state("stopped", proof="subreaper_no_children", sourceReady=False,
                                        reasonCode=reason, needsReconciliation=not complete or reason != "stop_requested")
                return
            now = time.monotonic()
            if worker_gone_at is not None and now - worker_gone_at >= 0.2:
                self.request_stop("source_descendants_remain")
            if self.stop_at is not None and now - self.stop_at >= 2:
                for pid in direct_children():
                    signal_child(pid, signal.SIGKILL)
            if self.stop_at is not None and now - self.stop_at >= 4 and not self.reported_unknown:
                self.reported_unknown = True
                self.spool.source_state("unknown", reasonCode="source_stop_unconfirmed", needsReconciliation=True)
                # Keep the source lock and independent supervisor until ECHILD.


def main():
    raw = sys.stdin.buffer.readline(16 * 1024 + 1)
    if len(raw) > 16 * 1024 or not raw.endswith(b"\n"):
        raise SpoolError("invalid_receiver_start_frame")
    receiver = Receiver(json.loads(raw))
    try:
        receiver.run()
    finally:
        receiver.selector.close()
        os.close(receiver.lock_fd)


if __name__ == "__main__":
    # No exception handler writes a successful stopped receipt.
    main()

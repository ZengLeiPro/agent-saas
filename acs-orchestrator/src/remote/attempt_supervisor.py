"""Per-attempt subreaper. The shared daemon never executes blocking tool code.

A terminal receipt is fsynced only after ECHILD or a verified background handoff.
Unconfirmed cancellation emits an UNKNOWN observation and keeps supervising.
"""
from __future__ import annotations

from collections import deque
import fcntl
import hashlib
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import time
from typing import Any

from process_control import (
    atomic_json, child_parent_death, direct_children, enable_subreaper,
    process_identity, read_json, reap_children, safe_directory, signal_child,
    utc_ms, validate_fence,
)

MAX_INPUT = 4 * 1024 * 1024
MAX_FRAME = 4 * 1024 * 1024
MAX_OUTPUT_QUEUE = 8 * 1024 * 1024
TERM_GRACE = 2.0
UNKNOWN_AFTER = 4.0


class AttemptSupervisor:
    def __init__(self, spec: dict[str, Any]):
        self.spec = spec
        self.fence = validate_fence(spec.get("fence"), spec.get("identityPath", "/var/run/acs-identity/pod-uid"))
        root = safe_directory(spec["workspaceRoot"], ".ky-agent", "runtime", "attempt-receipts")
        self.directory = safe_directory(str(root), hashlib.sha256(self.fence["attemptId"].encode()).hexdigest())
        self.lock_fd = os.open(self.directory / "owner.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        fcntl.flock(self.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.receipt_path = self.directory / "receipt.json"
        if self.receipt_path.exists():
            previous = read_json(self.receipt_path)
            if previous.get("fence") != self.fence:
                raise ValueError("attempt receipt identity collision")
            # A dead supervisor is not permission to rerun its command.
            raise ValueError("attempt already has durable ownership")
        if utc_ms() > self.fence["startBeforeMs"]:
            raise ValueError("dispatch deadline expired before launch")
        enable_subreaper()
        self.selector = selectors.DefaultSelector()
        self.output: deque[bytes] = deque()
        self.output_size = 0
        self.stdout_live = True
        self.stdin_buffer = bytearray()
        self.worker_buffer = bytearray()
        self.final: dict[str, Any] | None = None
        self.reason: str | None = None
        self.cancelled_at: float | None = None
        self.unknown_emitted = False
        self.started = time.monotonic()
        duration = spec.get("timeoutMs", 36 * 60_000)
        if not isinstance(duration, (int, float)) or duration <= 0 or duration > 25 * 60 * 60_000:
            raise ValueError("invalid attempt execution budget")
        self.deadline = self.started + duration / 1000
        self.state("reserved")
        command = spec.get("command")
        if not isinstance(command, list) or not command or any(not isinstance(arg, str) for arg in command):
            raise ValueError("invalid trusted worker command")
        self.child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                      stderr=subprocess.PIPE, cwd=spec["workspaceRoot"],
                                      preexec_fn=child_parent_death, start_new_session=True, close_fds=True)
        assert self.child.stdin and self.child.stdout and self.child.stderr
        # Input contains the existing allowlisted tool environment. It is never
        # copied to argv, a receipt, a diagnostic snapshot or a process env here.
        self.child.stdin.write(json.dumps(spec["input"], separators=(",", ":")).encode())
        self.child.stdin.close()
        self.child.stdin = None
        self.state("running", worker=process_identity(self.child.pid))
        for stream, tag in ((sys.stdin.buffer, "control"), (self.child.stdout, "worker"), (self.child.stderr, "stderr")):
            os.set_blocking(stream.fileno(), False)
            self.selector.register(stream, selectors.EVENT_READ, tag)
        os.set_blocking(sys.stdout.fileno(), False)
        os.set_blocking(sys.stderr.fileno(), False)
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(sig, lambda _s, _f: self.cancel("supervisor_signal"))

    def state(self, resource: str, **extra: Any) -> dict[str, Any]:
        receipt = {"protocolVersion": 1, "fence": self.fence, "resource": resource,
                   "observedAtMs": utc_ms(), "supervisor": process_identity(os.getpid()), **extra}
        atomic_json(self.receipt_path, receipt)
        return receipt

    def emit(self, value: dict[str, Any]) -> None:
        frame = (json.dumps(value, separators=(",", ":"), ensure_ascii=True) + "\n").encode("ascii")
        if len(frame) > MAX_FRAME or self.output_size + len(frame) > MAX_OUTPUT_QUEUE:
            self.cancel("presentation_backpressure")
            return
        if not self.stdout_live:
            return
        self.output.append(frame)
        self.output_size += len(frame)

    def flush(self) -> None:
        while self.output and self.stdout_live:
            try:
                sent = os.write(sys.stdout.fileno(), self.output[0])
            except BlockingIOError:
                return
            except (BrokenPipeError, OSError):
                self.stdout_live = False
                self.output.clear()
                self.output_size = 0
                self.cancel("control_transport_lost")
                return
            self.output_size -= sent
            if sent == len(self.output[0]):
                self.output.popleft()
            else:
                self.output[0] = self.output[0][sent:]
                return

    def cancel(self, reason: str) -> None:
        if self.cancelled_at is not None:
            return
        self.cancelled_at = time.monotonic()
        self.reason = reason
        try:
            self.state("stop_requested", reasonCode=reason)
        except OSError:
            # The controller's reserve-before-dispatch journal still protects us.
            self.reason = "receipt_persistence_unavailable"
        for pid in direct_children():
            signal_child(pid, signal.SIGTERM)

    def worker_frame(self, line: bytes) -> None:
        try:
            output = json.loads(line)
        except (ValueError, UnicodeError):
            self.cancel("invalid_worker_frame")
            return
        if not isinstance(output, dict):
            self.cancel("invalid_worker_frame")
            return
        response = output.get("response") if output.get("kind") == "final" else None
        chunk = output.get("chunk", {})
        if output.get("kind") == "chunk" and isinstance(chunk, dict) and chunk.get("type") == "completed":
            response = chunk.get("response")
        if response is not None:
            if not isinstance(response, dict) or response.get("status") not in ("success", "error"):
                self.cancel("invalid_worker_terminal")
            elif self.final is None:
                self.final = response
            return
        if output.get("kind") == "chunk":
            self.emit(output)
        else:
            self.cancel("unsupported_worker_frame")

    def background_handoff(self) -> dict[str, Any] | None:
        if not self.final or self.final.get("status") != "success" or self.cancelled_at is not None:
            return None
        metadata = self.final.get("metadata", {})
        background = metadata.get("backgroundShell", {}) if isinstance(metadata, dict) else {}
        ids = background.get("activeTaskIds", []) if isinstance(background, dict) else []
        if not isinstance(ids, list) or not ids or len(ids) > 128:
            return None
        protected: set[int] = set()
        tasks: list[dict[str, Any]] = []
        root = Path(self.spec["workspaceRoot"]) / ".ky-agent/runtime/background-shell/tasks"
        for task_id in ids:
            if not isinstance(task_id, str) or not task_id.startswith("shell-bg-") or "/" in task_id or "\\" in task_id:
                return None
            state = read_json(root / task_id / "state.json")
            pid = state.get("workerPid")
            if not isinstance(pid, int) or state.get("taskId") != task_id or state.get("status") not in ("starting", "running", "cancelling"):
                continue
            identity = process_identity(pid)
            if identity and identity["state"] != "Z":
                protected.add(pid)
                tasks.append({"taskId": task_id, **identity})
        children = direct_children()
        if not children or not all(pid in protected for pid in children):
            return None
        return {"kind": "shell", "tasks": tasks, "protectedUntil": background.get("protectedUntil")}

    def poll_input(self) -> None:
        for key, _events in self.selector.select(0.05):
            stream, tag = key.fileobj, key.data
            try:
                data = os.read(stream.fileno(), 64 * 1024)
            except BlockingIOError:
                continue
            if not data:
                self.selector.unregister(stream)
                if tag == "control" and self.final is None:
                    self.cancel("control_transport_lost")
                elif tag == "worker" and self.worker_buffer:
                    self.worker_frame(bytes(self.worker_buffer))
                    self.worker_buffer.clear()
                continue
            if tag == "stderr":
                try:
                    os.write(sys.stderr.fileno(), data[:2048])
                except OSError:
                    pass
                continue
            target = self.stdin_buffer if tag == "control" else self.worker_buffer
            target.extend(data)
            limit = 16 * 1024 if tag == "control" else MAX_FRAME
            if len(target) > limit:
                self.cancel("control_or_worker_frame_limit")
                target.clear()
                continue
            while b"\n" in target:
                line, _, tail = target.partition(b"\n")
                target[:] = tail
                if tag == "worker":
                    if line.strip():
                        self.worker_frame(bytes(line))
                else:
                    try:
                        message = json.loads(line)
                        if message.get("kind") == "cancel" and message.get("fence") == self.fence:
                            self.cancel("cancel_requested")
                    except (ValueError, AttributeError):
                        self.cancel("invalid_control_frame")

    def run(self) -> None:
        worker_exited_at: float | None = None
        while True:
            self.poll_input()
            self.flush()
            no_children, exited = reap_children()
            if self.child.pid in exited:
                self.child.returncode = exited[self.child.pid]
                worker_exited_at = time.monotonic()
            cancel_path = self.directory / "cancel.json"
            if cancel_path.exists() and self.cancelled_at is None:
                request = read_json(cancel_path)
                if request.get("fence") == self.fence:
                    self.cancel("cancel_requested")
            now = time.monotonic()
            if now >= self.deadline:
                self.cancel("execution_deadline")
            handoff = self.background_handoff() if worker_exited_at is not None else None
            if no_children or handoff:
                if self.final is None:
                    # Drain any final bytes already written before waitpid observed exit.
                    self.poll_input()
                response = self.final or {"status": "error", "error": "Owned sandbox attempt stopped before a terminal result"}
                resource = "background_owned" if handoff else "stopped"
                proof = "background_inventory" if handoff else "subreaper_no_children"
                receipt = self.state(resource, proof=proof, **({"background": handoff} if handoff else {}))
                response["metadata"] = {**response.get("metadata", {}), "remoteExecution": {
                    "state": resource, "receipt": receipt}}
                self.emit({"kind": "final", "response": response})
                # The receipt, not successful stdout delivery, is the authority.
                until = time.monotonic() + 2
                while self.output and time.monotonic() < until and self.stdout_live:
                    self.flush()
                    time.sleep(0.01)
                return
            if worker_exited_at is not None and now - worker_exited_at >= 0.2:
                self.cancel("foreground_descendants_remain")
            if self.cancelled_at is not None:
                if now - self.cancelled_at >= TERM_GRACE:
                    for pid in direct_children():
                        signal_child(pid, signal.SIGKILL)
                if now - self.cancelled_at >= UNKNOWN_AFTER and not self.unknown_emitted:
                    self.unknown_emitted = True
                    self.state("unknown", reasonCode=self.reason or "stop_unconfirmed")
                    self.emit({"kind": "final", "response": {"status": "error", "error": "Remote attempt termination is unconfirmed",
                        "metadata": {"remoteExecution": {"state": "unknown", "reasonCode": self.reason}}}})
                    # Keep the lock and subreaper until the descendants actually stop.


def main() -> None:
    raw = sys.stdin.buffer.readline(MAX_INPUT + 1)
    if not raw.endswith(b"\n") or len(raw) > MAX_INPUT:
        raise ValueError("invalid supervisor start frame")
    spec = json.loads(raw)
    supervisor = AttemptSupervisor(spec)
    try:
        supervisor.run()
    finally:
        os.close(supervisor.lock_fd)


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        # Do not manufacture a stopped receipt from an exception or process exit.
        value = {"kind": "final", "response": {"status": "error", "error": "Remote attempt supervisor is unavailable",
            "metadata": {"remoteExecution": {"state": "unknown", "reasonCode": "supervisor_unavailable"}}}}
        try:
            os.write(1, (json.dumps(value) + "\n").encode())
        except OSError:
            pass
        sys.exit(1)

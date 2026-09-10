"""Per-attempt subreaper, independent of the shared control event loop.

A terminal receipt is authenticated and fsynced only after ECHILD or a verified
background handoff. Unknown cancellation keeps the lock and the supervisor.
"""
from __future__ import annotations

from collections import deque
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import time
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from process_control import (  # noqa: E402
    child_parent_death, direct_children, enable_subreaper, process_identity,
    read_json, reap_children, safe_directory, signal_child, utc_ms, validate_fence,
)
from signed_receipts import (  # noqa: E402
    read_signed, receipt_key, secure_control_process, write_signed,
)

MAX_INPUT = 4 * 1024 * 1024
MAX_FRAME = 4 * 1024 * 1024
MAX_OUTPUT_QUEUE = 8 * 1024 * 1024
TERM_GRACE = 2.0
UNKNOWN_AFTER = 4.0


def terminal_error(reason: str) -> dict[str, Any]:
    return {"status": "error", "error": reason}


class AttemptSupervisor:
    def __init__(self, spec: dict[str, Any], initial_control: bytes = b""):
        self.spec = spec
        self.key = receipt_key(spec.get("receiptKey"))
        self.fence = validate_fence(spec.get("fence"), spec.get("identityPath", "/var/run/acs-identity/pod-uid"))
        root = safe_directory(spec["workspaceRoot"], ".ky-agent", "runtime", "attempt-receipts")
        self.directory = safe_directory(str(root), hashlib.sha256(self.fence["attemptId"].encode()).hexdigest())
        self.lock_fd = os.open(self.directory / "owner.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        fcntl.flock(self.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.receipt_path = self.directory / "receipt.json"
        if self.receipt_path.exists():
            previous = read_signed(self.receipt_path, self.key)
            if previous.get("fence") != self.fence:
                raise ValueError("attempt receipt identity collision")
            # A dead supervisor or an expired timestamp is not permission to rerun.
            raise ValueError("attempt already has durable ownership")
        enable_subreaper()
        self.selector = selectors.DefaultSelector()
        self.output: deque[bytes] = deque()
        self.output_size = 0
        self.stdout_live = True
        self.stdin_buffer = bytearray(initial_control)
        self.worker_buffer = bytearray()
        self.worker_input = bytearray()
        self.final: dict[str, Any] | None = None
        self.reason: str | None = None
        self.cancelled_at: float | None = None
        self.unknown_emitted = False
        self.transferred = False
        self.background_pids: set[int] = set()
        self.background_deadline: float | None = None
        self.child: subprocess.Popen | None = None
        self.started = time.monotonic()
        duration = spec.get("timeoutMs", 36 * 60_000)
        if not isinstance(duration, (int, float)) or isinstance(duration, bool) or not math.isfinite(duration) or not 0 < duration <= 25 * 60 * 60_000:
            raise ValueError("invalid attempt execution budget")
        self.deadline = self.started + duration / 1000
        self.state("reserved")
        os.set_blocking(0, False)
        os.set_blocking(1, False)
        os.set_blocking(2, False)
        self.selector.register(sys.stdin.buffer, selectors.EVENT_READ, "control")
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(sig, lambda _s, _f: self.cancel("supervisor_signal"))
        self.consume_control()
        if utc_ms() > self.fence["startBeforeMs"] or self.cancel_requested():
            self.reason = "cancelled_before_launch" if self.cancel_requested() else "dispatch_deadline_elapsed"
            return
        command = spec.get("command")
        if not isinstance(command, list) or not command or any(not isinstance(arg, str) for arg in command):
            raise ValueError("invalid trusted worker command")
        payload = dict(spec["input"])
        payload.pop("receiptKey", None)
        payload.pop("executionFence", None)
        self.worker_input = bytearray(json.dumps(payload, separators=(",", ":"), allow_nan=False).encode())
        self.child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                      stderr=subprocess.PIPE, cwd=spec["workspaceRoot"],
                                      preexec_fn=child_parent_death, start_new_session=True, close_fds=True)
        assert self.child.stdin and self.child.stdout and self.child.stderr
        self.state("running", worker=process_identity(self.child.pid))
        # Do not synchronously fill a worker's stdin: a blocked bootstrap must not
        # prevent cancellation or turn pipe capacity into an unbounded wait.
        for stream, events, tag in ((self.child.stdin, selectors.EVENT_WRITE, "worker_input"),
                                    (self.child.stdout, selectors.EVENT_READ, "worker"),
                                    (self.child.stderr, selectors.EVENT_READ, "stderr")):
            os.set_blocking(stream.fileno(), False)
            self.selector.register(stream, events, tag)

    def state(self, resource: str, **extra: Any) -> dict[str, Any]:
        value = {"protocolVersion": 1, "fence": self.fence, "resource": resource,
                 "observedAtMs": utc_ms(), "supervisor": process_identity(os.getpid()), **extra}
        return write_signed(self.receipt_path, value, self.key)

    def emit(self, value: dict[str, Any]) -> None:
        frame = (json.dumps(value, separators=(",", ":"), ensure_ascii=True) + "\n").encode("ascii")
        if not self.stdout_live:
            return
        if len(frame) > MAX_FRAME or self.output_size + len(frame) > MAX_OUTPUT_QUEUE:
            self.cancel("presentation_backpressure")
            return
        self.output.append(frame)
        self.output_size += len(frame)

    def flush(self) -> None:
        while self.output and self.stdout_live:
            try:
                sent = os.write(1, self.output[0])
            except BlockingIOError:
                return
            except OSError:
                self.stdout_live = False
                self.output.clear()
                self.output_size = 0
                if not self.transferred:
                    self.cancel("control_transport_lost")
                return
            self.output_size -= sent
            if sent == len(self.output[0]):
                self.output.popleft()
            else:
                self.output[0] = self.output[0][sent:]
                return

    def cancel_requested(self) -> bool:
        path = self.directory / "cancel.json"
        if not path.exists():
            return self.cancelled_at is not None
        request = read_signed(path, self.key)
        if request.get("kind") != "cancel" or request.get("fence") != self.fence:
            raise ValueError("foreign cancellation intent")
        return True

    def cancel(self, reason: str) -> None:
        # Once handed off, foreground/transport cancellation must not kill a
        # legitimate background task. Its own task API and deadline govern it.
        if self.cancelled_at is not None or self.transferred:
            return
        self.cancelled_at = time.monotonic()
        self.reason = reason
        try:
            self.state("stop_requested", reasonCode=reason)
        except (OSError, ValueError):
            self.reason = "receipt_persistence_unavailable"
        if self.child is not None and self.child.returncode is None:
            signal_child(self.child.pid, signal.SIGTERM)

    def consume_control(self) -> None:
        while b"\n" in self.stdin_buffer:
            line, _, tail = self.stdin_buffer.partition(b"\n")
            self.stdin_buffer[:] = tail
            if len(line) > 16 * 1024:
                self.cancel("invalid_control_frame")
                continue
            try:
                message = json.loads(line)
                if message.get("kind") == "cancel" and message.get("fence") == self.fence:
                    self.cancel("cancel_requested")
            except (ValueError, AttributeError):
                self.cancel("invalid_control_frame")

    def worker_frame(self, line: bytes) -> None:
        try:
            output = json.loads(line)
            if not isinstance(output, dict):
                raise ValueError("invalid worker frame")
        except (ValueError, UnicodeError):
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

    def background_request(self) -> bool:
        tool = self.spec.get("input", {})
        value = tool.get("input", {})
        return isinstance(value, dict) and ((tool.get("toolName") == "Shell" and value.get("mode") == "background")
                or (tool.get("toolName") == "__DwsReceiver" and value.get("action") == "start"))

    def background_handoff(self) -> dict[str, Any] | None:
        if not self.background_request():
            return None
        tool = self.spec["input"]
        value = tool["input"]
        if tool["toolName"] == "__DwsReceiver":
            # Imported only on this internal path; no model-facing tool can forge
            # a receiver handoff from its presentation metadata.
            from dws_receiver_state import verified_receiver_handoff
            return verified_receiver_handoff(self.spec["workspaceRoot"], value, direct_children())
        task_id = value.get("taskId")
        if not isinstance(task_id, str) or not task_id.startswith("shell-bg-") or "/" in task_id or "\\" in task_id:
            return None
        root = Path(self.spec["workspaceRoot"]) / ".ky-agent/runtime/background-shell/tasks"
        try:
            state = read_json(root / task_id / "state.json")
        except (OSError, ValueError):
            return None
        pid = state.get("workerPid")
        children = direct_children()
        if not isinstance(pid, int) or isinstance(pid, bool) or children != [pid] or state.get("taskId") != task_id:
            return None
        if state.get("status") not in ("starting", "running", "cancelling"):
            return None
        actual = process_identity(pid)
        if not actual or actual["parentPid"] != os.getpid() or actual["state"] == "Z":
            return None
        if state.get("workerStartTime") is not None and state["workerStartTime"] != actual["startTime"]:
            return None
        expires = state.get("expiresAt")
        if not isinstance(expires, str):
            return None
        return {"kind": "shell", "tasks": [{"taskId": task_id, "pid": pid, "startTime": actual["startTime"]}],
                "protectedUntil": expires}

    def poll_input(self) -> None:
        self.consume_control()
        for selected, _events in self.selector.select(0.05):
            stream, tag = selected.fileobj, selected.data
            if tag == "worker_input":
                try:
                    sent = os.write(stream.fileno(), self.worker_input)
                    del self.worker_input[:sent]
                    if not self.worker_input:
                        self.selector.unregister(stream)
                        stream.close()
                except BlockingIOError:
                    pass
                except OSError:
                    self.selector.unregister(stream)
                    stream.close()
                    self.cancel("worker_input_unavailable")
                continue
            try:
                data = os.read(stream.fileno(), 64 * 1024)
            except BlockingIOError:
                continue
            if not data:
                self.selector.unregister(stream)
                if tag == "control" and not self.transferred and self.final is None:
                    self.cancel("control_transport_lost")
                elif tag == "worker" and self.worker_buffer:
                    self.worker_frame(bytes(self.worker_buffer))
                    self.worker_buffer.clear()
                continue
            if tag == "stderr":
                # Tool stderr is already carried by the structured output stream.
                continue
            target = self.stdin_buffer if tag == "control" else self.worker_buffer
            target.extend(data)
            limit = 16 * 1024 if tag == "control" else MAX_FRAME
            if tag == "control":
                self.consume_control()
            else:
                while b"\n" in target:
                    line, _, tail = target.partition(b"\n")
                    target[:] = tail
                    if len(line) > limit:
                        self.cancel("worker_frame_limit")
                    elif line.strip():
                        self.worker_frame(bytes(line))
            if len(target) > limit:
                self.cancel("partial_control_or_worker_frame_limit")
                target.clear()

    def publish(self, resource: str, proof: str, background: dict[str, Any] | None = None) -> None:
        envelope = self.state(resource, proof=proof, **({"background": background} if background else {}))
        response = dict(self.final or terminal_error("Owned attempt stopped before its tool result was confirmed"))
        metadata = response.get("metadata")
        metadata = dict(metadata) if isinstance(metadata, dict) else {}
        if background and background["kind"] == "shell":
            metadata["backgroundShell"] = {"activeTaskIds": [task["taskId"] for task in background["tasks"]],
                                           "protectedUntil": background["protectedUntil"]}
        metadata["remoteExecution"] = {"state": resource, "receipt": envelope}
        response["metadata"] = metadata
        self.emit({"kind": "final", "response": response})

    def run(self) -> None:
        if self.child is None:
            self.final = terminal_error(self.reason or "Attempt cancelled before launch")
            self.publish("not_started", "never_launched")
            self.drain_output()
            return
        worker_exited_at: float | None = None
        while True:
            self.poll_input()
            self.flush()
            no_children, exited = reap_children()
            if self.child.pid in exited:
                self.child.returncode = exited[self.child.pid]
                worker_exited_at = time.monotonic()
            now = time.monotonic()
            if not self.transferred and self.cancel_requested():
                self.cancel("cancel_requested")
            if not self.transferred and now >= self.deadline:
                self.cancel("execution_deadline")
            if no_children:
                self.poll_input()  # consume bytes written just before waitpid observed exit
                self.publish("stopped", "subreaper_no_children")
                self.drain_output()
                return
            if worker_exited_at is not None and not self.transferred:
                handoff = self.background_handoff()
                if handoff:
                    self.publish("background_owned", "background_inventory", handoff)
                    self.transferred = True
                    self.background_pids = set(direct_children())
                    self.drain_output()
            if self.transferred:
                # Remain the subreaper after detachment. If the background worker
                # crashes, its orphaned descendants are not silently forgotten.
                self.background_pids.difference_update(exited)
                for pid in direct_children():
                    if pid not in self.background_pids:
                        signal_child(pid, signal.SIGKILL)
                continue
            if worker_exited_at is not None and now - worker_exited_at >= 0.2:
                self.cancel("foreground_descendants_remain")
            if self.cancelled_at is not None:
                if now - self.cancelled_at >= TERM_GRACE:
                    # A lost launch acknowledgement must not kill an already
                    # published background task. Keep uncertainty until handoff
                    # or descendant termination can actually be demonstrated.
                    protect_pending_handoff = self.background_request() and worker_exited_at is not None
                    if not protect_pending_handoff:
                        for pid in direct_children():
                            signal_child(pid, signal.SIGKILL)
                if now - self.cancelled_at >= UNKNOWN_AFTER and not self.unknown_emitted:
                    self.unknown_emitted = True
                    envelope = self.state("unknown", reasonCode=self.reason or "stop_unconfirmed")
                    self.emit({"kind": "final", "response": {"status": "error", "error": "Remote termination is unconfirmed",
                               "metadata": {"remoteExecution": {"state": "unknown", "receipt": envelope}}}})

    def drain_output(self) -> None:
        deadline = time.monotonic() + 2
        while self.output and time.monotonic() < deadline and self.stdout_live:
            self.flush()
            time.sleep(0.01)


def read_start_frame() -> tuple[dict[str, Any], bytes]:
    buffer = bytearray()
    while b"\n" not in buffer:
        data = os.read(0, 64 * 1024)
        if not data:
            raise ValueError("incomplete supervisor start frame")
        buffer.extend(data)
        if len(buffer) > MAX_INPUT + 16 * 1024:
            raise ValueError("supervisor start frame exceeds budget")
    line, _, tail = buffer.partition(b"\n")
    if len(line) > MAX_INPUT:
        raise ValueError("supervisor start frame exceeds budget")
    value = json.loads(line)
    if not isinstance(value, dict):
        raise ValueError("invalid supervisor start document")
    return value, bytes(tail)


def main() -> None:
    secure_control_process()
    spec, initial_control = read_start_frame()
    supervisor = AttemptSupervisor(spec, initial_control)
    try:
        supervisor.run()
    finally:
        os.close(supervisor.lock_fd)


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        # Exceptions, local exit and failed persistence never manufacture proof.
        value = {"kind": "final", "response": {"status": "error", "error": "Remote supervisor is unavailable",
                 "metadata": {"remoteExecution": {"state": "unknown", "reasonCode": "supervisor_unavailable"}}}}
        try:
            os.write(1, (json.dumps(value) + "\n").encode())
        except OSError:
            pass
        sys.exit(1)

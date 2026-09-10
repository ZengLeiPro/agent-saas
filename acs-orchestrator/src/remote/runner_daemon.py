"""Non-blocking control plane: tool bootstrap/execution never runs in this process.

Launch this file directly with kubectl exec (not through a Node stdin proxy).
Only control processes see receipt keys. A worker receives a stripped tool input.
"""
from __future__ import annotations

from collections import deque
import json
import os
from pathlib import Path
import secrets
import selectors
import signal
import subprocess
import sys
import time
import uuid
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from process_control import POD_IDENTITY_PATH, utc_ms, validate_fence  # noqa: E402
from signed_receipts import receipt_key, secure_control_process, verify_document  # noqa: E402

MAX_FRAME = 4 * 1024 * 1024
MAX_ATTEMPTS = 128
MAX_QUEUE = 16 * 1024 * 1024
PER_ATTEMPT_QUEUE = 4 * 1024 * 1024
CAPABILITIES = ["isolated-attempt-v1", "durable-receipt-v1", "signed-receipt-v1"]


def worker_command() -> list[str]:
    for name in ("sandboxRunner.mjs", "sandboxRunner.js"):
        candidate = HERE.parent / name
        if candidate.is_file():
            return ["node", str(candidate), "--owned-child"]
    candidate = HERE.parent / "sandboxRunner.ts"
    if not candidate.is_file():
        candidate = HERE.parent.parent / "src" / "sandboxRunner.ts"
    if not candidate.is_file():
        raise RuntimeError("sandbox worker bundle is missing")
    return ["node", "--import", "tsx", str(candidate), "--owned-child"]


def unknown(reason: str) -> dict[str, Any]:
    return {"kind": "final", "response": {"status": "error", "error": "Remote attempt remains unresolved",
            "metadata": {"remoteExecution": {"state": "unknown", "reasonCode": reason}}}}


class RunnerDaemon:
    def __init__(self, oneshot: bool = False):
        secure_control_process()
        self.oneshot = oneshot
        self.runner_id = str(uuid.uuid4())
        self.pod_uid = Path(POD_IDENTITY_PATH).read_text(encoding="utf8").strip()
        if not self.pod_uid:
            raise RuntimeError("read-only Pod identity is required")
        self.selector = selectors.DefaultSelector()
        self.requests = bytearray()
        self.jobs: dict[str, dict[str, Any]] = {}
        self.output: deque[tuple[str, bytes]] = deque()
        self.queued = 0
        self.queued_by_key: dict[str, int] = {}
        self.input_open = True
        self.output_open = True
        self.stopping = False
        self.last_heartbeat = time.monotonic()
        os.set_blocking(0, False)
        os.set_blocking(1, False)
        os.set_blocking(2, False)
        self.selector.register(sys.stdin.buffer, selectors.EVENT_READ, ("request", ""))
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(sig, lambda _s, _f: self.stop())

    def enqueue(self, value: dict[str, Any], key: str = "") -> None:
        if not self.output_open:
            return
        data = (json.dumps(value, separators=(",", ":"), ensure_ascii=True) + "\n").encode("ascii")
        if len(data) > MAX_FRAME or self.queued + len(data) > MAX_QUEUE or self.queued_by_key.get(key, 0) + len(data) > PER_ATTEMPT_QUEUE:
            if key in self.jobs:
                self.cancel(key, "presentation_backpressure")
            return
        self.output.append((key, data))
        self.queued += len(data)
        self.queued_by_key[key] = self.queued_by_key.get(key, 0) + len(data)

    def flush(self) -> None:
        while self.output and self.output_open:
            key, data = self.output[0]
            try:
                sent = os.write(1, data)
            except BlockingIOError:
                return
            except OSError:
                self.output_open = False
                self.output.clear()
                self.queued = 0
                self.stop()
                return
            self.queued -= sent
            self.queued_by_key[key] -= sent
            if sent == len(data):
                self.output.popleft()
            else:
                self.output[0] = (key, data[sent:])
                return

    def output_for(self, key: str, output: dict[str, Any]) -> None:
        self.enqueue(output if self.oneshot else {"kind": "invocation_output", "invocationKey": key, "output": output}, key)

    def invoke(self, key: str, supplied: dict[str, Any]) -> None:
        if self.stopping or key in self.jobs or len(self.jobs) >= MAX_ATTEMPTS:
            self.output_for(key, unknown("attempt_admission_blocked"))
            return
        payload = dict(supplied)
        fence_raw = payload.pop("executionFence", None)
        secret = payload.pop("receiptKey", None)
        if fence_raw is None:
            # Reader-first compatibility: older ACS sends no control credentials.
            # Its work still gets isolated supervision, never a fabricated receipt.
            fence_raw = {"protocolVersion": 1, "operationId": "legacy-" + str(uuid.uuid4()),
                         "attemptId": "legacy-" + str(uuid.uuid4()), "ownerId": self.runner_id,
                         "sandboxUid": "legacy-unverified", "podUid": self.pod_uid,
                         "startBeforeMs": utc_ms() + 60_000}
            secret = secrets.token_hex(32)
        elif not isinstance(fence_raw, dict) or fence_raw.get("attemptId") != key:
            self.output_for(key, unknown("attempt_fence_mismatch"))
            return
        fence = validate_fence(fence_raw)
        key_bytes = receipt_key(secret)
        if utc_ms() > fence["startBeforeMs"]:
            self.output_for(key, unknown("dispatch_deadline_elapsed"))
            return
        workspace = payload.get("workspace")
        if not isinstance(workspace, dict) or not isinstance(workspace.get("root"), str):
            raise ValueError("invalid runner workspace")
        tool_input = payload.get("input")
        timeout = tool_input.get("timeoutMs") if isinstance(tool_input, dict) else None
        if not isinstance(timeout, (int, float)) or isinstance(timeout, bool) or timeout <= 0:
            timeout = 30 * 60_000
        timeout = min(timeout, 24 * 60 * 60_000) + 6 * 60_000
        spec = {"protocolVersion": 1, "fence": fence, "receiptKey": secret,
                "input": payload, "workspaceRoot": workspace["root"], "command": worker_command(),
                "timeoutMs": timeout, "identityPath": POD_IDENTITY_PATH}
        process = subprocess.Popen([sys.executable, "-I", str(HERE / "attempt_supervisor.py")],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   close_fds=True, start_new_session=True)
        assert process.stdin and process.stdout and process.stderr
        job = {"process": process, "fence": fence, "key": key_bytes, "buffer": bytearray(),
               "input": bytearray((json.dumps(spec, separators=(",", ":")) + "\n").encode()),
               "cancelled": False, "terminal": False, "exited": False}
        self.jobs[key] = job
        for stream, events, tag in ((process.stdin, selectors.EVENT_WRITE, "input"),
                                    (process.stdout, selectors.EVENT_READ, "worker"),
                                    (process.stderr, selectors.EVENT_READ, "stderr")):
            os.set_blocking(stream.fileno(), False)
            self.selector.register(stream, events, (tag, key))

    def cancel(self, key: str, reason: str = "cancel_requested") -> None:
        job = self.jobs.get(key)
        if not job or job["cancelled"] or job["terminal"]:
            return
        job["cancelled"] = True
        message = {"kind": "cancel", "fence": job["fence"], "reasonCode": reason}
        job["input"].extend((json.dumps(message, separators=(",", ":")) + "\n").encode())
        stream = job["process"].stdin
        if stream and not stream.closed:
            try:
                self.selector.modify(stream, selectors.EVENT_WRITE, ("input", key))
            except KeyError:
                self.selector.register(stream, selectors.EVENT_WRITE, ("input", key))

    def stop(self) -> None:
        self.stopping = True
        for key in list(self.jobs):
            self.cancel(key, "daemon_transport_lost")

    def request(self, line: bytes) -> None:
        value = json.loads(line)
        if not isinstance(value, dict):
            raise ValueError("invalid control frame")
        if self.oneshot:
            control = value.get("executionFence", {})
            key = control.get("attemptId") if isinstance(control, dict) else None
            self.invoke(key if isinstance(key, str) else "oneshot-" + str(uuid.uuid4()), value)
            return
        kind = value.get("kind")
        if kind == "ping" and isinstance(value.get("nonce"), str) and len(value["nonce"]) <= 512:
            self.enqueue({"kind": "daemon_pong", "nonce": value["nonce"]})
            return
        key = value.get("invocationKey")
        if not isinstance(key, str) or not key or len(key) > 512:
            raise ValueError("invalid invocation key")
        if kind == "invoke" and isinstance(value.get("input"), dict):
            try:
                self.invoke(key, value["input"])
            except Exception:
                self.output_for(key, unknown("supervisor_start_unavailable"))
        elif kind == "cancel":
            self.cancel(key)
        else:
            raise ValueError("unsupported control frame")

    def accept_output(self, key: str, line: bytes) -> None:
        job = self.jobs[key]
        try:
            value = json.loads(line)
            if not isinstance(value, dict) or value.get("kind") not in ("final", "chunk"):
                raise ValueError("invalid worker output")
            if value.get("kind") == "final":
                response = value.get("response", {})
                remote = response.get("metadata", {}).get("remoteExecution", {})
                if remote.get("state") in ("stopped", "not_started", "background_owned"):
                    receipt = verify_document(remote.get("receipt"), job["key"])
                    if receipt.get("fence") != job["fence"] or receipt.get("resource") != remote.get("state"):
                        raise ValueError("foreign terminal receipt")
                    job["terminal"] = True
            self.output_for(key, value)
        except (ValueError, TypeError, AttributeError, UnicodeError):
            self.cancel(key, "invalid_supervisor_output")
            self.output_for(key, unknown("invalid_supervisor_output"))

    def poll(self) -> None:
        for selected, _mask in self.selector.select(0.05):
            stream = selected.fileobj
            tag, key = selected.data
            if tag == "input":
                job = self.jobs[key]
                try:
                    sent = os.write(stream.fileno(), job["input"])
                    del job["input"][:sent]
                    if not job["input"]:
                        self.selector.unregister(stream)
                except BlockingIOError:
                    pass
                except OSError:
                    self.selector.unregister(stream)
                    stream.close()
                continue
            try:
                data = os.read(stream.fileno(), 64 * 1024)
            except BlockingIOError:
                continue
            if not data:
                self.selector.unregister(stream)
                if tag == "request":
                    self.input_open = False
                    if self.requests:
                        self.request(bytes(self.requests))
                        self.requests.clear()
                    if not self.oneshot:
                        self.stop()
                elif tag == "worker":
                    job = self.jobs[key]
                    if job["buffer"]:
                        self.accept_output(key, bytes(job["buffer"]))
                        job["buffer"].clear()
                continue
            if tag == "stderr":
                # Raw worker stderr is not a diagnostic/credential channel.
                continue
            buffer = self.requests if tag == "request" else self.jobs[key]["buffer"]
            buffer.extend(data)
            while b"\n" in buffer:
                line, _, tail = buffer.partition(b"\n")
                buffer[:] = tail
                if len(line) > MAX_FRAME:
                    raise ValueError("control frame byte budget exceeded")
                if line.strip():
                    if tag == "request":
                        self.request(bytes(line))
                    else:
                        self.accept_output(key, bytes(line))
            if len(buffer) > MAX_FRAME:
                if tag == "request":
                    raise ValueError("partial control frame byte budget exceeded")
                buffer.clear()
                self.cancel(key, "partial_frame_limit")

    def run(self) -> None:
        if not self.oneshot:
            self.enqueue({"kind": "daemon_ready", "protocolVersion": 1, "runnerId": self.runner_id,
                          "podUid": self.pod_uid, "capabilities": CAPABILITIES})
        while True:
            self.poll()
            for key, job in list(self.jobs.items()):
                if not job["exited"] and job["process"].poll() is not None:
                    job["exited"] = True
                    if not job["terminal"]:
                        self.output_for(key, unknown("supervisor_exit_unconfirmed"))
                if job["exited"] and job["terminal"]:
                    for stream in (job["process"].stdin, job["process"].stdout, job["process"].stderr):
                        if stream:
                            try:
                                self.selector.unregister(stream)
                            except KeyError:
                                pass
                            stream.close()
                    del self.jobs[key]
            now = time.monotonic()
            if not self.oneshot and now - self.last_heartbeat >= 15:
                self.last_heartbeat = now
                self.enqueue({"kind": "daemon_heartbeat", "runnerId": self.runner_id, "at": utc_ms()})
            self.flush()
            live = any(not job["exited"] for job in self.jobs.values())
            if not self.input_open and not live and not self.output:
                return


if __name__ == "__main__":
    try:
        RunnerDaemon(oneshot="--oneshot" in sys.argv).run()
    except BaseException:
        # Exiting the control plane is never reported as remotely stopped.
        sys.exit(1)

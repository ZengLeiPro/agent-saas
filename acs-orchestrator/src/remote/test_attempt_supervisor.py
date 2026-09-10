"""Real Linux subprocess tests, not copies of the ownership algorithm.

Run: python3 -m unittest discover -s acs-orchestrator/src/remote -p 'test_*.py'
All processes, identity files and receipts belong to TemporaryDirectory fixtures.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import selectors
import subprocess
import sys
import tempfile
import time
import unittest

from process_control import process_identity, safe_directory
from signed_receipts import read_signed, receipt_key, verify_document, write_signed

HERE = Path(__file__).resolve().parent


@unittest.skipUnless(sys.platform == "linux" and hasattr(os, "pidfd_open"), "Linux pidfd/subreaper contract")
class AttemptSupervisorTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="acs-owned-test-")
        self.root = Path(self.temporary.name)
        self.identity = self.root / "pod-uid"
        self.identity.write_text("fixture-pod-uid", encoding="utf8")
        self.key = "1" * 64
        self.fence = {"protocolVersion": 1, "operationId": "fixture-operation", "attemptId": "fixture-attempt",
                      "ownerId": "fixture-owner", "sandboxUid": "fixture-sandbox-uid", "podUid": "fixture-pod-uid",
                      "startBeforeMs": int(time.time() * 1000) + 60_000}
        self.processes = []

    def tearDown(self):
        for process in reversed(self.processes):
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=6)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=3)
            for stream in (process.stdin, process.stdout, process.stderr):
                if stream:
                    stream.close()
        self.temporary.cleanup()

    def launch(self, program, fence=None, timeout=20_000, payload=None):
        process = subprocess.Popen([sys.executable, "-I", str(HERE / "attempt_supervisor.py")],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.processes.append(process)
        spec = {"protocolVersion": 1, "fence": fence or self.fence, "receiptKey": self.key,
                "input": payload or {}, "workspaceRoot": str(self.root), "identityPath": str(self.identity),
                "command": [sys.executable, "-I", "-u", "-c", program], "timeoutMs": timeout}
        process.stdin.write((json.dumps(spec) + "\n").encode())
        process.stdin.flush()
        return process

    def terminal(self, process, timeout=12):
        # Read raw bytes so BufferedReader cannot hide a second ready frame from select.
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        buffer = b""
        deadline = time.monotonic() + timeout
        try:
            while time.monotonic() < deadline:
                for _key, _events in selector.select(0.1):
                    data = os.read(process.stdout.fileno(), 65536)
                    if not data:
                        self.fail("supervisor exited without a terminal control frame")
                    buffer += data
                    while b"\n" in buffer:
                        line, _, buffer = buffer.partition(b"\n")
                        value = json.loads(line)
                        if value.get("kind") == "final":
                            return value["response"]
            self.fail("supervisor did not return within fixture deadline")
        finally:
            selector.close()

    def receipt_directory(self):
        return safe_directory(str(self.root), ".ky-agent", "runtime", "attempt-receipts",
                              hashlib.sha256(self.fence["attemptId"].encode()).hexdigest())

    def receipt(self):
        return read_signed(self.receipt_directory() / "receipt.json", receipt_key(self.key))

    def cancel(self, process):
        process.stdin.write((json.dumps({"kind": "cancel", "fence": self.fence}) + "\n").encode())
        process.stdin.flush()

    def test_terminal_requires_reaped_descendants_not_worker_exit(self):
        program = '''import json, os, signal, sys, time
sys.stdin.read()
if os.fork() == 0:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    time.sleep(30)
else:
    print(json.dumps({"kind":"final","response":{"status":"success","content":"parent exited"}}), flush=True)
'''
        process = self.launch(program)
        result = self.terminal(process)
        remote = result["metadata"]["remoteExecution"]
        proof = verify_document(remote["receipt"], receipt_key(self.key))
        self.assertEqual(remote["state"], "stopped")
        self.assertEqual(proof["proof"], "subreaper_no_children")
        self.assertEqual(proof["fence"], self.fence)
        process.wait(timeout=3)
        self.assertEqual(self.receipt()["resource"], "stopped")

    def test_cancel_during_silent_blocking_setup_does_not_kill_peer(self):
        peer = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
        self.processes.append(peer)
        program = '''import signal, sys, time
sys.stdin.read()
signal.signal(signal.SIGTERM, signal.SIG_IGN)
time.sleep(30)
'''
        process = self.launch(program)
        time.sleep(0.2)
        self.cancel(process)
        result = self.terminal(process)
        self.assertEqual(result["metadata"]["remoteExecution"]["state"], "stopped")
        self.assertIsNone(peer.poll(), "attempt cancellation killed an unrelated process")
        process.wait(timeout=3)

    def test_uid_mismatch_never_launches_worker(self):
        marker = self.root / "must-not-exist"
        fence = {**self.fence, "podUid": "wrong-pod-uid"}
        process = self.launch(f"from pathlib import Path; Path({str(marker)!r}).write_text('unsafe')", fence)
        result = self.terminal(process)
        self.assertEqual(result["metadata"]["remoteExecution"]["state"], "unknown")
        process.wait(timeout=3)
        self.assertFalse(marker.exists())

    def test_duplicate_attempt_never_reexecutes_after_terminal_receipt(self):
        marker = self.root / "launches"
        program = f'''import json, sys
sys.stdin.read()
with open({str(marker)!r}, 'a') as stream: stream.write('launch\\n')
print(json.dumps({{"kind":"final","response":{{"status":"success","content":"done"}}}}), flush=True)
'''
        first = self.launch(program)
        self.assertEqual(self.terminal(first)["metadata"]["remoteExecution"]["state"], "stopped")
        first.wait(timeout=3)
        second = self.launch(program)
        self.assertEqual(self.terminal(second)["metadata"]["remoteExecution"]["state"], "unknown")
        second.wait(timeout=3)
        self.assertEqual(marker.read_text(), "launch\n")

    def test_cancel_is_responsive_when_worker_never_reads_large_stdin(self):
        program = "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)"
        process = self.launch(program, payload={"fixture": "x" * (1024 * 1024)})
        time.sleep(0.2)
        self.cancel(process)
        result = self.terminal(process, timeout=8)
        self.assertEqual(result["metadata"]["remoteExecution"]["state"], "stopped")
        process.wait(timeout=3)

    def test_double_fork_and_setsid_do_not_escape_terminal_proof(self):
        marker = self.root / "escaped-pid"
        program = f'''import json, os, signal, sys, time
from pathlib import Path
sys.stdin.read()
if os.fork() == 0:
    os.setsid()
    if os.fork() == 0:
        Path({str(marker)!r}).write_text(str(os.getpid()))
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        time.sleep(30)
    os._exit(0)
else:
    print(json.dumps({{"kind":"final","response":{{"status":"success","content":"done"}}}}), flush=True)
'''
        process = self.launch(program)
        result = self.terminal(process, timeout=10)
        self.assertEqual(result["metadata"]["remoteExecution"]["state"], "stopped")
        process.wait(timeout=3)
        self.assertTrue(marker.exists(), "fixture never created the detached descendant")
        self.assertIsNone(process_identity(int(marker.read_text())))

    @unittest.skipIf(hasattr(os, "geteuid") and os.geteuid() == 0, "same-UID secrecy must be exercised as an unprivileged user")
    def test_worker_cannot_read_ancestor_control_pipe_or_receive_secret_fields(self):
        marker = self.root / "secrecy.json"
        program = f'''import json, os, sys
from pathlib import Path
value = json.load(sys.stdin)
denied = False
try:
    descriptor = os.open('/proc/' + str(os.getppid()) + '/fd/0', os.O_RDONLY | os.O_NONBLOCK)
    os.close(descriptor)
except PermissionError:
    denied = True
Path({str(marker)!r}).write_text(json.dumps({{"denied":denied,"payload":value}}))
print(json.dumps({{"kind":"final","response":{{"status":"success","content":"done"}}}}), flush=True)
'''
        process = self.launch(program, payload={"receiptKey": self.key, "executionFence": self.fence, "fixture": True})
        self.assertEqual(self.terminal(process)["metadata"]["remoteExecution"]["state"], "stopped")
        process.wait(timeout=3)
        observation = json.loads(marker.read_text())
        self.assertTrue(observation["denied"])
        self.assertEqual(observation["payload"], {"fixture": True})
        self.assertNotIn(self.key, (self.receipt_directory() / "receipt.json").read_text())

    def test_cancel_intent_before_launch_proves_not_started(self):
        marker = self.root / "must-not-launch"
        write_signed(self.receipt_directory() / "cancel.json", {"kind": "cancel", "fence": self.fence}, receipt_key(self.key))
        process = self.launch(f"from pathlib import Path; Path({str(marker)!r}).write_text('unsafe')")
        result = self.terminal(process)
        self.assertEqual(result["metadata"]["remoteExecution"]["state"], "not_started")
        self.assertEqual(self.receipt()["proof"], "never_launched")
        process.wait(timeout=3)
        self.assertFalse(marker.exists())

    def test_unsigned_workspace_receipt_cannot_authorize_rerun(self):
        marker = self.root / "must-not-launch"
        (self.receipt_directory() / "receipt.json").write_text(json.dumps({
            "protocolVersion": 1, "fence": self.fence, "resource": "stopped", "proof": "subreaper_no_children",
        }))
        process = self.launch(f"from pathlib import Path; Path({str(marker)!r}).write_text('unsafe')")
        self.assertEqual(self.terminal(process)["metadata"]["remoteExecution"]["state"], "unknown")
        process.wait(timeout=3)
        self.assertFalse(marker.exists())

    def test_terminal_receipt_is_not_overwritten_by_late_transport_cancel(self):
        program = '''import json,sys
sys.stdin.read()
print(json.dumps({"kind":"final","response":{"status":"success","content":"done"}}), flush=True)
'''
        process = self.launch(program)
        self.assertEqual(self.terminal(process)["metadata"]["remoteExecution"]["state"], "stopped")
        try:
            self.cancel(process)
            process.terminate()
        except (BrokenPipeError, ProcessLookupError):
            pass
        process.wait(timeout=3)
        self.assertEqual(self.receipt()["resource"], "stopped")


if __name__ == "__main__":
    unittest.main()

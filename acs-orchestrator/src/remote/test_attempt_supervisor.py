"""Real Linux subprocess tests, not copies of the ownership algorithm.

Run: python3 -m unittest discover -s acs-orchestrator/src/remote -p 'test_*.py'
All processes, identity files and receipts belong to TemporaryDirectory fixtures.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import selectors
import subprocess
import sys
import tempfile
import time
import unittest

from process_control import read_json

HERE = Path(__file__).resolve().parent


@unittest.skipUnless(sys.platform == "linux" and hasattr(os, "pidfd_open"), "Linux pidfd/subreaper contract")
class AttemptSupervisorTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="acs-owned-test-")
        self.root = Path(self.temporary.name)
        self.identity = self.root / "pod-uid"
        self.identity.write_text("fixture-pod-uid", encoding="utf8")
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

    def launch(self, program, fence=None, timeout=20_000):
        process = subprocess.Popen([sys.executable, str(HERE / "attempt_supervisor.py")],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.processes.append(process)
        spec = {"protocolVersion": 1, "fence": fence or self.fence, "input": {},
                "workspaceRoot": str(self.root), "identityPath": str(self.identity),
                "command": [sys.executable, "-u", "-c", program], "timeoutMs": timeout}
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
        proof = result["metadata"]["remoteExecution"]
        self.assertEqual(proof["state"], "stopped")
        self.assertEqual(proof["receipt"]["proof"], "subreaper_no_children")
        self.assertEqual(proof["receipt"]["fence"], self.fence)
        process.wait(timeout=3)
        receipts = list(self.root.glob(".ky-agent/runtime/attempt-receipts/*/receipt.json"))
        self.assertEqual(len(receipts), 1)
        self.assertEqual(read_json(receipts[0])["resource"], "stopped")

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
        process.stdin.write((json.dumps({"kind": "cancel", "fence": self.fence}) + "\n").encode())
        process.stdin.flush()
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


if __name__ == "__main__":
    unittest.main()

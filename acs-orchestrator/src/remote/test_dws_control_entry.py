"""验证生产 Python 隔离启动入口，禁止依赖测试进程已注入的模块目录。"""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class IsolatedControlEntryTests(unittest.TestCase):
    def test_real_entry_ignores_workspace_modules_and_returns_protocol_error(self):
        entry = Path(__file__).resolve().with_name("dws_control.py")
        with tempfile.TemporaryDirectory(prefix="dws-entry-test-") as directory:
            Path(directory, "dws_spool.py").write_text("raise RuntimeError('untrusted workspace module')\n")
            for request, expected in (("{}", "unsupported_receiver_protocol"),
                                      (json.dumps({"protocolVersion": 1}), "invalid_owner")):
                result = subprocess.run([sys.executable, "-I", str(entry)], cwd=directory,
                                        input=request, text=True, capture_output=True, timeout=5)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stderr, "")
                self.assertEqual(json.loads(result.stdout), {"protocolVersion": 1, "error": expected})


if __name__ == "__main__":
    unittest.main()

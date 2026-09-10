"""Image-build smoke only; not a claim about live ACS/NAS behavior."""
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from process_control import enable_subreaper, reap_children  # noqa: E402
from signed_receipts import receipt_key, secure_control_process, sign_document, verify_document  # noqa: E402
from dws_receiver_state import verified_receiver_handoff  # noqa: E402,F401


def main() -> None:
    secure_control_process()
    enable_subreaper()
    key = receipt_key("a" * 64)
    value = {"protocolVersion": 1, "fixture": "image-smoke"}
    if verify_document(sign_document(value, key), key) != value:
        raise RuntimeError("native receipt roundtrip failed")
    child = subprocess.Popen([sys.executable, "-I", "-c", "pass"], close_fds=True)
    child.wait(timeout=5)
    empty, _ = reap_children()
    if not empty:
        raise RuntimeError("native child reaping failed")
    # 按生产的真实隔离入口执行，不能用当前进程已修正的 sys.path 代替验证。
    control = subprocess.run([sys.executable, "-I", str(HERE / "dws_control.py")],
                             input="{}", text=True, capture_output=True, timeout=5)
    if control.returncode != 1 or control.stderr or json.loads(control.stdout) != {
        "protocolVersion": 1, "error": "unsupported_receiver_protocol",
    }:
        raise RuntimeError("isolated DWS control entry smoke failed")
    print(json.dumps({"nativeControlSmoke": "passed", "productionVerification": False}))


if __name__ == "__main__":
    main()

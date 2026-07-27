"""
跑次证据落盘 — runs/<client>/<timestamp>/ 下保存：
  - actions.jsonl  每个写操作一行（op + selector + payload + 截图路径）
  - screenshots/   每个写操作前后的截图
  - dom/           DOM 快照（HTML）
  - video.webm     playwright 自动录的整段视频
  - run.log        rich 输出

证据三套（截图 + DOM + 视频）确保事后能证明：哪些字段被填、点了哪个按钮、确实没点提交。
"""

from __future__ import annotations
import json
import os
import time
from datetime import datetime
from pathlib import Path


SENSITIVE_KEYS = {
    "password",
    "pwd",
    "portal_password",
    "portal_username",
    "客户系统密码",
    "token",
    "authorization",
}


def redact_sensitive(value):
    """递归脱敏，避免 T100 返回的客户系统密码进入审计日志。"""
    if isinstance(value, dict):
        return {
            key: "<redacted>" if str(key).lower() in SENSITIVE_KEYS else redact_sensitive(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact_sensitive(item) for item in value]
    if isinstance(value, tuple):
        return tuple(redact_sensitive(item) for item in value)
    return value


class Audit:
    def __init__(self, client: str, root: str = None):
        # 优先级：显式传入 > 环境变量 > 开发模式默认路径
        # 打包后由 entrypoint.py 设置 WAIN_INVOICE_RUNS_DIR=<exe_dir>/runs
        root = root or os.environ.get("WAIN_INVOICE_RUNS_DIR") \
                    or str(Path.cwd() / "assets" / datetime.now().strftime("%Y%m%d") / "唯恩施耐德发票")
        ts = datetime.now().strftime("%Y%m%d-%H%M%S")
        self.dir = Path(root) / client / ts
        self.dir.mkdir(parents=True, exist_ok=True)
        self.screenshot_dir = self.dir / "screenshots"
        self.screenshot_dir.mkdir(exist_ok=True)
        self.dom_dir = self.dir / "dom"
        self.dom_dir.mkdir(exist_ok=True)
        self.video_dir = self.dir / "video"
        self.video_dir.mkdir(exist_ok=True)
        self.actions_file = self.dir / "actions.jsonl"
        self.log_file = self.dir / "run.log"
        self._counter = 0
        self.log(f"=== run start client={client} dir={self.dir} ===")

    async def record(self, op: str, selector: str, page=None, **payload):
        """每个写操作（click/fill/check/set_input_files）前调用。"""
        self._counter += 1
        idx = f"{self._counter:04d}"
        entry = {
            "ts": time.time(),
            "iso": datetime.now().isoformat(),
            "idx": idx,
            "op": op,
            "selector": selector,
            **payload,
        }
        # 截图 + DOM
        if page:
            try:
                shot = self.screenshot_dir / f"{idx}_{op}.png"
                await page.screenshot(path=str(shot), full_page=False)
                entry["screenshot"] = str(shot.relative_to(self.dir))
            except Exception as e:
                entry["screenshot_error"] = str(e)
            try:
                dom = self.dom_dir / f"{idx}_{op}.html"
                content = await page.content()
                dom.write_text(content, encoding="utf-8")
                entry["dom"] = str(dom.relative_to(self.dir))
            except Exception as e:
                entry["dom_error"] = str(e)
        # JSONL 追加
        with self.actions_file.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    def log(self, msg: str):
        line = f"[{datetime.now().isoformat()}] {msg}"
        print(line)
        with self.log_file.open("a", encoding="utf-8") as f:
            f.write(line + "\n")

    def info(self, msg: str):
        self.log(f"INFO  {msg}")

    def info_data(self, label: str, value):
        self.info(f"{label}: {redact_sensitive(value)}")

    def warn(self, msg: str):
        self.log(f"WARN  {msg}")

    def error(self, msg: str):
        self.log(f"ERROR {msg}")

    async def close(self):
        self.log(f"=== run end actions={self._counter} ===")

"""共享盘 mock：从本地 mocks/share-drive/ 读 fixture。"""

from __future__ import annotations
import json
from pathlib import Path


MOCK_ROOT = Path(__file__).parent.parent.parent / "mocks" / "share-drive"


class ShareDriveMock:
    def __init__(self, cfg: dict):
        self.cfg = cfg

    async def get_express_info(self, statement_no: str, customer: str = "") -> dict:
        # 简化：所有对账单号统一找 fixture
        f = MOCK_ROOT / "express_index.json"
        idx = json.loads(f.read_text(encoding="utf-8"))
        return idx.get(statement_no, idx.get("default", {}))


def create(cfg: dict):
    return ShareDriveMock(cfg)

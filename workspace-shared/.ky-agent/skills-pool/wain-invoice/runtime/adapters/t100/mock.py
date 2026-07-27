"""T100 mock：从 mocks/t100/ 读 JSON fixture。"""

from __future__ import annotations
import json
import os
from pathlib import Path


MOCK_ROOT = Path(__file__).parent.parent.parent / "mocks" / "t100"


class T100Mock:
    def __init__(self, cfg: dict):
        self.cfg = cfg

    async def fetch_pending_invoices(self) -> list[dict]:
        fixture = self.cfg.get("mock_pending_fixture") or "pending_invoices.json"
        f = MOCK_ROOT / fixture
        return json.loads(f.read_text(encoding="utf-8"))

    @property
    def supports_mark_uploaded(self) -> bool:
        return False

    async def download_invoice_files(self, task: dict) -> list[str]:
        # mock：从 mocks/t100/invoices/ 拷一份到 runs/ 临时目录
        src = MOCK_ROOT / "invoices" / f"{task['invoice_no']}.pdf"
        if not src.exists():
            # 用占位文件
            src = MOCK_ROOT / "invoices" / "placeholder.pdf"
        return [str(src)]

    async def get_match_excel(self, task: dict) -> str:
        if task.get("mock_rows"):
            from openpyxl import Workbook

            run_root = os.environ.get("WAIN_INVOICE_ACTIVE_RUN_DIR")
            target_dir = Path(run_root) / "downloads" if run_root else MOCK_ROOT / "generated"
            target_dir.mkdir(parents=True, exist_ok=True)
            company_code = task.get("mock_company_code", "AVXP")
            target = target_dir / f"PP-{company_code}-{task['statement_no']}-对账结果.xlsx"
            workbook = Workbook()
            sheet = workbook.active
            sheet.append(["发票备注栏", "收货日期", "订单号", "行号"])
            for row in task["mock_rows"]:
                sheet.append(
                    [
                        task["invoice_remark"],
                        row["receipt_date"],
                        row["order_no"],
                        row["line_no"],
                    ]
                )
            workbook.save(target)
            workbook.close()
            return str(target)
        return str(MOCK_ROOT / "match_excels" / f"{task['statement_no']}_对账结果.xlsx")

    async def mark_uploaded(self, task: dict):
        raise NotImplementedError("mock 模式不执行 T100 生产回写。")


def create(cfg: dict):
    return T100Mock(cfg)

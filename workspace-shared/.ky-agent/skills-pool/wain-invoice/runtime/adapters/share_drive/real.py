"""
共享盘 real 实现 — 等客户给访问方式后填。

可能形态：
  A) SMB / CIFS 挂载（pysmb）
  B) VPN + 映射盘（Path 直读）
  C) 客户每日同步到 OSS（boto3-style 取）
"""

from __future__ import annotations


class ShareDriveNotImplemented:
    def __init__(self, cfg: dict):
        self.cfg = cfg

    async def get_express_info(self, statement_no: str, customer: str = ""):
        raise NotImplementedError(
            "共享盘真实接入待客户提供方式（见 assets/20260613/唯恩发票POC-需李总配合清单.md 第 3 项）。"
        )


def create(cfg: dict):
    return ShareDriveNotImplemented(cfg)

"""
多级 selector fallback。

selectors.json 结构（每个语义角色对应一组从严到松的 selector）：

{
  "login.username":  ["#username", "input[name='username']", "input[placeholder*='账号']"],
  "login.password":  ["#password", "input[name='password']", "input[type='password']"],
  ...
}

resolve_or_repair():
  - 按顺序尝试，第一个 count > 0 的赢
  - 全部失败 → 调 SelfRepair（截图 + vision 识别 → 写回 selectors.json）
"""

from __future__ import annotations
import json
from pathlib import Path


class SelectorResolver:
    def __init__(self, client: str, audit=None):
        self.client = client
        self.audit = audit
        self._path = Path(__file__).parent.parent / "clients" / client / "selectors.json"
        self._data = json.loads(self._path.read_text(encoding="utf-8"))

    async def resolve(self, page, role: str) -> str | None:
        """按 fallback 顺序找第一个能匹配的 selector，找不到返回 None。"""
        candidates = self._data.get(role)
        if not candidates:
            if self.audit:
                self.audit.warn(f"[selectors] 未定义角色 {role!r}")
            return None
        for sel in candidates:
            try:
                if await page.locator(sel).count() > 0:
                    return sel
            except Exception:
                continue
        return None

    async def resolve_or_repair(self, page, role: str, repair=None) -> str:
        """找不到就尝试自修复；修复也失败则抛 RuntimeError。"""
        sel = await self.resolve(page, role)
        if sel:
            return sel
        if repair:
            new_sel = await repair.fix(page, role)
            if new_sel:
                # 写回 selectors.json（追加到 fallback 头部）
                self._data.setdefault(role, []).insert(0, new_sel)
                self._path.write_text(
                    json.dumps(self._data, ensure_ascii=False, indent=2),
                    encoding="utf-8",
                )
                if self.audit:
                    self.audit.info(f"[selectors] 角色 {role!r} 自修复并写回 selectors.json: {new_sel}")
                return new_sel
        raise RuntimeError(f"[selectors] 角色 {role!r} 全部 fallback 失败且无法自修复")

"""
自检自修复钩子 — 这是赢老板"传统 RPA 你们自己人也能做"质疑的核心卖点。

触发场景：
  1. selectors.json 里所有 fallback 都 count==0
  2. 元素能定位但操作后行为异常（弹窗/超时/字段格式 mismatch）

修复路径：
  截图 + DOM 快照 → 喂多模态模型（vision LLM） → 输出新 selector → 写回 selectors.json

POC 阶段：
  - 留好接口
  - vision 真接入用 anthropic.messages.create(model="claude-...", content=[...image..., text="找到 X 元素的 selector"])
  - 当前 stub 实现：只截图 + 落盘 + 输出告警，等手动 supplement selectors.json
  - 后续把 stub 换成真 vision call 即可（不改外层接口）
"""

from __future__ import annotations
import json
from pathlib import Path


class SelfRepair:
    def __init__(self, audit=None, vision_client=None):
        self.audit = audit
        self.vision = vision_client  # 后续接 anthropic / openai vision

    async def fix(self, page, role: str) -> str | None:
        """
        返回修复后的 selector；失败返回 None。
        """
        if self.audit:
            self.audit.warn(f"[self_repair] 触发自修复 role={role!r}")

        # 1. 拍现场（落 audit dir）
        await self._snapshot(page, role)

        # 2. 调 vision（POC stub）
        if self.vision is None:
            if self.audit:
                self.audit.warn(
                    f"[self_repair] vision_client 未配置，无法自动修复。"
                    f"请人工查 audit dir 截图，更新 selectors.json[{role!r}]"
                )
            return None

        return await self._call_vision(page, role)

    async def _snapshot(self, page, role: str):
        if not self.audit:
            return
        try:
            shot = self.audit.dir / f"self_repair_{role.replace('.', '_')}.png"
            await page.screenshot(path=str(shot), full_page=True)
            dom = self.audit.dir / f"self_repair_{role.replace('.', '_')}.html"
            dom.write_text(await page.content(), encoding="utf-8")
            self.audit.info(f"[self_repair] 现场已存 screenshot={shot.name} dom={dom.name}")
        except Exception as e:
            self.audit.error(f"[self_repair] 现场存档失败：{e}")

    async def _call_vision(self, page, role: str) -> str | None:
        """
        TODO：真接入示例（伪代码）

            screenshot = await page.screenshot(full_page=True)
            html_compact = await page.evaluate("() => document.body.outerHTML.slice(0, 50000)")
            resp = self.vision.messages.create(
                model="claude-fable-5",
                max_tokens=512,
                messages=[{
                    "role": "user",
                    "content": [
                        {"type": "image", "source": {"type": "base64", "data": b64(screenshot)}},
                        {"type": "text", "text": f"找到 role={role} 对应的 CSS selector。"
                                                 f"页面 HTML 节选：{html_compact}"
                                                 f"只输出一行 selector，不解释。"}
                    ],
                }],
            )
            return resp.content[0].text.strip()
        """
        return None

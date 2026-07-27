"""
红线拦截器 — wain-invoice 最关键的安全机制。

POC 期间使用客户**生产环境真实账号**，唯恩客户书面警告：
    "请不要更改数据，可以用测试数据录入，但是不要做最后一步的提交动作"

本模块提供 SafePage 包装 playwright.Page，拦截所有可能"提交/保存/发送"的点击。
策略：
  - HARD_BLOCK：发票/单据上下文的明确动作 → 直接抛 RedlineViolation
  - DANGER_VERBS + 发票上下文 → 抛
  - DANGER_VERBS 但上下文非发票（如查询的"提交"按钮）→ 仅 warn

assert_not_submitted() 在每次流程结束时调用，二次复核没跳到成功页/提交页。
"""

from __future__ import annotations
import re
from typing import Optional


class RedlineViolation(Exception):
    """POC 红线被触发。立即终止流程，不允许重试或绕过。"""


# 命中即拦截（发票/单据相关的明确动作文本）
HARD_BLOCK_PATTERNS = [
    r"上传发票", r"添加发票", r"全电发票上传", r"提交发票",
    r"保存发票", r"发送发票", r"确认提交", r"提交单据",
    r"保存单据", r"发送单据", r"提交开票", r"开票完成",
    # 客户系统特化：新时达 SRM 的 Upload 按钮就是发票上传入口，文本只有 "Upload"
    # 上下文判断不可靠（Invoice Details tab 的祖先元素不含"发票"），列入 HARD_BLOCK 兜底
    r"^Upload$",
]

# 动词级——需要结合上下文判断
DANGER_VERBS = [
    r"^提交$", r"^保存$", r"^发送$", r"^确定$", r"^确认$",
    r"^上传$", r"^添加$", r"^submit$", r"^save$", r"^send$",
    r"^upload$", r"^ok$", r"^confirm$",
]

# 上下文（祖先元素文本 / 弹窗标题 / 页面 title）含这些词 → 当成发票场景
INVOICE_CONTEXT = re.compile(r"发票|单据|票据|开票|invoice|bill|receipt", re.IGNORECASE)

# 跑完应停在的页面，URL/正文出现这些 → 视为已提交
SUBMITTED_URL_HINTS = ["success", "submitted", "complete", "finish", "result"]
SUBMITTED_TEXT_HINTS = ["提交成功", "保存成功", "发送成功", "上传成功", "已提交", "已发送"]


class SafePage:
    """
    playwright Page 的红线包装层。

    所有点击/提交先过 _check_redline；
    所有 fill/check/set_input_files 操作落 audit 留证。

    用法：
        safe = SafePage(page, audit=audit_obj, allow=["#search_btn"])
        await safe.goto(url)
        await safe.fill("#username", "x")
        await safe.click("#login_btn")     # OK
        await safe.click("#submit_invoice") # → RedlineViolation
    """

    def __init__(
        self,
        page,
        audit=None,
        allow: Optional[list] = None,
        commit_reference: str | None = None,
    ):
        self._page = page
        self._audit = audit
        # 客户级白名单只允许绕过 DANGER_VERBS 的软判断，不能绕过 HARD_BLOCK。
        self._allow = set(allow or [])
        self._commit_reference = commit_reference

    def __getattr__(self, name):
        # 透传未包装的方法（goto / wait_for_load_state / inner_text 等只读操作）
        return getattr(self._page, name)

    # ---- 受拦截的写操作 ----

    async def click(self, selector: str, **kwargs):
        text = await self._element_text(selector)
        self._check_hard_block(selector, text)
        if selector in self._allow:
            await self._audit_op("click[allowed]", selector)
            return await self._page.click(selector, **kwargs)
        await self._check_redline(selector, text=text)
        await self._audit_op("click", selector)
        return await self._page.click(selector, **kwargs)

    async def fill(self, selector: str, value: str, **kwargs):
        audit_value = "<redacted>" if re.search(
            r"password|passwd|pwd|口令|密码", selector, re.IGNORECASE
        ) else value
        await self._audit_op("fill", selector, value=audit_value)
        return await self._page.fill(selector, value, **kwargs)

    async def check(self, selector: str, **kwargs):
        await self._audit_op("check", selector)
        return await self._page.check(selector, **kwargs)

    async def select_option(self, selector: str, value, **kwargs):
        await self._audit_op("select_option", selector, value=value)
        return await self._page.select_option(selector, value, **kwargs)

    async def set_input_files(self, selector: str, files, **kwargs):
        """
        上传文件本身用 file input 的 setInputFiles（DOM API，不点按钮）。
        这是上传发票的合法路径——点【上传发票】按钮会被红线拦截。
        """
        await self._audit_op("set_input_files", selector, files=str(files))
        return await self._page.set_input_files(selector, files, **kwargs)

    async def commit_click(self, selector: str, reference: str, **kwargs):
        """
        唯一允许执行最终提交/确认的入口。

        普通 click 永远受红线保护；只有 CLI 显式传入且与当前业务单据完全一致的
        commit_reference，才能走这里完成生产写入。
        """
        if not self._commit_reference:
            raise RedlineViolation(
                "[COMMIT_GATE] 未提供 commit_reference，禁止执行最终确认。"
            )
        if reference != self._commit_reference:
            raise RedlineViolation(
                f"[COMMIT_GATE] 当前单据 {reference!r} 与批准单据 "
                f"{self._commit_reference!r} 不一致。"
            )
        text = await self._element_text(selector)
        await self._audit_op(
            "commit_click",
            selector,
            reference=reference,
            button_text=text,
        )
        return await self._page.click(selector, **kwargs)

    # ---- 红线核心 ----

    async def _element_text(self, selector: str) -> str:
        try:
            loc = self._page.locator(selector)
            return (await loc.inner_text(timeout=2000)).strip()
        except Exception:
            return ""

    def _check_hard_block(self, selector: str, text: str):
        for pat in HARD_BLOCK_PATTERNS:
            if re.search(pat, text):
                raise RedlineViolation(
                    f"[HARD_BLOCK] selector={selector!r} text={text!r} "
                    f"命中 {pat!r}。POC 期禁止点击发票/单据提交类按钮。"
                )

    async def _check_redline(self, selector: str, text: str | None = None):
        text = text if text is not None else await self._element_text(selector)
        self._check_hard_block(selector, text)

        # DANGER_VERBS：text 像「提交/保存」等动词 → 看上下文
        for pat in DANGER_VERBS:
            if re.search(pat, text, re.IGNORECASE):
                ctx = await self._collect_context(selector)
                if INVOICE_CONTEXT.search(ctx) or INVOICE_CONTEXT.search(text):
                    raise RedlineViolation(
                        f"[CTX_BLOCK] selector={selector!r} text={text!r} "
                        f"在发票上下文中（ctx={ctx[:120]!r}），动词 {pat!r} 触发拦截。"
                    )
                # 不在发票上下文（比如查询条件的「提交」）→ 仅警告
                if self._audit:
                    self._audit.warn(
                        f"[CTX_WARN] 通用动词按钮 text={text!r} selector={selector!r} "
                        f"上下文未命中发票相关，放行。ctx={ctx[:80]!r}"
                    )

    async def _collect_context(self, selector: str) -> str:
        """收集祖先元素的 aria-label/data-title/标题文本 + page.title()。"""
        try:
            ctx = await self._page.evaluate(
                """(sel) => {
                    const el = document.querySelector(sel);
                    if (!el) return "";
                    const out = [];
                    let p = el.parentElement;
                    let depth = 0;
                    while (p && depth < 6) {
                        const al = p.getAttribute && p.getAttribute('aria-label');
                        if (al) out.push(al);
                        const dt = p.getAttribute && p.getAttribute('data-title');
                        if (dt) out.push(dt);
                        const h = p.querySelector && p.querySelector(
                            'h1,h2,h3,h4,.title,.modal-title,.dialog-title,.ant-modal-title,.el-dialog__title'
                        );
                        if (h) out.push(h.innerText);
                        p = p.parentElement;
                        depth++;
                    }
                    out.push(document.title);
                    return out.join(' | ');
                }""",
                selector,
            )
            return ctx or ""
        except Exception:
            return ""

    async def _audit_op(self, op: str, selector: str, **payload):
        if self._audit:
            try:
                await self._audit.record(op=op, selector=selector, page=self._page, **payload)
            except Exception as e:
                print(f"[audit] 落盘失败：{e}")


async def assert_not_submitted(page):
    """
    流程结束的二次复核——确保确实停在了核对页，没有跳到任何"成功/已提交"状态。
    在 1.6 核对步骤之后、流程退出之前必须调用。
    """
    url = (page.url or "").lower()
    for hint in SUBMITTED_URL_HINTS:
        if hint in url:
            raise RedlineViolation(f"[POST_CHECK] URL 含提交关键字 {hint!r}：{url}")

    try:
        body = (await page.inner_text("body", timeout=3000))[:8000]
    except Exception:
        body = ""

    for hint in SUBMITTED_TEXT_HINTS:
        if hint in body:
            raise RedlineViolation(f"[POST_CHECK] 页面出现 {hint!r}，疑似已提交")

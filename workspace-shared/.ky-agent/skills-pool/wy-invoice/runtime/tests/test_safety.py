"""
红线拦截器单测。

不依赖真 playwright 浏览器，用 FakePage mock。
所有用例必须过——这套测试就是"我们承诺不点提交"的代码证据。
"""

from __future__ import annotations
import pytest

import sys
import pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from core.safety import SafePage, RedlineViolation


class FakeLocator:
    def __init__(self, text: str):
        self._text = text

    async def inner_text(self, timeout=None):
        return self._text


class FakePage:
    def __init__(self, texts: dict, context: str = "", title: str = ""):
        self._texts = texts
        self._context = context
        self._title = title
        self.url = "http://srm.stepelectric.com/some/page"
        self.clicked = False
        self.filled = []

    def locator(self, sel):
        return FakeLocator(self._texts.get(sel, ""))

    async def evaluate(self, fn, *args):
        # _collect_context 调它
        return f"{self._context} | {self._title}"

    async def click(self, sel, **kwargs):
        self.clicked = True

    async def fill(self, sel, val, **kwargs):
        self.filled.append((sel, val))


# ---- HARD_BLOCK：发票/单据明确动作 → 必拦 ----

@pytest.mark.asyncio
async def test_hard_block_upload_invoice():
    page = FakePage(texts={"#btn": "上传发票"})
    safe = SafePage(page)
    with pytest.raises(RedlineViolation, match="HARD_BLOCK"):
        await safe.click("#btn")


@pytest.mark.asyncio
async def test_hard_block_add_invoice():
    page = FakePage(texts={"#btn": "添加发票"})
    safe = SafePage(page)
    with pytest.raises(RedlineViolation, match="HARD_BLOCK"):
        await safe.click("#btn")


@pytest.mark.asyncio
async def test_hard_block_confirm_submit():
    page = FakePage(texts={"#btn": "确认提交"})
    safe = SafePage(page)
    with pytest.raises(RedlineViolation, match="HARD_BLOCK"):
        await safe.click("#btn")


@pytest.mark.asyncio
async def test_hard_block_full_electronic_invoice_upload():
    page = FakePage(texts={"#btn": "全电发票上传"})
    safe = SafePage(page)
    with pytest.raises(RedlineViolation, match="HARD_BLOCK"):
        await safe.click("#btn")


@pytest.mark.asyncio
async def test_hard_block_srm_upload_button():
    """新时达 SRM 实战：Invoice Details tab 里 Upload 按钮文本就是 'Upload'，
    上下文判断不可靠，必须 HARD_BLOCK 兜底。"""
    page = FakePage(texts={"#srm_upload": "Upload"})
    safe = SafePage(page)
    with pytest.raises(RedlineViolation, match="HARD_BLOCK"):
        await safe.click("#srm_upload")


# ---- DANGER_VERBS + 发票上下文 → 拦 ----

@pytest.mark.asyncio
async def test_ctx_block_submit_in_invoice_dialog():
    page = FakePage(texts={"#btn": "提交"}, context="发票管理 | 创建发票", title="发票上传")
    safe = SafePage(page)
    with pytest.raises(RedlineViolation, match="CTX_BLOCK"):
        await safe.click("#btn")


@pytest.mark.asyncio
async def test_ctx_block_save_in_bill_panel():
    page = FakePage(texts={"#btn": "保存"}, context="单据维护 | 当前单据：1S310")
    safe = SafePage(page)
    with pytest.raises(RedlineViolation, match="CTX_BLOCK"):
        await safe.click("#btn")


# ---- DANGER_VERBS 但非发票上下文 → 放行 + warn ----

@pytest.mark.asyncio
async def test_submit_outside_invoice_context_passes():
    """高级搜索的「提交」按钮：上下文不含发票/单据 → 放行"""
    page = FakePage(texts={"#search": "提交"}, context="查询条件 | 高级筛选", title="首页")
    safe = SafePage(page)
    await safe.click("#search")
    assert page.clicked is True


@pytest.mark.asyncio
async def test_login_passes():
    """登录按钮：文本「登录」不在禁词，应放行"""
    page = FakePage(texts={"#login": "登录"})
    safe = SafePage(page)
    await safe.click("#login")
    assert page.clicked is True


# ---- 白名单 ----

@pytest.mark.asyncio
async def test_allow_list_cannot_bypass_hard_block():
    """普通白名单不能绕过 HARD_BLOCK，最终提交必须走 commit_click。"""
    page = FakePage(texts={"#tricky_btn": "上传发票"})
    safe = SafePage(page, allow=["#tricky_btn"])
    with pytest.raises(RedlineViolation, match="HARD_BLOCK"):
        await safe.click("#tricky_btn")


@pytest.mark.asyncio
async def test_commit_click_requires_exact_reference():
    page = FakePage(texts={"#confirm": "确认"})
    safe = SafePage(page, commit_reference="1C310-2607140024")
    with pytest.raises(RedlineViolation, match="COMMIT_GATE"):
        await safe.commit_click("#confirm", "1C310-OTHER")


@pytest.mark.asyncio
async def test_commit_click_with_exact_reference_passes():
    page = FakePage(texts={"#confirm": "确认"})
    safe = SafePage(page, commit_reference="1C310-2607140024")
    await safe.commit_click("#confirm", "1C310-2607140024")
    assert page.clicked is True


# ---- 非点击操作（fill/check/set_input_files）不走红线但留证 ----

@pytest.mark.asyncio
async def test_fill_does_not_trigger_redline():
    page = FakePage(texts={})
    safe = SafePage(page)
    await safe.fill("#invoice_no_input", "20260513V18004800001")
    assert ("#invoice_no_input", "20260513V18004800001") in page.filled


@pytest.mark.asyncio
async def test_password_fill_is_redacted_from_audit():
    class FakeAudit:
        def __init__(self):
            self.payload = None

        async def record(self, **payload):
            self.payload = payload

    page = FakePage(texts={})
    audit = FakeAudit()
    safe = SafePage(page, audit=audit)
    await safe.fill("input[name='password']", "top-secret")

    assert audit.payload["value"] == "<redacted>"
    assert page.filled == [("input[name='password']", "top-secret")]


# ---- assert_not_submitted ----

@pytest.mark.asyncio
async def test_post_check_url_submitted():
    from core.safety import assert_not_submitted

    class P:
        url = "http://srm.stepelectric.com/invoice/success"

        async def inner_text(self, sel, timeout=None):
            return ""

    with pytest.raises(RedlineViolation, match="POST_CHECK"):
        await assert_not_submitted(P())


@pytest.mark.asyncio
async def test_post_check_body_submitted():
    from core.safety import assert_not_submitted

    class P:
        url = "http://srm.stepelectric.com/invoice/edit"

        async def inner_text(self, sel, timeout=None):
            return "操作完成，提交成功"

    with pytest.raises(RedlineViolation, match="POST_CHECK"):
        await assert_not_submitted(P())


@pytest.mark.asyncio
async def test_post_check_clean_page_passes():
    from core.safety import assert_not_submitted

    class P:
        url = "http://srm.stepelectric.com/invoice/edit"

        async def inner_text(self, sel, timeout=None):
            return "请核对发票信息"

    await assert_not_submitted(P())  # 不该抛

#!/usr/bin/env python3
"""开开品牌图标批量生成脚本。

从两张源图批量生成 web + mobile 全套图标资产：
  - kaikai-main.png  开开主形象（1086x1448 透明底全身立绘）
  - kaikai-mark.png  鹿头简化 mark（透明底，用于 favicon 16 与 Android monochrome）

用法（本机 venv 需有 Pillow）：
  python3 scripts/brand-icons/generate.py

产物直接写入 web/public/ 与 mobile/assets/，覆盖旧文件。
构图规则（2026-07-14 曾磊拍板 v2 · 参考 codebuddy 圆形 favicon）：
  - web favicon 32 / apple-touch / PWA any-purpose 48~512：品牌蓝底 #2E56E1「圆形」+ 开开头部特写
    圆内构图=底边贴圆底、顶部留白让鹿角完整
  - web favicon 16：仍用鹿头 mark（3D 渲染 16px 不可辨）
  - PWA maskable / Android adaptive foreground：方形安全区，launcher 自裁圆/圆角
  - mobile icon（iOS）：品牌蓝底方形（iOS 自动加圆角遮罩）
  - Agent 默认头像 / 8 岗位预设：圆形安全区（前端 CSS rounded-full 圆裁）
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent.parent
SRC_MAIN = Path(__file__).parent / "kaikai-main.png"
SRC_MARK = Path(__file__).parent / "kaikai-mark.png"
BRAND_BG = (46, 86, 225, 255)    # #2E56E1 品牌蓝 —— 圆形 favicon / app icon 主底色
LIGHT_BG = (234, 240, 254, 255)  # 浅蓝 —— 头像/adaptive background 保留

WEB_PUBLIC = ROOT / "web" / "public"
MOBILE_ASSETS = ROOT / "mobile" / "assets"
PWA_SIZES = [16, 32, 48, 64, 72, 96, 128, 144, 152, 167, 180, 192, 384, 512]


def head_crop(src: Image.Image) -> Image.Image:
    """主图顶部 1086x1086 方形 = 头部+围巾特写，原生分辨率 ≥1024 零上采样。"""
    return src.crop((0, 0, 1086, 1086))


def circle_disc(size: int, bg=BRAND_BG) -> Image.Image:
    """整圆填色底（用作圆形 icon 的底盘）。"""
    disc = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, size, size], fill=255)
    fill = Image.new("RGBA", (size, size), bg)
    disc.paste(fill, (0, 0), mask)
    return disc


def circle_icon(head: Image.Image, size: int, bg=BRAND_BG, scale: float = 0.90) -> Image.Image:
    """圆形填色底 + 开开头部底边贴圆底。超出圆外的部分用 mask 裁掉，边缘干净。"""
    disc = circle_disc(size, bg)
    s = int(size * scale)
    m = head.resize((s, s), Image.LANCZOS)
    disc.paste(m, ((size - s) // 2, size - s + int(size * 0.02)), m)
    # 用同 mask 再裁一次超出圆外的开开（底边贴圆时可能溢出）
    circ_mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(circ_mask).ellipse([0, 0, size, size], fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(disc, (0, 0), circ_mask)
    return out


def square_icon(head: Image.Image, size: int, bg=BRAND_BG, scale: float = 0.90) -> Image.Image:
    """方形填色底 + 开开头部底边贴底（iOS app icon / apple-touch 用；系统自加圆角遮罩）。"""
    canvas = Image.new("RGBA", (size, size), bg)
    s = int(size * scale)
    m = head.resize((s, s), Image.LANCZOS)
    canvas.paste(m, ((size - s) // 2, size - s + int(size * 0.02)), m)
    return canvas


def centered_icon(head: Image.Image, size: int, ratio: float, bg=LIGHT_BG, y_shift: float = 0.03) -> Image.Image:
    """居中安全区构图：maskable / avatar / adaptive foreground 用。"""
    canvas = Image.new("RGBA", (size, size), bg)
    s = int(size * ratio)
    m = head.resize((s, s), Image.LANCZOS)
    canvas.paste(m, ((size - s) // 2, (size - s) // 2 + int(size * y_shift)), m)
    return canvas


def main() -> None:
    src = Image.open(SRC_MAIN).convert("RGBA")
    mark = Image.open(SRC_MARK).convert("RGBA")
    head = head_crop(src)

    # web favicon：16 保留透明底 mark，32 与 ico 换圆形品牌蓝
    mark.resize((16, 16), Image.LANCZOS).save(WEB_PUBLIC / "favicon-16x16.png")
    circle_icon(head, 32).save(WEB_PUBLIC / "favicon-32x32.png")
    # ico 塞三档：16 用 mark，32/48 用圆形（Windows 有 48 场景）
    ico_16 = mark.resize((16, 16), Image.LANCZOS)
    ico_32 = circle_icon(head, 32)
    ico_48 = circle_icon(head, 48)
    ico_48.save(WEB_PUBLIC / "favicon.ico", format="ICO",
                append_images=[ico_16, ico_32], sizes=[(16, 16), (32, 32), (48, 48)])

    # web PWA any-purpose icons：16 用 mark，32+ 用圆形品牌蓝
    for s in PWA_SIZES:
        if s == 16:
            mark.resize((s, s), Image.LANCZOS).save(WEB_PUBLIC / "icons" / f"icon-{s}x{s}.png")
        else:
            circle_icon(head, s).save(WEB_PUBLIC / "icons" / f"icon-{s}x{s}.png")

    # PWA maskable：方形品牌蓝底安全区（launcher 自裁圆/圆角，不能预裁圆）
    for s in [192, 512]:
        centered_icon(head, s, 0.68, bg=BRAND_BG).convert("RGB").save(
            WEB_PUBLIC / "icons" / f"maskable-{s}x{s}.png"
        )

    # apple-touch：圆形品牌蓝（iOS 会在圆形外再加自己的圆角遮罩，视觉上就是圆）
    circle_icon(head, 180).save(WEB_PUBLIC / "apple-touch-icon.png")

    # 默认头像（web + mobile 同一张，前端 CSS 裁圆）
    avatar = centered_icon(head, 512, 0.86, bg=LIGHT_BG, y_shift=0.023).convert("RGB")
    avatar.save(WEB_PUBLIC / "kaikai-avatar.png")
    avatar.save(MOBILE_ASSETS / "kaikai-avatar.png")

    # mobile icon（iOS）：品牌蓝底方形（系统加圆角遮罩→圆角矩形）
    square_icon(head, 1024).convert("RGB").save(MOBILE_ASSETS / "icon.png")
    # Android adaptive：foreground 透明居中，background 品牌蓝，monochrome 用 mark 剪影
    centered_icon(head, 1024, 0.62, bg=(0, 0, 0, 0)).save(MOBILE_ASSETS / "android-icon-foreground.png")
    Image.new("RGB", (1024, 1024), BRAND_BG[:3]).save(MOBILE_ASSETS / "android-icon-background.png")
    mono = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    s = int(1024 * 0.62)
    mk = mark.resize((s, s), Image.LANCZOS)
    white = Image.new("RGBA", (s, s), (255, 255, 255, 255))
    mono.paste(white, ((1024 - s) // 2, (1024 - s) // 2), mk)
    mono.save(MOBILE_ASSETS / "android-icon-monochrome.png")
    # splash：开开全身透明底（背景色由 app.json splash.backgroundColor 控制）
    src.save(MOBILE_ASSETS / "splash-icon.png")

    print("done: web/public + mobile/assets 全套图标已重新生成（v2 品牌蓝圆形）")


if __name__ == "__main__":
    main()

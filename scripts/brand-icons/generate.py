#!/usr/bin/env python3
"""开开品牌图标批量生成脚本。

从两张源图批量生成 web + mobile 全套图标资产：
  - kaikai-main.png  开开主形象（1086x1448 透明底全身立绘）
  - kaikai-mark.png  鹿头简化 mark（透明底，用于 favicon 16/32 与 Android monochrome）

用法（本机 venv 需有 Pillow）：
  python3 scripts/brand-icons/generate.py

产物直接写入 web/public/ 与 mobile/assets/，覆盖旧文件。
构图规则（2026-07-14 曾磊拍板）：
  - app icon / 大尺寸 PWA icon：浅蓝底 #EAF0FE + 头部特写「饱满贴底」构图（脸大、底边贴边）
  - favicon 16/32：鹿头 mark（3D 渲染缩到 16px 不可辨，必须用简化 mark）
  - PWA maskable / 头像 / Android adaptive foreground：居中安全区构图（圆形裁切不能切脸）
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent.parent
SRC_MAIN = Path(__file__).parent / "kaikai-main.png"
SRC_MARK = Path(__file__).parent / "kaikai-mark.png"
LIGHT_BG = (234, 240, 254, 255)  # 浅蓝底

WEB_PUBLIC = ROOT / "web" / "public"
MOBILE_ASSETS = ROOT / "mobile" / "assets"
PWA_SIZES = [16, 32, 48, 64, 72, 96, 128, 144, 152, 167, 180, 192, 384, 512]


def head_crop(src: Image.Image) -> Image.Image:
    """主图顶部 1086x1086 方形 = 头部+围巾特写，原生分辨率 ≥1024 零上采样。"""
    return src.crop((0, 0, 1086, 1086))


def full_icon(head: Image.Image, size: int) -> Image.Image:
    """饱满贴底构图：图形 93.75%，底边贴画布底边。"""
    canvas = Image.new("RGBA", (size, size), LIGHT_BG)
    s = int(size * 0.9375)
    m = head.resize((s, s), Image.LANCZOS)
    canvas.paste(m, ((size - s) // 2, size - s), m)
    return canvas


def centered_icon(head: Image.Image, size: int, ratio: float, bg=LIGHT_BG, y_shift=0.03) -> Image.Image:
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

    # web: favicon（16/32 用 mark 透明底）
    for s, name in [(16, "favicon-16x16.png"), (32, "favicon-32x32.png")]:
        mark.resize((s, s), Image.LANCZOS).save(WEB_PUBLIC / name)
    mark.resize((48, 48), Image.LANCZOS).save(
        WEB_PUBLIC / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)]
    )
    # web: PWA icons（16/32 mark，48+ 饱满 icon）
    for s in PWA_SIZES:
        if s <= 32:
            mark.resize((s, s), Image.LANCZOS).save(WEB_PUBLIC / "icons" / f"icon-{s}x{s}.png")
        else:
            full_icon(head, s).convert("RGB").save(WEB_PUBLIC / "icons" / f"icon-{s}x{s}.png")
    for s in [192, 512]:
        centered_icon(head, s, 0.68).convert("RGB").save(WEB_PUBLIC / "icons" / f"maskable-{s}x{s}.png")
    full_icon(head, 180).convert("RGB").save(WEB_PUBLIC / "apple-touch-icon.png")
    # 默认头像（web + mobile 同一张）
    avatar = centered_icon(head, 512, 0.86, y_shift=0.023).convert("RGB")
    avatar.save(WEB_PUBLIC / "kaikai-avatar.png")
    avatar.save(MOBILE_ASSETS / "kaikai-avatar.png")

    # mobile
    full_icon(head, 1024).convert("RGB").save(MOBILE_ASSETS / "icon.png")
    centered_icon(head, 1024, 0.62, bg=(0, 0, 0, 0)).save(MOBILE_ASSETS / "android-icon-foreground.png")
    Image.new("RGB", (1024, 1024), LIGHT_BG[:3]).save(MOBILE_ASSETS / "android-icon-background.png")
    # monochrome：mark 剪影（白色 + alpha，launcher 自行着色）
    mono = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    s = int(1024 * 0.62)
    mk = mark.resize((s, s), Image.LANCZOS)
    white = Image.new("RGBA", (s, s), (255, 255, 255, 255))
    mono.paste(white, ((1024 - s) // 2, (1024 - s) // 2), mk)
    mono.save(MOBILE_ASSETS / "android-icon-monochrome.png")
    # splash：开开全身透明底（背景色由 app.json splash.backgroundColor 控制）
    src.save(MOBILE_ASSETS / "splash-icon.png")

    print("done: web/public + mobile/assets 全套图标已重新生成")


if __name__ == "__main__":
    main()

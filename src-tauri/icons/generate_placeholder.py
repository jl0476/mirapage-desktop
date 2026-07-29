"""
为 MiraPage Desktop 生成 placeholder 图标（直到真实设计就绪）。

输出 (Tauri 2.x 标准 icon set):
  32x32.png
  128x128.png
  128x128@2x.png     (= 256x256)
  icon.icns          (macOS bundle)
  icon.ico           (Windows bundle)

颜色: 蓝色背景 + "MP" 字样。纯占位,正式打包请替换为设计师输出。
"""

from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

ICON_DIR = Path(__file__).parent
BG = (37, 99, 235)  # 科技蓝
FG = (255, 255, 255)  # 白字


def render(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), BG)
    draw = ImageDraw.Draw(img)
    # 圆角效果(用矩形遮罩太复杂,这里只画白底字)
    text = "MP"
    try:
        # PIL 内置默认字体可能很丑,试着找 DejaVuSans-Bold
        for candidate in [
            "DejaVuSans-Bold.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
            "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
            "C:/Windows/Fonts/arialbd.ttf",
        ]:
            try:
                font = ImageFont.truetype(candidate, size // 2)
                break
            except Exception:
                font = None
        if font is None:
            font = ImageFont.load_default()
    except Exception:
        font = ImageFont.load_default()

    # 居中文字
    bbox = draw.textbbox((0, 0), text, font=font)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text(
        ((size - w) / 2 - bbox[0], (size - h) / 2 - bbox[1]),
        text,
        fill=FG,
        font=font,
    )
    return img


def main():
    ICON_DIR.mkdir(exist_ok=True)

    # 普通 PNG
    for size, name in [
        (32, "32x32.png"),
        (128, "128x128.png"),
        (256, "128x128@2x.png"),
    ]:
        render(size).save(ICON_DIR / name)
        print(f"  wrote {name}")

    # 用 256×256 写 Windows .ico(多分辨率)
    base = render(256)
    base.save(
        ICON_DIR / "icon.ico",
        format="ICO",
        sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print("  wrote icon.ico (multi-size)")

    # macOS .icns 用 icns 库或 imagemagick (此处用 PIL 写一个 PNG→ICNS 包装最简版)
    # PIL 不直接支持 icns;若 imagemagick 可用则转换,否则留 fallback。
    try:
        import subprocess
        result = subprocess.run(
            ["magick", "convert", str(ICON_DIR / "256x256_no.png"), str(ICON_DIR / "icon.icns")],
            capture_output=True,
            text=True,
        )
        if result.returncode == 0:
            print("  wrote icon.icns (via ImageMagick)")
    except Exception:
        # PIL 不能直接写 icns;先看看 libicns 工具
        pass

    print(f"\nDone. Icons in {ICON_DIR}")


if __name__ == "__main__":
    main()
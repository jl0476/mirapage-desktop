"""
为 MiraPage Desktop 生成 macOS icon.icns(纯 Python,无第三方依赖)。

ICNS 格式规范(Apple):
  magic   'icns' (4 bytes)
  length  u32 big-endian(整个文件大小)
  然后是多个 entry,每个:
    icon_type(4 bytes 文本,如 'ic08' 'ic09' 'icp4' 'icp5' 'ic07' 等)
    length  u32 big-endian(entry 大小,含 type + length 字段)
    data    (通常是 PNG)

支持的尺寸约定 icon_type:
  icp4 = 64x64
  icp5 = 32x32
  ic07 = 128x128
  ic08 = 256x256
  ic09 = 512x512
  ic10 = 1024x1024  (macOS Big Sur+ Retina)
"""

import struct
from io import BytesIO
from pathlib import Path
from PIL import Image

ICON_DIR = Path(__file__).parent


def render(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (37, 99, 235, 255))  # 蓝
    draw = ImageDraw = __import__("PIL.ImageDraw", fromlist=["ImageDraw"]).ImageDraw(img)
    text = "MP"
    try:
        for c in [
            "DejaVuSans-Bold.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
            "C:/Windows/Fonts/arialbd.ttf",
        ]:
            try:
                font = __import__("PIL.ImageFont", fromlist=["ImageFont"]).truetype(
                    c, size // 2
                )
                break
            except Exception:
                font = None
        if font is None:
            font = __import__("PIL.ImageFont", fromlist=["ImageFont"]).load_default()
    except Exception:
        font = None

    bbox = draw.textbbox((0, 0), text, font=font) if hasattr(draw, "textbbox") else (0, 0, len(text) * size // 3, size // 2)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text(
        ((size - w) / 2 - bbox[0], (size - h) / 2 - bbox[1]),
        text,
        fill=(255, 255, 255, 255),
        font=font,
    )
    return img


def png_bytes(size: int) -> bytes:
    buf = BytesIO()
    render(size).save(buf, format="PNG")
    return buf.getvalue()


def build_icns(path: Path) -> None:
    """生成 icon.icns,包含 32x32 / 64x64 / 128x128 / 256x256 / 512x512 / 1024x1024 六种大小"""
    entries = []  # (type_4bytes, png_data)
    type_map = [
        (32, b"icp5"),
        (64, b"icp4"),
        (128, b"ic07"),
        (256, b"ic08"),
        (512, b"ic09"),
        (1024, b"ic10"),
    ]
    for size, tag in type_map:
        entries.append((tag, png_bytes(size)))

    buf = BytesIO()
    buf.write(b"icns")  # magic
    # 首 8 bytes 之后才有 length,所以先拼接 data 再回头写 length
    payload = BytesIO()
    for tag, png_data in entries:
        # entry = 4 bytes tag + 4 bytes length + data
        payload.write(tag)
        payload.write(struct.pack(">I", 8 + len(png_data)))  # entry size
        payload.write(png_data)
    payload_bytes = payload.getvalue()
    buf.write(struct.pack(">I", 8 + len(payload_bytes)))  # 文件总长
    buf.write(payload_bytes)
    path.write_bytes(buf.getvalue())
    print(f"  wrote {path.name} ({len(buf.getvalue())} bytes)")


if __name__ == "__main__":
    ICON_DIR.mkdir(exist_ok=True)
    build_icns(ICON_DIR / "icon.icns")
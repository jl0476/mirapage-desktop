#!/usr/bin/env python3
"""py7zr 兼容性回归 fixture 生成器（2026-08-29）。

生成 2 个 py7zr 1.1.3 产物 fixture，是「py7zr header 加密兼容缺口」两条
修复路径的真实回归载体（详见 README「py7zr 兼容性回归 fixture」节）：

  - py7zr-plain.7z               无密码；header 压缩流固定 16 MiB dict
                                 （MAX_HEADER_DICT_BYTES 8→32 MiB 的回归载体）
  - py7zr-header-encrypted.7z    header+内容同加密（密码 test-pass-中文）；
                                 header 不解压缩（单 AES256SHA256 coder），
                                 声明 unpack 189 / 块填充密文 192——AES-CBC
                                 块填充截断路径的回归载体

与 generate.py / gen_declared_dict.py 不同，本脚本不经 Python 手写字节，
直接以 py7zr 库产出（库版本 1.1.3 见 README 生成环境记录，与 WinRAR/7-Zip CLI 同属文档化外部工具，不进 requirements.in；源文件 mtime 钉死）。

可复现性按 README「内容锁定」规范：py7zr-plain.7z 同库版本字节级可复现；
py7zr-header-encrypted.7z 因加密随机 salt/IV **构造上不可复现**——重生成输出
与清单不一致属预期，一律以已提交产物 + README SHA-256 清单为真值。

用法：
  python src-tauri/tests/fixtures/archive/gen_py7zr.py --verify
"""

from __future__ import annotations

import argparse
import hashlib
import os
import struct
import sys
import tempfile
import zlib

try:
    import py7zr
except ImportError:  # pragma: no cover
    sys.exit("py7zr is required: pip install py7zr==1.1.3")

PASSWORD = "test-pass-中文"


def png(r: int, g: int, b: int) -> bytes:
    """最小合法 PNG（1x1 RGB），确定性生成。"""

    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return (
            struct.pack(">I", len(data))
            + body
            + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    raw = b"\x00" + bytes([r, g, b])
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


def build(out_dir: str) -> dict[str, bytes]:
    results: dict[str, bytes] = {}
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "src")
        os.makedirs(src)
        with open(os.path.join(src, "page1.png"), "wb") as f:
            f.write(png(255, 0, 0))
        with open(os.path.join(src, "page2.png"), "wb") as f:
            f.write(png(0, 0, 255))
        # 固定 mtime：py7zr 存源文件时间戳，钉死后同库版本字节级可复现
        stamp = 1234567890
        os.utime(os.path.join(src, "page1.png"), (stamp, stamp))
        os.utime(os.path.join(src, "page2.png"), (stamp, stamp))
        os.utime(src, (stamp, stamp))

        # 1) 明文：header 压缩流 16 MiB dict（py7zr 固定，filters 只控数据流）
        p = os.path.join(tmp, "py7zr-plain.7z")
        with py7zr.SevenZipFile(p, "w") as z:
            z.writeall(src, "src")
        results["py7zr-plain.7z"] = open(p, "rb").read()

        # 2) header+内容同加密：set_encrypted_header(True) 时 py7zr 不压缩 header，
        #    单 AES256SHA256 coder，块对齐填充使密文 > 声明 unpack size
        p = os.path.join(tmp, "py7zr-header-encrypted.7z")
        with py7zr.SevenZipFile(p, "w", password=PASSWORD) as z:
            z.set_encrypted_header(True)
            z.writeall(src, "src")
        results["py7zr-header-encrypted.7z"] = open(p, "rb").read()
    return results


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--verify", action="store_true", help="仅校验已提交产物 SHA-256")
    args = ap.parse_args()

    fixtures_dir = os.path.dirname(os.path.abspath(__file__))
    names = ["py7zr-plain.7z", "py7zr-header-encrypted.7z"]
    if args.verify:
        # --verify 只打印已提交产物哈希（与 README 清单比对）；
        # 不做重生成比对——header 加密变体随机 salt/IV 构造上不可复现
        for name in names:
            path = os.path.join(fixtures_dir, name)
            with open(path, "rb") as fh:
                print(f"{name}  {hashlib.sha256(fh.read()).hexdigest()}")
        return

    for name, data in build(fixtures_dir).items():
        with open(os.path.join(fixtures_dir, name), "wb") as f:
            f.write(data)
        print(f"{name}  {hashlib.sha256(data).hexdigest()}")


if __name__ == "__main__":
    main()

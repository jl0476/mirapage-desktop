#!/usr/bin/env python3
"""mirapage-desktop 归档读取器测试 fixture：确定性输入 + ZIP 族产物生成与校验。

职责（与 gen_declared_dict.py 分工）：
  - 生成确定性输入：page1.png / page2.png / note.txt / padding.bin / a/note.txt / b/page.png
    （全部输入由本脚本生成，不含第三方版权内容；写入时统一固定 mtime，见 FIXED_EPOCH）。
  - 生成 password-ae1.zip / password-ae2.zip（pyzipper，AES-256，强制 WZ_AES version 1/2）、
    password-zipcrypto.zip（调用已安装的 7-Zip 24.09）、multidisk.zip（手写最小 EOCD/ZIP64
    disk 字段非零结构，不包含相邻分盘文件）。
  - 解析 local/central AES extra field（0x9901），断言 vendor version 分别为 1/2、
    AE-2 CRC 为 0、AE-1 CRC 为真实 CRC32。
  - --verify：校验本脚本产物 + README 固定 WinRAR 7.11 命令生成的 9 个 RAR 产物
    （存在性 / 格式签名 / 条目清单 / 逐字节内容 / 加密 header 行为）。
    multipart 附属卷（part2 起）在 --verify 运行期存在供完整校验，校验后按 README 流程
    删除、不入仓；附属卷缺失时退化为 part1 header 判定并打印降级提示。

可复现承诺为「内容锁定」：SHA-256 清单（README）为真值，不承诺跨机器字节级再生成。
重生成输出与清单不一致时丢弃重生成物，以已提交产物为准。

用法：
  python generate.py            # 生成 .work/ 输入 + ZIP 族产物，并提示 RAR 步骤
  python generate.py --verify   # 校验全部产物（RAR 需已按 README 生成）
  可选：--7z <7z.exe 路径>（默认 C:/Program Files/7-Zip/7z.exe）
        --rar <rar.exe 路径>（默认 C:/Program Files/WinRAR/rar.exe）
"""

from __future__ import annotations

import argparse
import shutil
import struct
import subprocess
import sys
import tempfile
import zipfile
import zlib
from pathlib import Path

try:  # Windows 控制台中文输出兜底
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
except Exception:
    pass

HERE = Path(__file__).resolve().parent
WORK = HERE / ".work"
PASSWORD = "test-pass-中文"
PASSWORD_B = PASSWORD.encode("utf-8")
FIXED_EPOCH = 1704067200  # 2024-01-01 00:00:00 UTC：所有输入统一 mtime，稳定归档头内时间
DEFAULT_7Z = r"C:\Program Files\7-Zip\7z.exe"
DEFAULT_RAR = r"C:\Program Files\WinRAR\rar.exe"

RAR4_SIG = b"Rar!\x1a\x07\x00"
RAR5_SIG = b"Rar!\x1a\x07\x01\x00"


class VerifyError(Exception):
    pass


def fail(msg: str) -> None:
    raise VerifyError(msg)


# ---------------------------------------------------------------------------
# 确定性输入
# ---------------------------------------------------------------------------

def png_chunk(ctype: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data)) + ctype + data
        + struct.pack(">I", zlib.crc32(ctype + data) & 0xFFFFFFFF)
    )


def deflate_stored(payload: bytes) -> bytes:
    """无压缩 zlib 流（stored deflate 块），纯 Python 确定性输出。

    不用 zlib.compress：其输出可能随 zlib 版本差异，违背内容锁定承诺。
    """
    out = bytearray(b"\x78\x01")  # zlib header: CMF/FLG，无字典、最低压缩级别
    pos = 0
    total = len(payload)
    while True:
        chunk = payload[pos : pos + 65535]
        pos += len(chunk)
        final = 1 if pos >= total else 0
        out.append(final)  # BFINAL + BTYPE=00（stored）
        out += struct.pack("<HH", len(chunk), len(chunk) ^ 0xFFFF)
        out += chunk
        if final:
            break
    out += struct.pack(">I", zlib.adler32(payload) & 0xFFFFFFFF)
    return bytes(out)


def make_png(index: int, width: int = 16, height: int = 24) -> bytes:
    """确定性小 PNG（RGB, 8bit）：像素由 (x, y, index) 算术派生。"""
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filter type 0
        for x in range(width):
            raw.append((x * 16 + y * 2 + index * 37) & 0xFF)
            raw.append((x * 3 + y * 11 + index * 5) & 0xFF)
            raw.append((x * 7 + y * 13 + index * 67) & 0xFF)
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    idat = deflate_stored(bytes(raw))
    return (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", ihdr)
        + png_chunk(b"IDAT", idat)
        + png_chunk(b"IEND", b"")
    )


def make_padding() -> bytes:
    """固定 4096 字节确定性 padding（multipart 强制分卷用）。"""
    return bytes((i * 7 + 13) & 0xFF for i in range(4096))


def make_note() -> bytes:
    return b"mirapage archive fixture note: deterministic input, do not edit.\n"


def write_input(rel: str, data: bytes) -> Path:
    path = WORK / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    import os

    os.utime(path, (FIXED_EPOCH, FIXED_EPOCH))
    return path


def generate_inputs() -> dict[str, bytes]:
    """生成 .work/ 全部确定性输入，返回 产物名 → 内容字节 的映射。"""
    inputs: dict[str, bytes] = {}
    for name, data in [
        ("page1.png", make_png(1)),
        ("page2.png", make_png(2)),
        ("note.txt", make_note()),
        ("padding.bin", make_padding()),
        ("a/note.txt", make_note()),
        ("b/page.png", make_png(1)),
    ]:
        write_input(name, data)
        inputs[name] = data
    return inputs


# ---------------------------------------------------------------------------
# AE-1 / AE-2
# ---------------------------------------------------------------------------

def build_aes_zip(product: Path, page1: bytes, wz_version: int) -> None:
    """pyzipper AES-256 zip；强制 WZ_AES version 1/2，不依赖库的自动选择。"""
    import pyzipper

    with pyzipper.AESZipFile(
        product,
        "w",
        compression=pyzipper.ZIP_DEFLATED,
        encryption=pyzipper.WZ_AES,
        encryption_kwargs={"nbits": 256, "force_wz_aes_version": wz_version},
    ) as zf:
        zf.setpassword(PASSWORD_B)
        # writestr 只认 self.zipinfo_cls（AESZipInfo）实例；用固定 date_time 保确定性
        info = pyzipper.AESZipFile.zipinfo_cls("page1.png", date_time=(2024, 1, 1, 0, 0, 0))
        zf.writestr(info, page1, compress_type=pyzipper.ZIP_DEFLATED)


def find_eocd(data: bytes) -> dict:
    end = data.rfind(b"PK\x05\x06")
    if end < 0:
        fail("multidisk/eocd: EOCD 签名未找到")
    (
        _sig, disk_no, cd_disk, entries_disk, entries_total,
        cd_size, cd_offset, comment_len,
    ) = struct.unpack_from("<IHHHHIIH", data, end)
    return {
        "offset": end, "disk_no": disk_no, "cd_disk": cd_disk,
        "entries_disk": entries_disk, "entries_total": entries_total,
        "cd_size": cd_size, "cd_offset": cd_offset, "comment_len": comment_len,
    }


def iter_central(data: bytes, eocd: dict):
    pos = eocd["cd_offset"]
    for _ in range(eocd["entries_total"]):
        if data[pos : pos + 4] != b"PK\x01\x02":
            fail("central: 签名不匹配")
        (
            _sig, _vmade, _vneed, flags, method, _t, _d, crc, csize, usize,
            nlen, xlen, clen, disk_start, _iattr, _eattr, lh_offset,
        ) = struct.unpack_from("<IHHHHHHIIIHHHHHII", data, pos)
        name = data[pos + 46 : pos + 46 + nlen]
        extra = data[pos + 46 + nlen : pos + 46 + nlen + xlen]
        yield {
            "name": name.decode("utf-8"), "flags": flags, "method": method,
            "crc": crc, "csize": csize, "usize": usize,
            "disk_start": disk_start, "lh_offset": lh_offset, "extra": extra,
        }
        pos += 46 + nlen + xlen + clen


def parse_aes_extra(extra: bytes) -> dict | None:
    """解析 0x9901 (WinZip AES) extra field，返回 local(7B)/central(11B) 字段。"""
    i = 0
    while i + 4 <= len(extra):
        hid, hsize = struct.unpack_from("<HH", extra, i)
        data = extra[i + 4 : i + 4 + hsize]
        if hid == 0x9901 and len(data) >= 7:
            version, = struct.unpack_from("<H", data, 0)
            out = {
                "vendor": data[2:4], "strength": data[4],
                "method": struct.unpack_from("<H", data, 5)[0],
                "crc": None,
            }
            if len(data) >= 11:
                out["crc"] = struct.unpack_from("<I", data, 7)[0]
            return {"version": version, **out}
        i += 4 + hsize
    return None


def verify_aes_zip(product: Path, page1: bytes, wz_version: int) -> dict:
    import pyzipper

    name = product.name
    if wz_version == 2:
        expect_crc = 0
    else:
        expect_crc = zlib.crc32(page1) & 0xFFFFFFFF

    # 1) local/central AES extra field 断言
    data = product.read_bytes()
    eocd = find_eocd(data)
    entries = list(iter_central(data, eocd))
    if len(entries) != 1 or entries[0]["name"] != "page1.png":
        fail(f"{name}: central 条目应为仅 page1.png，实际 {[e['name'] for e in entries]}")
    cent = parse_aes_extra(entries[0]["extra"])
    if cent is None:
        fail(f"{name}: central 缺少 0x9901 extra field")
    lh = entries[0]["lh_offset"]
    (
        _sig, _vn, lflags, lmethod, _t, _d, lcrc, lcsize, lusize,
        lnlen, lxlen,
    ) = struct.unpack_from("<IHHHHHIIIHH", data, lh)
    lextra = data[lh + 30 + lnlen : lh + 30 + lnlen + lxlen]
    loc = parse_aes_extra(lextra)
    if loc is None:
        fail(f"{name}: local 缺少 0x9901 extra field")
    for tag, rec in (("local", loc), ("central", cent)):
        if rec["version"] != wz_version:
            fail(
                f"{name}: {tag} vendor version 应为 {wz_version}，"
                f"实际 {rec['version']}"
            )
        if rec["vendor"] != b"AE":
            fail(f"{name}: {tag} vendor 应为 AE，实际 {rec['vendor']!r}")
        if rec["strength"] != 3:
            fail(f"{name}: {tag} strength 应为 3（AES-256），实际 {rec['strength']}")
        if rec["method"] != 8:
            fail(f"{name}: {tag} method 应为 8（deflate），实际 {rec['method']}")
    # pyzipper 0.4.0 的 0x9901 extra 在 local/central 均为 7 字节（无 CRC 尾）；
    # CRC 语义落在 central directory 主字段：AE-1 = 真实 CRC32，AE-2 = 0
    if entries[0]["crc"] != expect_crc:
        fail(
            f"{name}: central 主 CRC 字段应为 {expect_crc:#x}，"
            f"实际 {entries[0]['crc']:#x}"
        )

    # 2) 用密码解密回读，逐字节比对
    with pyzipper.AESZipFile(product) as zf:
        got = zf.read("page1.png", pwd=PASSWORD_B)
    if got != page1:
        fail(f"{name}: AES 解密回读与源 page1.png 不一致")
    return {
        "local_version": loc["version"], "central_version": cent["version"],
        "strength": cent["strength"], "central_crc": cent["crc"],
    }


# ---------------------------------------------------------------------------
# ZipCrypto（7-Zip 24.09 生成）
# ---------------------------------------------------------------------------

def check_7z_version(sevenz: str) -> str:
    proc = subprocess.run(
        [sevenz, "i"], capture_output=True,
        text=True, encoding="utf-8", errors="replace",
    )
    lines = [ln for ln in (proc.stdout or "").splitlines() if ln.strip()]
    first = lines[0] if lines else ""
    if proc.returncode != 0 or "7-Zip 24.09" not in (proc.stdout or ""):
        fail(f"7-Zip 版本应为 24.09，实际输出首行: {first!r}")
    return first


def _zipcrypto_crc_table() -> list[int]:
    table = []
    for i in range(256):
        c = i
        for _ in range(8):
            c = (c >> 1) ^ (0xEDB88320 if c & 1 else 0)
        table.append(c)
    return table


_ZC_TABLE = _zipcrypto_crc_table()


def _crc_reg(reg: int, c: int) -> int:
    """ZipCrypto 的原始 CRC 寄存器更新（非 zlib.crc32——后者寄存器带取反，不可直接用）。"""
    return (reg >> 8) ^ _ZC_TABLE[(reg ^ c) & 0xFF]


class ZipCrypto:
    """PKWARE traditional ZipCrypto（APPNOTE 6.1.x），纯 Python 实现。

    回退实现背景：7-Zip ≥ 4.43（含 24.09）对「创建 zip + 非 ASCII 密码」无条件返回
    E_INVALIDARG（源码 ZipHandlerOut.cpp: IsSimpleAsciiString(password) 检查，
    注释原文 "7-Zip >= 4.43 creates ZIP archives only with ASCII characters in
    password"），rar.exe 7.11 亦无 zip 写入开关。因此 ZipCrypto 产物由本实现生成，
    密码字节取 UTF-8（与 AE-1/AE-2 产物及上层应用 String::as_bytes() 语义一致）。
    正确性由两套独立实现交叉验证：本实现加密 + Python stdlib zipfile 解密回读。
    """

    def __init__(self, password: bytes):
        self.k0 = 0x12345678
        self.k1 = 0x23456789
        self.k2 = 0x34567890
        for b in password:
            self._update(b)

    def _update(self, c: int) -> None:
        self.k0 = _crc_reg(self.k0, c)
        self.k1 = ((self.k1 + (self.k0 & 0xFF)) * 134775813 + 1) & 0xFFFFFFFF
        self.k2 = _crc_reg(self.k2, (self.k1 >> 24) & 0xFF)

    def _crypt_byte(self) -> int:
        t = (self.k2 | 2) & 0xFFFF
        return ((t * (t ^ 1)) >> 8) & 0xFF

    def encrypt(self, data: bytes) -> bytes:
        """加密：密钥演化用明文字节（Info-ZIP zencode 宏语义，与 stdlib 解密互逆）。"""
        out = bytearray()
        for b in data:
            c = b ^ self._crypt_byte()
            self._update(b)
            out.append(c)
        return bytes(out)


def build_zipcrypto_python(product: Path, page1: bytes) -> None:
    """手工构造 stored + ZipCrypto zip（确定性：无压缩、固定时间戳与加密头填充）。"""
    name = b"page1.png"
    crc = zlib.crc32(page1) & 0xFFFFFFFF
    crypt = ZipCrypto(PASSWORD_B)
    # 12 字节加密头：11 字节确定性填充 + check byte（CRC 高 8 位；flags bit3=0 路径）
    header = bytes((i * 29 + 11) & 0xFF for i in range(11)) + bytes([(crc >> 24) & 0xFF])
    payload = crypt.encrypt(header + page1)
    lfh = struct.pack(
        "<IHHHHHIIIHH", 0x04034B50, 20, 0x1, 0, DOS_TIME, DOS_DATE,
        crc, len(payload), len(page1), len(name), 0,
    ) + name
    cde = struct.pack(
        "<IHHHHHHIIIHHHHHII", 0x02014B50, 20, 20, 0x1, 0, DOS_TIME, DOS_DATE,
        crc, len(payload), len(page1), len(name), 0, 0,
        0, 0, 0, 0,
    ) + name
    cd_offset = len(lfh) + len(payload)
    eocd = struct.pack(
        "<IHHHHIIH", 0x06054B50, 0, 0, 1, 1, len(cde), cd_offset, 0
    )
    product.write_bytes(lfh + payload + cde + eocd)


def build_zipcrypto(product: Path, sevenz: str) -> None:
    """先按任务简报的原命令调用 7-Zip 24.09；上游拒绝非 ASCII 密码时回退 Python 实现。"""
    proc = subprocess.run(
        [sevenz, "a", "-tzip", "-mem=ZipCrypto", f"-p{PASSWORD}",
         "password-zipcrypto.zip", "page1.png"],
        cwd=WORK, capture_output=True,
        text=True, encoding="utf-8", errors="replace",
    )
    if proc.returncode == 0:
        shutil.move(str(WORK / "password-zipcrypto.zip"), product)
        print(
            "  [7z] ZipCrypto 由 7-Zip 24.09 生成（注意：其密码经 CP_OEMCP 转换）"
        )
        return
    detail = ((proc.stdout or "") + (proc.stderr or "")).strip().splitlines()
    print(
        "  [fallback] 7-Zip 24.09 拒绝创建非 ASCII 密码 zip（rc="
        f"{proc.returncode}, {detail[-1] if detail else ''!r}）——"
        "上游 ZipHandlerOut.cpp IsSimpleAsciiString 硬限制（≥4.43），"
        "回退纯 Python ZipCrypto（UTF-8 密码字节）"
    )
    build_zipcrypto_python(product, (WORK / "page1.png").read_bytes())


def verify_zipcrypto(product: Path, page1: bytes) -> dict:
    # ZipCrypto 密码在 zip 容器内按 UTF-8 字节派生密钥（7-Zip 对 zip 的处理）
    try:
        with zipfile.ZipFile(product) as zf:
            got = zf.read("page1.png", pwd=PASSWORD_B)
    except Exception as exc:  # noqa: BLE001
        fail(f"{name_err(product)}: ZipCrypto 解密失败（密码 {PASSWORD!r}）: {exc}")
    if got != page1:
        fail(f"{name_err(product)}: ZipCrypto 解密内容与源 page1.png 不一致")
    data = product.read_bytes()
    eocd = find_eocd(data)
    entries = list(iter_central(data, eocd))
    if len(entries) != 1 or entries[0]["name"] != "page1.png":
        fail(f"{name_err(product)}: 条目应为仅 page1.png")
    if entries[0]["flags"] & 0x1 == 0:
        fail(f"{name_err(product)}: central flag bit0（加密）未置位")
    return {"entries": [e["name"] for e in entries]}


def name_err(p: Path) -> str:
    return p.name


# ---------------------------------------------------------------------------
# multidisk.zip（手写最小 EOCD/ZIP64 disk 字段非零结构）
# ---------------------------------------------------------------------------

DOS_TIME = 0  # 00:00:00
DOS_DATE = (2024 - 1980) << 9 | 1 << 5 | 1  # 2024-01-01


def build_multidisk(product: Path, page1: bytes) -> None:
    name = b"page1.png"
    crc = zlib.crc32(page1) & 0xFFFFFFFF
    lfh = struct.pack(
        "<IHHHHHIIIHH", 0x04034B50, 20, 0, 0, DOS_TIME, DOS_DATE,
        crc, len(page1), len(page1), len(name), 0,
    ) + name
    cde = struct.pack(
        "<IHHHHHHIIIHHHHHII", 0x02014B50, 20, 20, 0, 0, DOS_TIME, DOS_DATE,
        crc, len(page1), len(page1), len(name), 0, 0,
        1, 0, 0, 0,  # disk_start=1（本条目位于 1 号盘）
    ) + name
    cd_offset = len(lfh) + len(page1)
    z64_eocd = struct.pack(
        "<IQHHIIQQQQ", 0x06064B50, 44, 45, 45,
        1, 1, 1, 1, len(cde), cd_offset,  # 本盘=1、CD 盘=1
    )
    z64_locator = struct.pack(
        "<IIQI", 0x07064B50, 1, cd_offset + len(cde), 2,  # zip64 盘=1、总盘数=2
    )
    eocd = struct.pack(
        "<IHHHHIIH", 0x06054B50, 1, 1, 1, 1, len(cde), cd_offset, 0,
    )
    product.write_bytes(lfh + page1 + cde + z64_eocd + z64_locator + eocd)


def verify_multidisk(product: Path, page1: bytes) -> dict:
    data = product.read_bytes()
    eocd = find_eocd(data)
    if eocd["disk_no"] == 0 or eocd["cd_disk"] == 0:
        fail("multidisk.zip: EOCD 盘字段应为非零")
    # ZIP64 locator / record 盘字段非零
    loc = data.rfind(b"PK\x06\x07")
    if loc < 0:
        fail("multidisk.zip: 缺少 ZIP64 EOCD locator")
    _sig, z64_disk, _off, total_disks = struct.unpack_from("<IIQI", data, loc)
    if z64_disk == 0 or total_disks < 2:
        fail("multidisk.zip: ZIP64 locator 盘字段应为非零/总盘数 ≥ 2")
    rec = data.rfind(b"PK\x06\x06")
    if rec < 0:
        fail("multidisk.zip: 缺少 ZIP64 EOCD record")
    (
        _s, _sz, _vm, _vn, rec_disk, rec_cd_disk, edisk, etotal,
        _cdsz, _cdoff,
    ) = struct.unpack_from("<IQHHIIQQQQ", data, rec)
    if rec_disk == 0 or rec_cd_disk == 0 or edisk == 0:
        fail("multidisk.zip: ZIP64 record 盘字段应为非零")
    # 存储条目人工回读（zipfile 对跨盘 zip 一律拒绝——这正是本 fixture 的语义）：
    # 定位 local header，校验 method=0 后直接读取存储字节
    lh_off = 0
    (
        _sig, _vn2, _fl, method, _t, _d, lcrc, lcsize, lusize,
        lnlen2, _lxlen,
    ) = struct.unpack_from("<IHHHHHIIIHH", data, lh_off)
    if method != 0 or lcsize != lusize:
        fail("multidisk.zip: 条目应为 stored（method=0，csize==usize）")
    got = data[lh_off + 30 + lnlen2 : lh_off + 30 + lnlen2 + lusize]
    if got != page1:
        fail("multidisk.zip: 存储条目内容与源 page1.png 不一致")
    # 不包含相邻分盘文件（目录内无 .z01/.002 等）
    siblings = [p.name for p in product.parent.glob("*.z[0-9][0-9]")]
    if siblings:
        fail(f"multidisk.zip: 目录内不应存在分盘文件，发现 {siblings}")
    return {
        "eocd_disk": eocd["disk_no"], "zip64_disk": z64_disk,
        "total_disks": total_disks,
    }


# ---------------------------------------------------------------------------
# RAR 产物校验（产物本身由 README 固定的 WinRAR 7.11 命令生成）
# ---------------------------------------------------------------------------

def check_rar_version(rar: str) -> str:
    proc = subprocess.run(
        [rar], capture_output=True, text=True, encoding="utf-8", errors="replace",
        stdin=subprocess.DEVNULL,
    )
    for line in ((proc.stdout or "") + (proc.stderr or "")).splitlines():
        if "RAR 7.11" in line:
            return line.strip()
    fail(f"rar.exe 版本应为 7.11，实际输出: {((proc.stdout or '') + (proc.stderr or ''))[:120]!r}")


def rar_run(rar: str, args: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        [rar, *args], cwd=cwd, capture_output=True,
        text=True, encoding="utf-8", errors="replace",
        stdin=subprocess.DEVNULL,  # 防止加密 header 无密码列目录时交互式索要密码挂死
    )


def verify_rar_product(
    rar: str, spec: dict, inputs: dict[str, bytes]
) -> dict:
    product = HERE / spec["name"]
    if not product.exists():
        fail(f"{spec['name']}: 产物不存在（README 记录的 WinRAR 命令是否已执行？）")
    data = product.read_bytes()
    if not data.startswith(spec["sig"]):
        fail(f"{spec['name']}: 签名应为 {spec['sig']!r}")
    pw_args = [f"-p{PASSWORD}"] if spec["password"] else []

    result: dict = {"name": spec["name"], "kind": spec.get("kind", "normal")}

    if spec.get("kind") == "empty":
        proc = rar_run(rar, ["lb", spec["name"]], cwd=HERE)
        entries = [ln for ln in (proc.stdout or "").splitlines() if ln.strip()]
        if proc.returncode != 0 or entries:
            fail(f"{spec['name']}: 应为零条目，实际 {entries}")
        result["entries"] = []
        return result

    if spec.get("kind") == "encrypted-headers":
        # 无密码列目录必须失败（-hp 同时加密文件头与数据）
        nopwd = rar_run(rar, ["lb", spec["name"]], cwd=HERE)
        if nopwd.returncode == 0:
            fail(f"{spec['name']}: 无密码列目录应失败（header 加密缺失？）")
        result["header_encrypted"] = True

    if spec.get("kind") == "multipart":
        volumes = sorted(
            p.name for p in HERE.glob("multipart.part*.rar")
            if p.name != "multipart.part1.rar"
        )
        if volumes:
            # 完整校验：part1 起全卷解压
            pass
        else:
            # 降级：仅校验 part1 RAR5 签名 + 主头 archive flags 的 MHFL_VOLUME(bit0)。
            # 注意 bit 语义：header flags vint 的 bit0=HFL_EXTRA / bit1=HFL_DATA，
            # 分卷标志在其后的 archive flags vint（需按 extra-size/data-size 跳过后读）。
            head = data[:64]
            if not head.startswith(RAR5_SIG):
                fail(f"{spec['name']}: 分卷降级校验需 RAR5 签名")
            pos = 8 + 4  # 签名(8) + header CRC(4)
            hsize, pos = rar5_vint(head, pos)
            htype, pos = rar5_vint(head, pos)
            hflags, pos = rar5_vint(head, pos)
            if htype != 1:
                fail(f"{spec['name']}: 主头类型应为 1，实际 {htype}")
            if hflags & 0x0001:  # HFL_EXTRA：跳过 extra area size
                _, pos = rar5_vint(head, pos)
            if hflags & 0x0002:  # HFL_DATA：跳过 data size
                _, pos = rar5_vint(head, pos)
            archive_flags, pos = rar5_vint(head, pos)
            if not archive_flags & 0x0001:  # MHFL_VOLUME
                fail(
                    f"{spec['name']}: 主头 archive flags 缺少 MHFL_VOLUME 分卷标志"
                    f"（archive_flags={archive_flags:#x}）"
                )
            result["degraded"] = True
            result["volumes_present"] = []
            print(
                f"  [降级] {spec['name']}: 附属卷已删除，"
                f"仅校验 part1 archive flags MHFL_VOLUME（={archive_flags:#x}）"
            )
            return result

    # 条目清单（multipart：lb 只列出 part1 头内条目，padding.bin 头在后续卷）
    proc = rar_run(rar, ["lb", *pw_args, spec["name"]], cwd=HERE)
    if proc.returncode != 0:
        fail(
            f"{spec['name']}: 列目录失败 rc={proc.returncode}: "
            f"{(proc.stdout or '') + (proc.stderr or '')}"
        )
    listed = [ln.replace("\\", "/") for ln in (proc.stdout or "").splitlines() if ln.strip()]
    expect_names = sorted(spec.get("list_entries", spec["entries"]))
    if sorted(listed) != expect_names:
        fail(f"{spec['name']}: 条目应为 {expect_names}，实际 {sorted(listed)}")
    result["entries"] = listed

    # 逐字节内容
    with tempfile.TemporaryDirectory(dir=WORK) as tmp:
        tmp_path = Path(tmp)
        target_name = spec.get("extract_as") or spec["name"]
        proc = rar_run(
            rar,
            ["x", "-y", "-idq", *pw_args, target_name, str(tmp_path) + "/"],
            cwd=HERE,
        )
        if proc.returncode != 0:
            fail(
                f"{spec['name']}: 解压失败 rc={proc.returncode}: "
                f"{(proc.stdout or '') + (proc.stderr or '')}"
            )
        for entry, source in spec["entries"].items():
            got = (tmp_path / entry).read_bytes()
            if got != inputs[source]:
                fail(f"{spec['name']}: 条目 {entry} 内容与源 {source} 不一致")
    result["volumes_present"] = sorted(
        p.name for p in HERE.glob("multipart.part*.rar")
        if p.name != "multipart.part1.rar"
    ) if spec.get("kind") == "multipart" else []
    return result


def rar5_vint(data: bytes, pos: int) -> tuple[int, int]:
    value = 0
    shift = 0
    while pos < len(data):
        b = data[pos]
        pos += 1
        value |= (b & 0x7F) << shift
        shift += 7
        if not b & 0x80:
            return value, pos
    fail("rar5 vint: 数据不足")


def build_empty_rar5(rar: str) -> Path:
    """构造零条目 RAR5 归档（EmptyArchive 合同载体）。

    rar.exe 7.x 在删除最后一个文件时会顺带删除整个归档（实测输出
    "Erasing empty archive"），简报的「先加后删」流程无法留下产物。
    替代：用 rar 生成含 note.txt 的最小归档，按 RAR5 header 边界截取
    真实 MAIN 头 + ENDARC 头拼接（头字节均来自 rar 本体，无手工伪造）。
    """
    if WORK.exists() is False:
        WORK.mkdir(parents=True)
    inputs = generate_inputs()
    with tempfile.TemporaryDirectory(dir=WORK) as tmp:
        tmp_path = Path(tmp)
        shutil.copy(WORK / "note.txt", tmp_path / "note.txt")
        proc = rar_run(rar, ["a", "-idq", "-ma5", "probe.rar", "note.txt"], cwd=tmp_path)
        if proc.returncode != 0:
            fail(f"empty-rar5: 临时归档生成失败 rc={proc.returncode}")
        data = (tmp_path / "probe.rar").read_bytes()
    pos = 8  # 跳过 8 字节 RAR5 签名
    headers: list[tuple[int, int, int]] = []  # (type, start, next)
    while pos < len(data):
        start = pos
        hsize, p = rar5_vint(data, pos + 4)
        body_start = p  # header 本体（type..extra 区）从这里开始
        htype, p = rar5_vint(data, p)
        hflags, p = rar5_vint(data, p)
        if hflags & 0x0001:
            _, p = rar5_vint(data, p)
        data_size = 0
        if hflags & 0x0002:
            data_size, p = rar5_vint(data, p)
        nxt = body_start + hsize + data_size
        headers.append((htype, start, nxt))
        pos = nxt
    if not headers or headers[0][0] != 1 or headers[-1][0] != 5:
        fail("empty-rar5: 头结构不符合「MAIN 首位 / ENDARC 末位」预期")
    product = HERE / "empty-rar5.rar"
    product.write_bytes(data[: headers[0][2]] + data[headers[-1][1] : headers[-1][2]])
    # 自检：rar lb 必须零条目退出 0
    proc = rar_run(rar, ["lb", "empty-rar5.rar"], cwd=HERE)
    entries = [ln for ln in (proc.stdout or "").splitlines() if ln.strip()]
    if proc.returncode != 0 or entries:
        fail(f"empty-rar5: 自检失败 rc={proc.returncode} entries={entries}")
    print(f"  [splice] empty-rar5.rar = 真实 MAIN + ENDARC 头拼接（{product.stat().st_size} bytes，rar lb 零条目通过）")
    return product


RAR_PRODUCTS: list[dict] = [
    dict(name="plain-rar4.rar", sig=RAR4_SIG, password=None,
         entries={"page1.png": "page1.png", "page2.png": "page2.png"}),
    dict(name="password-rar4.rar", sig=RAR4_SIG, password=True,
         entries={"page1.png": "page1.png"}),
    dict(name="plain-rar5.rar", sig=RAR5_SIG, password=None,
         entries={"page1.png": "page1.png", "page2.png": "page2.png"}),
    dict(name="password-rar5.rar", sig=RAR5_SIG, password=True,
         entries={"page1.png": "page1.png"}),
    dict(name="encrypted-headers-rar5.rar", sig=RAR5_SIG, password=True,
         kind="encrypted-headers", entries={"page1.png": "page1.png"}),
    dict(name="password-nonimage-rar4.rar", sig=RAR4_SIG, password=True,
         entries={"note.txt": "note.txt"}),
    dict(name="empty-rar5.rar", sig=RAR5_SIG, password=None, kind="empty",
         entries={}),
    dict(name="mixed-dirs-rar5.rar", sig=RAR5_SIG, password=None,
         entries={"a/note.txt": "a/note.txt", "b/page.png": "b/page.png"}),
    dict(name="multipart.part1.rar", sig=RAR5_SIG, password=None,
         kind="multipart",
         # lb 视角只有 part1 头内的 page1.png；padding.bin 头在后续卷，仅全卷解压校验
         list_entries=["page1.png"],
         entries={"page1.png": "page1.png", "padding.bin": "padding.bin"}),
]


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

RAR_COMMANDS = """\
# 在 .work/ 目录（输入已就绪）按 README「RAR 生成命令」逐条执行 WinRAR 7.11 命令：
#   rar.exe a -idq -ma4 plain-rar4.rar page1.png page2.png
#   rar.exe a -idq -ma4 -ptest-pass-中文 password-rar4.rar page1.png
#   rar.exe a -idq -ma5 plain-rar5.rar page1.png page2.png
#   rar.exe a -idq -ma5 -ptest-pass-中文 password-rar5.rar page1.png
#   rar.exe a -idq -ma5 -hptest-pass-中文 encrypted-headers-rar5.rar page1.png
#   rar.exe a -idq -ma4 -ptest-pass-中文 password-nonimage-rar4.rar note.txt
#   rar.exe a -idq -ma5 empty-rar5.rar note.txt
#   rar.exe d -idq empty-rar5.rar note.txt
#   rar.exe a -idq -ma5 mixed-dirs-rar5.rar a\\note.txt b\\page.png
#   rar.exe a -idq -ma5 -m0 -v1k multipart.rar page1.png padding.bin
# 完成后把 9 个产物（multipart 全部卷）复制到本目录，再运行:
#   python generate.py --verify
"""


def cmd_generate(args: argparse.Namespace) -> None:
    if WORK.exists():
        shutil.rmtree(WORK)
    WORK.mkdir(parents=True)
    inputs = generate_inputs()
    print("输入已生成（确定性，mtime 固定 2024-01-01 UTC）:")
    for name, data in inputs.items():
        print(f"  .work/{name:<14} {len(data):>5} bytes")

    print()
    print(f"环境记录: python {'.'.join(map(str, sys.version_info[:3]))}")
    print(f"环境记录: 7z -> {check_7z_version(args.sevenz)}")
    build_aes_zip(HERE / "password-ae1.zip", inputs["page1.png"], 1)
    r1 = verify_aes_zip(HERE / "password-ae1.zip", inputs["page1.png"], 1)
    print(f"password-ae1.zip    生成+断言通过 {r1}")
    build_aes_zip(HERE / "password-ae2.zip", inputs["page1.png"], 2)
    r2 = verify_aes_zip(HERE / "password-ae2.zip", inputs["page1.png"], 2)
    print(f"password-ae2.zip    生成+断言通过 {r2}")
    build_zipcrypto(HERE / "password-zipcrypto.zip", args.sevenz)
    r3 = verify_zipcrypto(HERE / "password-zipcrypto.zip", inputs["page1.png"])
    print(f"password-zipcrypto.zip 生成+断言通过 {r3}")
    build_multidisk(HERE / "multidisk.zip", inputs["page1.png"])
    r4 = verify_multidisk(HERE / "multidisk.zip", inputs["page1.png"])
    print(f"multidisk.zip       生成+断言通过 {r4}")
    print()
    print("ZIP 族产物完成。RAR 9 个产物需手动执行 WinRAR 7.11 命令（脚本只生成输入）:")
    print(RAR_COMMANDS)


def cmd_verify(args: argparse.Namespace) -> None:
    if WORK.exists():
        shutil.rmtree(WORK)
    WORK.mkdir(parents=True)
    inputs = generate_inputs()

    print(f"环境记录: python {'.'.join(map(str, sys.version_info[:3]))}")
    print(f"环境记录: 7z -> {check_7z_version(args.sevenz)}")
    print(f"环境记录: rar -> {check_rar_version(args.rar)}")
    print()

    results: list[dict] = []
    results.append(verify_aes_zip(HERE / "password-ae1.zip", inputs["page1.png"], 1))
    results.append(verify_aes_zip(HERE / "password-ae2.zip", inputs["page1.png"], 2))
    results.append(verify_zipcrypto(HERE / "password-zipcrypto.zip", inputs["page1.png"]))
    results.append(verify_multidisk(HERE / "multidisk.zip", inputs["page1.png"]))
    for r in results:
        print(f"  [ok] {r}")

    print()
    for spec in RAR_PRODUCTS:
        r = verify_rar_product(args.rar, spec, inputs)
        if r.get("kind") == "empty":
            print(f"  [ok] {r['name']}: 零条目")
        elif r.get("kind") == "encrypted-headers":
            print(f"  [ok] {r['name']}: header 加密 + {r['entries']}")
        elif r.get("kind") == "multipart":
            if r.get("degraded"):
                print(f"  [ok] {r['name']}: part1 header 分卷标志（降级）")
            else:
                print(
                    f"  [ok] {r['name']}: 全卷校验（附属卷 "
                    f"{len(r['volumes_present'])} 个，校验后请按 README 删除）"
                )
        else:
            print(f"  [ok] {r['name']}: {r['entries']}")

    shutil.rmtree(WORK)
    print()
    print("全部产物校验通过。后续步骤（README 记录）:")
    print("  1. 删除 multipart 附属卷（part2 起，保留 part1）")
    print("  2. python gen_declared_dict.py && python gen_declared_dict.py --verify-kat")
    print("  3. 对 24 个 fixture 取 SHA-256 记入 README")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify", action="store_true", help="校验模式")
    parser.add_argument(
        "--build-empty-rar5",
        action="store_true",
        help="构造零条目 empty-rar5.rar（rar 7.x 删空即删档，改用真实 MAIN+ENDARC 头拼接）",
    )
    parser.add_argument("--7z", dest="sevenz", default=DEFAULT_7Z, help="7z.exe 路径")
    parser.add_argument("--rar", default=DEFAULT_RAR, help="rar.exe 路径")
    args = parser.parse_args()
    try:
        if args.verify:
            cmd_verify(args)
        elif args.build_empty_rar5:
            build_empty_rar5(args.rar)
        else:
            cmd_generate(args)
    except VerifyError as exc:
        print(f"FAILED: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

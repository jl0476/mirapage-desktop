#!/usr/bin/env python3
"""构造性 7z fixture 生成器：coder properties / header 声明受控 + KAT 向量。

生成 11 个 `dict-*` / `header-*` / `content-*` 构造性 fixture（Python 手写 7z 字节，
sevenz-rust 0.6.1 reader 语义对齐：签名头 + StartHeader CRC + 变长 number 编码 +
folder/coder/bind-pair 序列化；合法 encoded-header 变体的 packed payload 经 Python
标准库 `lzma` FORMAT_RAW 真实压缩，见 src-tauri 依赖源 reader.rs）。

  - dict-oversize-lzma.7z     plain header，LZMA coder 声明 dict=0xFFFFFFFF
  - dict-oversize-lzma2.7z    plain header，LZMA2 props 字节 0x28（映射 4 GiB）
  - dict-budget-oversum.7z    plain header，LZMA2 dict=4 MiB + page.png 真实 3 MiB
                              可解码 payload（预算内用例需要真实解码成功）
  - header-encoded-oversize.7z encoded header（0x17），外层 LZMA2 声明 unpack
                              16 MiB > MAX_ENCODED_HEADER_BYTES（8 MiB）
  - header-numfiles-over.7z   encoded header，外层 LZMA2 合法，内层（解码后）
                              kFilesInfo numFiles=100,001 > MAX_CATALOG_ENTRIES
  - header-copy.7z            encoded header，外层 COPY（对照，内层原样存放）
  - header-lzma.7z            encoded header，外层 LZMA（FILTER_LZMA1 压缩，对照）
  - header-delta-lzma2.7z     encoded header，外层 [LZMA2, Delta] 链（对照）
  - header-bcj-x86-lzma2.7z   encoded header，外层 [LZMA2, BCJ-x86] 链（对照）
  - header-kdf-over.7z        encoded header，外层 AES256SHA256 props=[0x20]
                              （cycles=32 > 24、高位 0 恰 1 字节；KDF 未启动即拒）
  - content-kdf-over.7z       plain header 主 streams，数据 folder AES props=[0x20]
                              （folder 级 KDF 防线载体）

恶意防线 fixture 的 pack 数据为确定性合成字节（解码前即拒）；合法对照变体的
payload 真实压缩可解码；任务 6 的运行时 SevenZWriter fixture 另行生成。

模式：
  默认        生成 11 个文件 + kat_vectors.json（KAT 从生成产物解析而来，非构造常量回填）
  --verify-kat 读取 kat_vectors.json，独立解析产物逐字段比对，任何漂移非零退出
  --print-kat  仅打印 kat_vectors.json（诊断）
"""

from __future__ import annotations

import argparse
import hashlib
import json
import lzma
import sys
import zlib
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
except Exception:
    pass

HERE = Path(__file__).resolve().parent
KAT_PATH = HERE / "kat_vectors.json"

SIG = b"7z\xbc\xaf\x27\x1c"

K_END = 0x00
K_HEADER = 0x01
K_MAIN_STREAMS_INFO = 0x04
K_FILES_INFO = 0x05
K_PACK_INFO = 0x06
K_UNPACK_INFO = 0x07
K_SUB_STREAMS = 0x08
K_SIZE = 0x09
K_CRC = 0x0A
K_FOLDER = 0x0B
K_CODERS_UNPACK_SIZE = 0x0C
K_NAME = 0x11
K_ENCODED_HEADER = 0x17

# 7z method id（字节串）
M_COPY = bytes([0x00])
M_DELTA = bytes([0x03])
M_LZMA = bytes([0x03, 0x01, 0x01])
M_LZMA2 = bytes([0x21])
M_BCJ_X86 = bytes([0x03, 0x03, 0x01, 0x03])
M_AES = bytes([0x06, 0xF1, 0x07, 0x01])


# ---------------------------------------------------------------------------
# 7z 基础编码（与 sevenz-rust reader.rs read_u64 对齐的变长 number）
# ---------------------------------------------------------------------------

def enc_num(v: int) -> bytes:
    """7z 变长 number 编码（sevenz-rust reader.rs read_u64 的逆）。

    i 个后续字节时首字节高 i 位置 1，剩余 (7-i) 位存 value 最高位段；
    编码容量 = 8i（后续字节）+ (7-i)（首字节剩余位）= 7(i+1) 位。
    """
    assert 0 <= v < (1 << 64)
    for i in range(8):
        if v < (1 << (7 * (i + 1))):
            head = (((1 << i) - 1) << (8 - i)) & 0xFF
            head |= v >> (8 * i)
            if i == 0:
                return bytes([head])
            return bytes([head]) + (v & ((1 << (8 * i)) - 1)).to_bytes(i, "little")
    return bytes([0xFF]) + v.to_bytes(8, "little")


def dec_num(data: bytes, pos: int) -> tuple[int, int]:
    first = data[pos]
    pos += 1
    mask = 0x80
    value = 0
    for i in range(8):
        if (first & mask) == 0:
            return value | ((first & (mask - 1)) << (8 * i)), pos
        value |= data[pos] << (8 * i)
        pos += 1
        mask >>= 1
    return value, pos


def _check_enc_dec_roundtrip() -> None:
    """编码器自检：与解码器互逆（构造性 fixture 的数字编码正确性前提）。"""
    import random

    rng = random.Random(20240101)
    samples = [0, 1, 0x7F, 0x80, 0x3FFF, 0x4000, 0x1FFFFF, 0x200000,
               0xFFFFFFF, 0x10000000, (1 << 32) - 1, 1 << 32, (1 << 63), (1 << 64) - 1]
    samples += [rng.randrange(0, 1 << 64) for _ in range(200)]
    for v in samples:
        enc = enc_num(v)
        got, pos = dec_num(enc + b"\x00" * 9, 0)
        assert got == v and pos == len(enc), f"number 编码往返失败: {v} -> {enc.hex()} -> {got}"


# ---------------------------------------------------------------------------
# header 构造
# ---------------------------------------------------------------------------

def write_folder(coders: list[tuple[bytes, bytes | None]]) -> bytes:
    """单 folder 序列化；所有 coder 均为 simple（1 in / 1 out）链。

    链序：pack → coder0 → coder1 → … → 输出；bind pair (j+1 的 in, j 的 out)。
    packed stream 数 = n - (n-1) = 1 → 按 7z 语义隐式，不写字节。
    """
    out = enc_num(len(coders))
    for cid, props in coders:
        flags = len(cid) & 0x0F
        if props is not None:
            flags |= 0x20  # ThereAreAttributes
        out += bytes([flags]) + cid
        if props is not None:
            out += enc_num(len(props)) + props
    for j in range(len(coders) - 1):
        out += enc_num(j + 1)  # in_index：coder j+1 的输入
        out += enc_num(j)      # out_index：coder j 的输出
    return out


def write_pack_info(pack_pos: int, sizes: list[int]) -> bytes:
    out = bytes([K_PACK_INFO]) + enc_num(pack_pos) + enc_num(len(sizes))
    out += bytes([K_SIZE])
    for s in sizes:
        out += enc_num(s)
    out += bytes([K_END])
    return out


def write_unpack_info(folders: list[list[tuple[bytes, bytes | None]]],
                      unpack_sizes: list[list[int]]) -> bytes:
    out = bytes([K_UNPACK_INFO, K_FOLDER]) + enc_num(len(folders)) + bytes([0])
    for folder in folders:
        out += write_folder(folder)
    out += bytes([K_CODERS_UNPACK_SIZE])
    for sizes in unpack_sizes:
        for s in sizes:
            out += enc_num(s)
    out += bytes([K_END])
    return out


def write_streams_info(pack_pos: int, pack_sizes: list[int],
                       folders, unpack_sizes, digests: list[int] | None = None) -> bytes:
    # kSubStreamsInfo（0x08）：缺省 = 每 folder 1 个 unpack stream、无 CRC；
    # digests 非空时写 K_CRC（all-defined + 每 substream 一个 u32 LE）——
    # sevenz-rust Archive 校验要求「有 streams 的文件」必须存在 substreams info。
    sub = bytes([K_SUB_STREAMS, K_END])
    if digests is not None:
        sub = bytes([K_SUB_STREAMS, K_CRC, 0x01])
        for d in digests:
            sub += d.to_bytes(4, "little")
        sub += bytes([K_END])
    return (
        write_pack_info(pack_pos, pack_sizes)
        + write_unpack_info(folders, unpack_sizes)
        + sub
        + bytes([K_END])
    )


def write_files_info(names: list[str]) -> bytes:
    """kName 属性：external=0 + UTF-16LE 逐名 NUL 终止；文件均有 streams。"""
    payload = bytes([0])
    for n in names:
        payload += n.encode("utf-16-le") + b"\x00\x00"
    out = bytes([K_FILES_INFO]) + enc_num(len(names))
    out += bytes([K_NAME]) + enc_num(len(payload)) + payload
    out += bytes([K_END])  # FilesInfo 属性列表终止
    return out


def crc32(data: bytes) -> int:
    return zlib.crc32(data) & 0xFFFFFFFF


def build_7z(pack: bytes, next_header: bytes) -> bytes:
    start = (
        len(pack).to_bytes(8, "little")
        + len(next_header).to_bytes(8, "little")
        + crc32(next_header).to_bytes(4, "little")
    )
    head = (
        SIG
        + bytes([0x00, 0x04])
        + crc32(start).to_bytes(4, "little")
        + start
    )
    return head + pack + next_header


def synthetic_pack(size: int = 64) -> bytes:
    return bytes((i * 31 + 7) & 0xFF for i in range(size))


# ---------------------------------------------------------------------------
# Python lzma FORMAT_RAW 压缩（合法 encoded-header 变体的真实 payload）
# ---------------------------------------------------------------------------

def _lzma_compress(data: bytes, filters: list[dict]) -> bytes:
    c = lzma.LZMACompressor(format=lzma.FORMAT_RAW, filters=filters)
    return c.compress(data) + c.flush()


def lzma1_compress(data: bytes, dict_size: int = 1 << 20) -> bytes:
    """LZMA1 raw：lc=3/lp=0/pb=2（preset 6 默认 → props 首字节 0x5D）。"""
    return _lzma_compress(
        data, [{"id": lzma.FILTER_LZMA1, "preset": 6, "dict_size": dict_size}]
    )


def lzma2_compress(data: bytes, dict_size: int = 1 << 21) -> bytes:
    return _lzma_compress(
        data, [{"id": lzma.FILTER_LZMA2, "preset": 6, "dict_size": dict_size}]
    )


def delta_lzma2_compress(data: bytes, dist: int = 1, dict_size: int = 1 << 21) -> bytes:
    # Python filter 序列 = 压缩方向的数据流：data → delta → lzma2。
    # 7z coder 链（解压方向）pack → LZMA2 → Delta → 输出。
    return _lzma_compress(
        data,
        [{"id": lzma.FILTER_DELTA, "dist": dist},
         {"id": lzma.FILTER_LZMA2, "preset": 6, "dict_size": dict_size}],
    )


def x86_lzma2_compress(data: bytes, dict_size: int = 1 << 21) -> bytes:
    # data → BCJ-x86 → lzma2；解压方向 pack → LZMA2 → BCJ-x86 反变换 → 输出。
    return _lzma_compress(
        data,
        [{"id": lzma.FILTER_X86},
         {"id": lzma.FILTER_LZMA2, "preset": 6, "dict_size": dict_size}],
    )


def lzma2_props_byte(dict_size: int) -> int:
    """dict_size → LZMA2 props 档位字节（(2|(d&1))<<(d/2+11) 的逆，2 MiB ≤ dict ≤ 4 GiB-1）。"""
    d = 0
    while (2 | (d & 1)) << (d // 2 + 11) < dict_size and d < 40:
        d += 1
    assert (2 | (d & 1)) << (d // 2 + 11) == dict_size, f"非 LZMA2 档位 dict: {dict_size}"
    return d


# ---------------------------------------------------------------------------
# 11 个 fixture 规格
# ---------------------------------------------------------------------------

DICT_OVER = 0xFFFFFFFF          # LZMA u32 上限：4 GiB - 1
LZMA2_DICT_BYTE_OVER = 0x28     # 40 → (2|0)<<(40/2+11) = 4 GiB
BUDGET_DICT = 4 * 1024 * 1024   # dict-budget-oversum 的 LZMA2 声明 dict：4 MiB
BUDGET_PAYLOAD = 3 * 1024 * 1024  # page.png 真实 payload：3 MiB（声明大小 = 实际字节数）
HEADER_DICT = 1 << 21           # 合法 encoded 变体外层 LZMA2 声明 dict：2 MiB
HEADER_UNPACK_OVER = 16 * 1024 * 1024  # 外层声明 unpack 16 MiB > MAX_ENCODED_HEADER_BYTES(8 MiB)
NUM_FILES_OVER = 100_001        # 内层 kFilesInfo numFiles > MAX_CATALOG_ENTRIES(100,000)
KDF_CYCLES_OVER_BYTE = 0x20     # cycles=32 > 24 且 b0&0xC0==0（properties 恰 1 字节）

# sevenz-rust 0.6.1 / 7-Zip 7zAes.cpp 的 AES props 解码公式（生成本组 props 只需 1 字节）：
#   b0: bits0-5 numCyclesPower；b0&0xC0==0 → properties 恰 1 字节；
#   否则 b1: salt_len=((b0>>7)&1)+(b1>>4)、iv_len=((b0>>6)&1)+(b1&0x0F)，总长 2+salt+iv。


def lzma_props(dict_size: int) -> bytes:
    return bytes([0x5D]) + dict_size.to_bytes(4, "little")


def plain_header(pack_sizes, folders, unpack_sizes, names, digests=None):
    nh = bytes([K_HEADER])
    if folders:
        nh += bytes([K_MAIN_STREAMS_INFO])  # sevenz-rust read_header 要求 04 前缀
        nh += write_streams_info(0, pack_sizes, folders, unpack_sizes, digests)
    nh += write_files_info(names)
    nh += bytes([K_END])
    return nh


def encoded_header(pack_pos, pack_sizes, folders, unpack_sizes):
    # 0x17 后直接跟 streams info（无 04 前缀），read_streams_info 自读首个 id
    nh = bytes([K_ENCODED_HEADER])
    nh += write_streams_info(pack_pos, pack_sizes, folders, unpack_sizes)
    return nh


def build_specs() -> dict[str, bytes]:
    """返回 fixture 名 → 完整 7z 字节。"""
    p64 = synthetic_pack(64)
    specs: dict[str, bytes] = {}

    # 1. dict-oversize-lzma：LZMA 声明 dict = 0xFFFFFFFF
    specs["dict-oversize-lzma.7z"] = build_7z(
        p64, plain_header([64], [[(M_LZMA, lzma_props(DICT_OVER))]], [[128]], ["a.txt"])
    )
    # 2. dict-oversize-lzma2：LZMA2 props 字节 0x28（4 GiB）
    specs["dict-oversize-lzma2.7z"] = build_7z(
        p64, plain_header([64], [[(M_LZMA2, bytes([LZMA2_DICT_BYTE_OVER]))]], [[128]], ["a.txt"])
    )
    # 3. dict-budget-oversum：LZMA2 声明 dict 4 MiB + page.png 真实 3 MiB payload，
    #    header/substream/CRC 全部正确（预算内用例需要真实解码成功）
    payload = synthetic_pack(256) * (BUDGET_PAYLOAD // 256)
    assert len(payload) == BUDGET_PAYLOAD
    pack = lzma2_compress(payload, dict_size=BUDGET_DICT)
    specs["dict-budget-oversum.7z"] = build_7z(
        pack,
        plain_header(
            [len(pack)],
            [[(M_LZMA2, bytes([lzma2_props_byte(BUDGET_DICT)]))]],
            [[len(payload)]],
            ["page.png"],
            digests=[crc32(payload)],
        ),
    )
    # 4. header-encoded-oversize：外层 LZMA2 全法（dict 2 MiB），声明 unpack 16 MiB
    #    > MAX_ENCODED_HEADER_BYTES（8 MiB）——防线靠外层声明值触发，pack 为占位字节
    specs["header-encoded-oversize.7z"] = build_7z(
        p64,
        encoded_header(
            0, [64],
            [[(M_LZMA2, bytes([lzma2_props_byte(HEADER_DICT)]))]],
            [[HEADER_UNPACK_OVER]],
        ),
    )
    # 5. header-numfiles-over：外层 encoded header 全部合法（LZMA2、unpack/dict/CRC 在限内），
    #    内层（解码后）kFilesInfo numFiles=100,001——阶段二解析到内层 numFiles 即拒绝
    inner_numfiles = (
        bytes([K_HEADER, K_FILES_INFO]) + enc_num(NUM_FILES_OVER)
        + bytes([K_END])   # FilesInfo 属性列表终止（属性最小占位）
        + bytes([K_END])   # header 终止
    )
    pack_numfiles = lzma2_compress(inner_numfiles, dict_size=HEADER_DICT)
    specs["header-numfiles-over.7z"] = build_7z(
        pack_numfiles,
        encoded_header(
            0, [len(pack_numfiles)],
            [[(M_LZMA2, bytes([lzma2_props_byte(HEADER_DICT)]))]],
            [[len(inner_numfiles)]],
        ),
    )
    # 内层"catalog 载体" header：main streams 1 folder LZMA2(2 MiB 声明) + page.png
    # （catalog 只读 header 不读数据，pack 用合成字节即可）
    inner = plain_header(
        [64], [[(M_LZMA2, bytes([lzma2_props_byte(HEADER_DICT)]))]], [[128]], ["page.png"]
    )
    # 6. header-copy：外层 COPY——内层属性流原样存放（无需压缩）
    specs["header-copy.7z"] = build_7z(
        p64 + inner,
        encoded_header(64, [len(inner)], [[(M_COPY, None)]], [[len(inner)]]),
    )
    # 7. header-lzma：外层 LZMA（FILTER_LZMA1 压缩，dict 1 MiB）
    pack_lzma = lzma1_compress(inner, dict_size=1 << 20)
    specs["header-lzma.7z"] = build_7z(
        p64 + pack_lzma,
        encoded_header(
            64, [len(pack_lzma)],
            [[(M_LZMA, lzma_props(1 << 20))]],
            [[len(inner)]],
        ),
    )
    # 8. header-delta-lzma2：外层 [LZMA2(2 MiB), Delta(dist=1)] 链
    #    2 coder = 2 out stream → kCodersUnpackSize 需 2 个值（delta 保长）
    pack_delta = delta_lzma2_compress(inner, dist=1, dict_size=HEADER_DICT)
    specs["header-delta-lzma2.7z"] = build_7z(
        p64 + pack_delta,
        encoded_header(
            64, [len(pack_delta)],
            [[(M_LZMA2, bytes([lzma2_props_byte(HEADER_DICT)])), (M_DELTA, bytes([0x00]))]],
            [[len(inner), len(inner)]],
        ),
    )
    # 9. header-bcj-x86-lzma2：外层 [LZMA2(2 MiB), BCJ-x86] 链（x86 保长）
    pack_bcj = x86_lzma2_compress(inner, dict_size=HEADER_DICT)
    specs["header-bcj-x86-lzma2.7z"] = build_7z(
        p64 + pack_bcj,
        encoded_header(
            64, [len(pack_bcj)],
            [[(M_LZMA2, bytes([lzma2_props_byte(HEADER_DICT)])), (M_BCJ_X86, None)]],
            [[len(inner), len(inner)]],
        ),
    )
    # 10. header-kdf-over：encoded header 外层 AES props=[0x20]
    #     （cycles=32>24、高位 0 → properties 恰 1 字节；KDF 未启动即拒）
    specs["header-kdf-over.7z"] = build_7z(
        p64,
        encoded_header(0, [64], [[(M_AES, bytes([KDF_CYCLES_OVER_BYTE]))]], [[128]]),
    )
    # 11. content-kdf-over：plain header 主 streams 的数据 folder AES props=[0x20]
    #     （folder 级 KDF 防线：probe 阶段即拒，不进条目解码）
    specs["content-kdf-over.7z"] = build_7z(
        p64,
        plain_header([64], [[(M_AES, bytes([KDF_CYCLES_OVER_BYTE]))]], [[128]], ["a.txt"]),
    )
    return specs


# ---------------------------------------------------------------------------
# 独立解析（KAT 复算路径：从产物字节读出声明，不回填构造常量）
# ---------------------------------------------------------------------------

def lzma_dict_from_props(props: bytes) -> int:
    return int.from_bytes(props[1:5], "little")


def lzma2_dict_from_props(props: bytes) -> int:
    d = props[0]
    if d == 40:
        return 0xFFFFFFFF
    return (2 | (d & 1)) << (d // 2 + 11)


def aes_props_decl(props: bytes) -> dict:
    """7zAes.cpp 属性公式：b0&0xC0==0 → 恰 1 字节；否则 b1 半字节（高位 +1）。"""
    b0 = props[0]
    cycles = b0 & 0x3F
    if b0 & 0xC0 == 0:
        if len(props) != 1:
            raise ValueError(f"AES props 高位 0 但长度 {len(props)} != 1")
        return {"cycles_power": cycles, "salt_size": 0, "iv_size": 0}
    b1 = props[1]
    salt_size = ((b0 >> 7) & 1) + (b1 >> 4)
    iv_size = ((b0 >> 6) & 1) + (b1 & 0x0F)
    if len(props) != 2 + salt_size + iv_size:
        raise ValueError("AES props 长度与 salt/iv 编码不符")
    return {"cycles_power": cycles, "salt_size": salt_size, "iv_size": iv_size}


def parse_coder(data: bytes, pos: int) -> tuple[dict, int]:
    flags = data[pos]
    pos += 1
    id_size = flags & 0x0F
    cid = data[pos : pos + id_size]
    pos += id_size
    props = None
    if flags & 0x20:
        psize, pos = dec_num(data, pos)
        props = data[pos : pos + psize]
        pos += psize
    return {"id": cid, "props": props}, pos


def parse_folder(data: bytes, pos: int) -> tuple[list[dict], int]:
    num_coders, pos = dec_num(data, pos)
    coders: list[dict] = []
    for _ in range(num_coders):
        coder, pos = parse_coder(data, pos)
        coders.append(coder)
    num_bind_pairs = num_coders - 1
    for _ in range(num_bind_pairs):
        _, pos = dec_num(data, pos)  # in_index
        _, pos = dec_num(data, pos)  # out_index
    num_packed = num_coders - num_bind_pairs
    if num_packed != 1:
        for _ in range(num_packed):
            _, pos = dec_num(data, pos)
    return coders, pos


def restricted_decode(pack: bytes, coders: list[dict], out_size: int) -> bytes:
    """镜像任务 6 自研受限 header decoder：按 coder 链（pack → coder0 → …）解码。

    仅覆盖生成器产出的合法链（COPY / LZMA / LZMA2 / [LZMA2, Delta] / [LZMA2, BCJ-x86]）；
    AES 链（kdf 拒绝载体）由调用方先行排除。
    """
    ids = [c["id"] for c in coders]
    if ids == [M_COPY]:
        return pack[:out_size]
    if ids == [M_LZMA]:
        props = coders[0]["props"]
        filters = [{
            "id": lzma.FILTER_LZMA1,
            "lc": props[0] % 9,
            "lp": (props[0] // 9) % 5,
            "pb": (props[0] // 45) % 5,
            "dict_size": lzma_dict_from_props(props),
        }]
    elif ids == [M_LZMA2]:
        filters = [{"id": lzma.FILTER_LZMA2,
                    "dict_size": lzma2_dict_from_props(coders[0]["props"])}]
    elif ids == [M_LZMA2, M_DELTA]:
        filters = [{"id": lzma.FILTER_DELTA, "dist": coders[1]["props"][0] + 1},
                   {"id": lzma.FILTER_LZMA2,
                    "dict_size": lzma2_dict_from_props(coders[0]["props"])}]
    elif ids == [M_LZMA2, M_BCJ_X86]:
        filters = [{"id": lzma.FILTER_X86},
                   {"id": lzma.FILTER_LZMA2,
                    "dict_size": lzma2_dict_from_props(coders[0]["props"])}]
    else:
        raise ValueError(f"restricted_decode 不支持的链: {[c.hex() for c in ids]}")
    d = lzma.LZMADecompressor(format=lzma.FORMAT_RAW, filters=filters)
    out = d.decompress(pack)
    if len(out) < out_size:
        raise ValueError(f"解码输出 {len(out)} < 声明 {out_size}")
    return out[:out_size]


def parse_7z_declarations(data: bytes) -> dict:
    """从字节级解析出 KAT 字段（独立于构造路径）。"""
    if data[:6] != SIG:
        raise ValueError("签名头不匹配")
    if data[6] != 0:
        raise ValueError("主版本号非 0")
    start_crc = int.from_bytes(data[8:12], "little")
    start = data[12:32]
    if crc32(start) != start_crc:
        raise ValueError("StartHeader CRC 不匹配")
    nh_offset = int.from_bytes(start[0:8], "little")
    nh_size = int.from_bytes(start[8:16], "little")
    nh_crc = int.from_bytes(start[16:20], "little")
    nh = data[32 + nh_offset : 32 + nh_offset + nh_size]
    if crc32(nh) != nh_crc:
        raise ValueError("NextHeader CRC 不匹配")

    pos = 0
    kind = "plain" if nh[pos] == K_HEADER else "encoded"
    pos += 1
    num_files = 0
    outer_coders: list[list[dict]] | None = None
    if kind == "encoded":
        # 0x17 后跟 streams info（pack/unpack/substreams + END）
        parsed, pos = parse_streams(nh, pos)
        outer_coders = parsed["folders"]
        # 可解链条目递归进内层声明（kdf/oversize 载体在解码前即拒，保留外层声明）
        inner_decl = try_decode_inner(data, parsed)
        if inner_decl is not None:
            return {
                "next_header": {"kind": kind, "offset": 32 + nh_offset, "size": nh_size},
                "outer": coder_entries(outer_coders),
                **inner_decl,
            }
        folders = outer_coders
    else:
        if nh[pos] == K_MAIN_STREAMS_INFO:
            parsed, pos = parse_streams(nh, pos + 1)
            folders = parsed["folders"]
        else:
            folders = []
        if nh[pos] == K_FILES_INFO:
            num_files, pos = dec_num(nh, pos + 1)
            pos = parse_files_props(nh, pos, num_files)
    if kind == "encoded":
        # 0x17 头在 streams info 的 K_END 处结束，无外层终止符
        if pos != len(nh):
            raise ValueError(f"encoded header 尾部多余字节 @ {pos}")
    else:
        if nh[pos] != K_END:
            raise ValueError(f"header 终止符错误 @ {pos}: {nh[pos]:#x}")

    out_coders = coder_entries(folders)
    result = {
        "next_header": {"kind": kind, "offset": 32 + nh_offset, "size": nh_size},
        "num_folders": len(folders),
        "num_files": num_files,
        "coders": out_coders,
        "total_declared_dict": sum(
            c["declared_dict"] for c in out_coders if "declared_dict" in c
        ),
    }
    if outer_coders is not None:
        result["outer"] = coder_entries(outer_coders)
    return result


def try_decode_inner(data: bytes, parsed: dict) -> dict | None:
    """encoded header 的受限解码 + 内层声明解析；不可解码（拒绝载体）返回 None。"""
    if len(parsed["folders"]) != 1:
        return None
    folder = parsed["folders"][0]
    ids = [c["id"] for c in folder]
    if any(i == M_AES for i in ids):
        return None  # kdf 拒绝载体：预检在派生前拒绝，内层不可达
    pack_pos, pack_sizes, unpack_sizes = parsed["pack_pos"], parsed["pack_sizes"], parsed["unpack_sizes"]
    if not pack_sizes or len(unpack_sizes) != 1 or len(unpack_sizes[0]) != len(folder):
        return None
    if sum(sum(s) for s in unpack_sizes) > 8 * 1024 * 1024:
        # unpack 超限拒绝载体（镜像 MAX_ENCODED_HEADER_BYTES 边界）：预检在解码前拒绝
        return None
    pack_start = 32 + pack_pos
    pack = data[pack_start : pack_start + pack_sizes[0]]
    if len(pack) != pack_sizes[0]:
        raise ValueError("外层 pack 区间越出文件长度")
    # folder 唯一已检查；最终输出 stream 的声明大小 = 该 folder 尺寸表末项（线性链）
    out_size = unpack_sizes[0][-1]
    inner = restricted_decode(pack, folder, out_size)
    # 内层 = kHeader blob
    if inner[0] != K_HEADER:
        raise ValueError("解码后内层缺 kHeader")
    ipos = 1
    if inner[ipos] == K_MAIN_STREAMS_INFO:
        iparsed, ipos = parse_streams(inner, ipos + 1)
        folders = iparsed["folders"]
    else:
        folders = []
    if inner[ipos] == K_FILES_INFO:
        num_files, ipos = dec_num(inner, ipos + 1)
        ipos = parse_files_props(inner, ipos, num_files)
    else:
        num_files = 0
    if inner[ipos] != K_END:
        raise ValueError("内层 header 终止符错误")
    out_coders = coder_entries(folders)
    return {
        "num_folders": len(folders),
        "num_files": num_files,
        "coders": out_coders,
        "total_declared_dict": sum(
            c["declared_dict"] for c in out_coders if "declared_dict" in c
        ),
    }


def coder_entries(folders: list[list[dict]]) -> list[dict]:
    out: list[dict] = []
    for folder in folders:
        for coder in folder:
            entry: dict = {
                "id": coder["id"].hex(),
                "props": coder["props"].hex() if coder["props"] is not None else None,
            }
            if coder["id"] == M_LZMA and coder["props"]:
                entry["declared_dict"] = lzma_dict_from_props(coder["props"])
            elif coder["id"] == M_LZMA2 and coder["props"]:
                entry["declared_dict"] = lzma2_dict_from_props(coder["props"])
            elif coder["id"] == M_AES and coder["props"]:
                entry.update(aes_props_decl(coder["props"]))
            out.append(entry)
    return out


def parse_streams(data: bytes, pos: int) -> tuple[dict, int]:
    """StreamsInfo 解析；返回 {pack_pos, pack_sizes, folders, unpack_sizes}。"""
    folders: list[list[dict]] = []
    pack_pos = 0
    pack_sizes: list[int] = []
    unpack_sizes: list[list[int]] = []
    num_folders = 0
    nid = data[pos]
    pos += 1
    if nid == K_PACK_INFO:
        pack_pos, pos = dec_num(data, pos)
        num_pack, pos = dec_num(data, pos)
        nid = data[pos]
        pos += 1
        if nid == K_SIZE:
            for _ in range(num_pack):
                s, pos = dec_num(data, pos)
                pack_sizes.append(s)
            nid = data[pos]
            pos += 1
        if nid == K_CRC:
            raise ValueError("pack 级 K_CRC 未由生成器产出")
        if nid != K_END:
            raise ValueError("pack info 终止符错误")
        nid = data[pos]
        pos += 1
    if nid == K_UNPACK_INFO:
        if data[pos] != K_FOLDER:
            raise ValueError("unpack info 缺 kFolder")
        pos += 1
        num_folders, pos = dec_num(data, pos)
        pos += 1  # external = 0
        for _ in range(num_folders):
            coders, pos = parse_folder(data, pos)
            folders.append(coders)
        if data[pos] != K_CODERS_UNPACK_SIZE:
            raise ValueError("unpack info 缺 kCodersUnpackSize")
        pos += 1
        for folder in folders:
            sizes: list[int] = []
            for _ in range(len(folder)):
                s, pos = dec_num(data, pos)
                sizes.append(s)
            unpack_sizes.append(sizes)
        if data[pos] != K_END:
            raise ValueError("unpack info 终止符错误（folder 级 K_CRC 未由生成器产出）")
        pos += 1
        if data[pos] == K_SUB_STREAMS:
            pos += 1
            pos = parse_substreams(data, pos, folders)
        if data[pos] != K_END:
            raise ValueError("streams info 终止符错误")
        pos += 1  # streams info END
    else:
        folders = []
        if nid != K_END:
            raise ValueError("streams info 终止符错误")
        pos -= 1  # 该 K_END 由上层 header 循环语义外消费，回退交由调用方判定
    return {
        "pack_pos": pack_pos,
        "pack_sizes": pack_sizes,
        "folders": folders,
        "unpack_sizes": unpack_sizes,
    }, pos


def parse_substreams(data: bytes, pos: int, folders: list[list[dict]]) -> int:
    """kSubStreamsInfo（生成器只写缺省 / K_CRC all-defined 两种形态）。"""
    if data[pos] == K_END:
        return pos + 1
    if data[pos] != K_CRC:
        raise ValueError("substreams info 含生成器未写的属性")
    pos += 1
    all_defined = data[pos]
    pos += 1
    if all_defined:
        # 每 folder 1 个 digest（folder 无 CRC 时）——值个数 = folder 数
        pos += 4 * len(folders)
    else:
        raise ValueError("substreams CRC 逐位定义未由生成器产出")
    if data[pos] != K_END:
        raise ValueError("substreams info 终止符错误")
    return pos + 1


def parse_files_props(data: bytes, pos: int, num_files: int) -> int:
    while True:
        prop_type = data[pos]
        pos += 1
        if prop_type == K_END:
            return pos
        size, pos = dec_num(data, pos)
        pos += size


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

CONTRACTS: dict[str, str] = {
    "dict-oversize-lzma.7z": "plain header；LZMA coder 声明 dict=0xFFFFFFFF（4 GiB-1），folder 级 dict 防线拒绝",
    "dict-oversize-lzma2.7z": "plain header；LZMA2 props=0x28 映射 dict=4 GiB，folder 级 dict 防线拒绝",
    "dict-budget-oversum.7z": "plain header；LZMA2 dict=4 MiB + page.png 真实 3 MiB payload（substream CRC 正确），预算内用例真实解码成功载体",
    "header-encoded-oversize.7z": "encoded header（0x17）；外层 LZMA2 dict 2 MiB 合法，声明 unpack 16 MiB > MAX_ENCODED_HEADER_BYTES（8 MiB），阶段一拒绝",
    "header-numfiles-over.7z": "encoded header；外层 LZMA2 全法，内层（解码后）kFilesInfo numFiles=100,001 > MAX_CATALOG_ENTRIES，阶段二拒绝",
    "header-copy.7z": "encoded header；外层 COPY（无 props），内层属性流原样存放，预检放行对照",
    "header-lzma.7z": "encoded header；外层 LZMA（FILTER_LZMA1 压缩，dict 1 MiB），预检放行对照",
    "header-delta-lzma2.7z": "encoded header；外层 [LZMA2(2 MiB), Delta(dist=1)] 链，预检放行对照",
    "header-bcj-x86-lzma2.7z": "encoded header；外层 [LZMA2(2 MiB), BCJ-x86] 链，预检放行对照",
    "header-kdf-over.7z": "encoded header；外层 AES256SHA256 props=[0x20]（cycles=32>24、高位 0 恰 1 字节），KDF 未启动即拒",
    "content-kdf-over.7z": "plain header 主 streams；数据 folder AES props=[0x20]，folder 级 KDF 防线（probe 阶段拒绝）",
}


def build_kat_entry(name: str, data: bytes) -> dict:
    parsed = parse_7z_declarations(data)
    return {
        "name": name,
        "size": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "contract": CONTRACTS[name],
        **parsed,
    }


def cmd_generate() -> int:
    _check_enc_dec_roundtrip()
    specs = build_specs()
    if len(specs) != 11:
        raise SystemExit(f"应有 11 个构造性 fixture，实际 {len(specs)}")
    kat = {"format": 1, "generator": "gen_declared_dict.py", "fixtures": []}
    for name, data in specs.items():
        (HERE / name).write_bytes(data)
        kat["fixtures"].append(build_kat_entry(name, (HERE / name).read_bytes()))
        print(f"  生成 {name}  {len(data)} bytes")
    KAT_PATH.write_text(
        json.dumps(kat, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(f"kat_vectors.json 写入（{len(kat['fixtures'])} 个向量，来自产物解析）")
    return 0


def cmd_verify_kat() -> int:
    _check_enc_dec_roundtrip()
    if not KAT_PATH.exists():
        print("FAILED: kat_vectors.json 不存在", file=sys.stderr)
        return 1
    kat = json.loads(KAT_PATH.read_text(encoding="utf-8"))
    stored = {f["name"]: f for f in kat["fixtures"]}
    on_disk = sorted(p.name for p in HERE.glob("*.7z"))
    problems: list[str] = []
    if sorted(stored) != on_disk:
        problems.append(
            f"7z 文件集合与 KAT 不一致: 磁盘={on_disk} KAT={sorted(stored)}"
        )
    for name in sorted(set(stored) & set(on_disk)):
        expected = stored[name]
        actual = build_kat_entry(name, (HERE / name).read_bytes())
        for field in ("size", "sha256", "next_header", "num_folders", "num_files",
                      "coders", "total_declared_dict", "outer"):
            if expected.get(field) != actual.get(field):
                problems.append(
                    f"{name}.{field} 漂移: KAT={expected.get(field)!r} 实际={actual.get(field)!r}"
                )
    if problems:
        for p in problems:
            print(f"FAILED: {p}", file=sys.stderr)
        return 1
    print(f"KAT 校验通过：{len(stored)} 个构造性 fixture 逐字段一致（size/sha256/header 声明）")
    return 0


def cmd_print_kat() -> int:
    print(KAT_PATH.read_text(encoding="utf-8"))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify-kat", action="store_true", help="复算并比对 KAT")
    parser.add_argument("--print-kat", action="store_true", help="仅打印 KAT（诊断）")
    args = parser.parse_args()
    if args.verify_kat:
        return cmd_verify_kat()
    if args.print_kat:
        return cmd_print_kat()
    return cmd_generate()


if __name__ == "__main__":
    sys.exit(main())

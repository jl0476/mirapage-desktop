#!/usr/bin/env python3
"""构造性 7z fixture 生成器：coder properties / header 声明受控 + KAT 向量。

生成 11 个 `dict-*` / `header-*` / `content-*` 构造性 fixture（纯 Python 手写 7z 字节，
sevenz-rust 0.6.1 reader 语义对齐：签名头 + StartHeader CRC + 变长 number 编码 +
folder/coder/bind-pair 序列化，见 src-tauri 依赖源 reader.rs）。

  - dict-oversize-lzma.7z     plain header，LZMA coder 声明 dict=0xFFFFFFFF
  - dict-oversize-lzma2.7z    plain header，LZMA2 props 字节 0x28（映射 4 GiB）
  - dict-budget-oversum.7z    plain header，3 folder × LZMA dict=512 MiB（合计 1.5 GiB）
  - header-encoded-oversize.7z encoded header（0x17），header coder LZMA dict=0xFFFFFFFF
  - header-numfiles-over.7z   plain header，kFilesInfo numFiles=10,000,000，无 streams
  - header-copy.7z            plain header，COPY coder（对照）
  - header-lzma.7z            plain header，LZMA dict=64 KiB（对照）
  - header-delta-lzma2.7z     plain header，[LZMA2, Delta] 链（对照）
  - header-bcj-x86-lzma2.7z   plain header，[LZMA2, BCJ-x86] 链（对照）
  - header-kdf-over.7z        encoded header，AES256SHA256 numCyclesPower=24
  - content-kdf-over.7z       plain header 主 streams，AES256SHA256 numCyclesPower=24

这些是 header 预检探针：pack 数据为确定性合成字节，不代表可解压内容；任务 6 的
运行时 SevenZWriter fixture 另行生成。

模式：
  默认        生成 11 个文件 + kat_vectors.json（KAT 从生成产物解析而来，非构造常量回填）
  --verify-kat 读取 kat_vectors.json，独立解析产物逐字段比对，任何漂移非零退出
  --print-kat  仅打印 kat_vectors.json（诊断）
"""

from __future__ import annotations

import argparse
import hashlib
import json
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
K_SIZE = 0x09
K_SUB_STREAMS = 0x08
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
                       folders, unpack_sizes) -> bytes:
    # kSubStreamsInfo（0x08）最小块：全部缺省（每 folder 1 个 unpack stream）。
    # sevenz-rust Archive 校验要求「有 streams 的文件」必须存在 substreams info。
    return (
        write_pack_info(pack_pos, pack_sizes)
        + write_unpack_info(folders, unpack_sizes)
        + bytes([K_SUB_STREAMS, K_END])
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
# 11 个 fixture 规格
# ---------------------------------------------------------------------------

DICT_OVER = 0xFFFFFFFF          # LZMA u32 上限：4 GiB - 1
LZMA2_DICT_BYTE_OVER = 0x28     # 40 → (2|0)<<(40/2+11) = 4 GiB
BUDGET_EACH = 0x20000000        # 512 MiB / folder × 3 = 1.5 GiB
LZMA_DICT_CONTROL = 0x10000     # 64 KiB（对照）
LZMA2_DICT_BYTE_CONTROL = 0x12  # 18 → (2|(0))<<(18/2+11) = 2 MiB（1 MiB 是 props 0x10）
NUM_FILES_OVER = 10_000_000
KDF_CYCLES_OVER = 24            # numCyclesPower（真实归档典型 19）

# sevenz-rust 0.6.1 aes256sha256 props：打包位格式
#   b0: bits0-5 numCyclesPower | bit6 ivSize 高位 | bit7 saltSize 高位
#   b1: bits0-3 ivSize 低位 | bits4-7 saltSize 低位；随后 salt、iv 原始字节
SALT = bytes((i * 11 + 3) & 0xFF for i in range(8))
IV = bytes((i * 13 + 5) & 0xFF for i in range(16))


def aes_props(cycles: int, salt: bytes, iv: bytes) -> bytes:
    salt_size, iv_size = len(salt), len(iv)
    assert salt_size <= 16 and iv_size <= 16
    b0 = (cycles & 0x3F) | (((iv_size >> 4) & 1) << 6) | (((salt_size >> 4) & 1) << 7)
    b1 = (iv_size & 0x0F) | ((salt_size & 0x0F) << 4)
    return bytes([b0, b1]) + salt + iv


def lzma_props(dict_size: int) -> bytes:
    return bytes([0x5D]) + dict_size.to_bytes(4, "little")


def plain_header(pack_sizes, folders, unpack_sizes, names):
    nh = bytes([K_HEADER])
    if folders:
        nh += bytes([K_MAIN_STREAMS_INFO])  # sevenz-rust read_header 要求 04 前缀
        nh += write_streams_info(0, pack_sizes, folders, unpack_sizes)
    nh += write_files_info(names)
    nh += bytes([K_END])
    return nh


def encoded_header(pack_sizes, folders, unpack_sizes):
    # 0x17 后直接跟 streams info（无 04 前缀），read_streams_info 自读首个 id
    nh = bytes([K_ENCODED_HEADER])
    nh += write_streams_info(0, pack_sizes, folders, unpack_sizes)
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
    # 3. dict-budget-oversum：3 folder × 512 MiB，单 coder 均不超 u32 上限，
    #    合计 1.5 GiB——总预算（跨 folder 累计）拒绝路径的载体
    specs["dict-budget-oversum.7z"] = build_7z(
        p64 * 3,
        plain_header(
            [64, 64, 64],
            [
                [(M_LZMA, lzma_props(BUDGET_EACH))],
                [(M_LZMA, lzma_props(BUDGET_EACH))],
                [(M_LZMA, lzma_props(BUDGET_EACH))],
            ],
            [[128], [128], [128]],
            ["a.txt", "b.txt", "c.txt"],
        ),
    )
    # 4. header-encoded-oversize：encoded header 的 coder 声明超限 dict
    specs["header-encoded-oversize.7z"] = build_7z(
        p64, encoded_header([64], [[(M_LZMA, lzma_props(DICT_OVER))]], [[128]])
    )
    # 5. header-numfiles-over：无 streams，仅声明超量文件数
    #    （FilesInfo 属性列表终止符 + header 终止符，两个 0x00）
    nh = (
        bytes([K_HEADER]) + bytes([K_FILES_INFO]) + enc_num(NUM_FILES_OVER)
        + bytes([K_END]) + bytes([K_END])
    )
    specs["header-numfiles-over.7z"] = build_7z(b"", nh)
    # 6. header-copy：COPY coder 对照（无 props）
    specs["header-copy.7z"] = build_7z(
        p64, plain_header([64], [[(M_COPY, None)]], [[64]], ["a.txt"])
    )
    # 7. header-lzma：LZMA 64 KiB 对照
    specs["header-lzma.7z"] = build_7z(
        p64,
        plain_header([64], [[(M_LZMA, lzma_props(LZMA_DICT_CONTROL))]], [[128]], ["a.txt"]),
    )
    # 8. header-delta-lzma2：[LZMA2(2 MiB), Delta(dist=1)] 链对照
    #    2 coder = 2 out stream → kCodersUnpackSize 需 2 个值
    specs["header-delta-lzma2.7z"] = build_7z(
        p64,
        plain_header(
            [64],
            [[(M_LZMA2, bytes([LZMA2_DICT_BYTE_CONTROL])), (M_DELTA, bytes([0x01]))]],
            [[128, 128]],
            ["a.txt"],
        ),
    )
    # 9. header-bcj-x86-lzma2：[LZMA2(2 MiB), BCJ-x86] 链对照
    specs["header-bcj-x86-lzma2.7z"] = build_7z(
        p64,
        plain_header(
            [64],
            [[(M_LZMA2, bytes([LZMA2_DICT_BYTE_CONTROL])), (M_BCJ_X86, None)]],
            [[128, 128]],
            ["a.txt"],
        ),
    )
    # 10. header-kdf-over：encoded header 的 AES coder numCyclesPower=24
    specs["header-kdf-over.7z"] = build_7z(
        p64,
        encoded_header([64], [[(M_AES, aes_props(KDF_CYCLES_OVER, SALT, IV))]], [[128]]),
    )
    # 11. content-kdf-over：主 streams 的 AES coder numCyclesPower=24
    specs["content-kdf-over.7z"] = build_7z(
        p64,
        plain_header([64], [[(M_AES, aes_props(KDF_CYCLES_OVER, SALT, IV))]], [[128]], ["a.txt"]),
    )
    return specs


# ---------------------------------------------------------------------------
# 独立解析（KAT 复算路径：从产物字节读出声明，不回填构造常量）
# ---------------------------------------------------------------------------

def lzma_dict_from_props(props: bytes) -> int:
    return int.from_bytes(props[1:5], "little")


def lzma2_dict_from_props(props: bytes) -> int:
    d = props[0]
    return (2 | (d & 1)) << (d // 2 + 11)


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
    if kind == "encoded":
        # 0x17 后跟 streams info（pack/unpack/substreams + END）
        folders, pos = parse_streams(nh, pos)
        names: list[str] = []
    else:
        if nh[pos] == K_MAIN_STREAMS_INFO:
            folders, pos = parse_streams(nh, pos + 1)
        else:
            folders = []
        if nh[pos] == K_FILES_INFO:
            num_files, pos = dec_num(nh, pos + 1)
            pos = parse_files_props(nh, pos, num_files)
        names = []
    if kind == "encoded":
        # 0x17 头在 streams info 的 K_END 处结束，无外层终止符
        if pos != len(nh):
            raise ValueError(f"encoded header 尾部多余字节 @ {pos}")
    else:
        if nh[pos] != K_END:
            raise ValueError(f"header 终止符错误 @ {pos}: {nh[pos]:#x}")

    out_coders: list[dict] = []
    for folder in folders:
        for coder in folder:
            entry = {
                "id": coder["id"].hex(),
                "props": coder["props"].hex() if coder["props"] is not None else None,
            }
            if coder["id"] == M_LZMA and coder["props"]:
                entry["declared_dict"] = lzma_dict_from_props(coder["props"])
            elif coder["id"] == M_LZMA2 and coder["props"]:
                entry["declared_dict"] = lzma2_dict_from_props(coder["props"])
            elif coder["id"] == M_AES and coder["props"]:
                entry["cycles_power"] = coder["props"][0] & 0x3F
                b0, b1 = coder["props"][0], coder["props"][1]
                entry["salt_size"] = ((b0 >> 7 & 1) << 4) + (b1 >> 4)
                entry["iv_size"] = ((b0 >> 6 & 1) << 4) + (b1 & 0x0F)
            out_coders.append(entry)
    return {
        "next_header": {"kind": kind, "offset": 32 + nh_offset, "size": nh_size},
        "num_folders": len(folders),
        "num_files": num_files,
        "coders": out_coders,
        "total_declared_dict": sum(
            c["declared_dict"] for c in out_coders if "declared_dict" in c
        ),
    }


def parse_streams(data: bytes, pos: int) -> tuple[list[list[dict]], int]:
    folders: list[list[dict]] = []
    nid = data[pos]
    pos += 1
    if nid == K_PACK_INFO:
        _, pos = dec_num(data, pos)  # pack_pos
        num_pack, pos = dec_num(data, pos)
        nid = data[pos]
        pos += 1
        if nid == K_SIZE:
            for _ in range(num_pack):
                _, pos = dec_num(data, pos)
            nid = data[pos]
            pos += 1
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
            for _ in range(len(folder)):
                _, pos = dec_num(data, pos)
        if data[pos] != K_END:
            raise ValueError("unpack info 终止符错误")
        pos += 1  # unpack info END
        if data[pos] == K_SUB_STREAMS:
            pos += 1
            # 最小 substreams：直接 END（缺省每 folder 1 unpack stream）
            if data[pos] != K_END:
                raise ValueError("substreams info 含生成器未写的属性")
            pos += 1
        if data[pos] != K_END:
            raise ValueError("streams info 终止符错误")
        pos += 1  # streams info END
    else:
        folders = []
        if nid != K_END:
            raise ValueError("streams info 终止符错误")
        pos -= 1  # 该 K_END 由上层 header 循环语义外消费，回退交由调用方判定
    return folders, pos


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
    "dict-oversize-lzma.7z": "plain header；LZMA coder 声明 dict=0xFFFFFFFF（4 GiB-1），预检须拒绝",
    "dict-oversize-lzma2.7z": "plain header；LZMA2 props=0x28 映射 dict=4 GiB，预检须拒绝",
    "dict-budget-oversum.7z": "plain header；3 folder × LZMA dict=512 MiB（单个均未超 u32 上限），合计 1.5 GiB 总预算拒绝载体",
    "header-encoded-oversize.7z": "encoded header（0x17）；header coder LZMA 声明 dict=0xFFFFFFFF，预检须递归进 encoded header 拒绝",
    "header-numfiles-over.7z": "plain header；kFilesInfo numFiles=10,000,000 且无 streams，预检须在条目分配前按数量拒绝",
    "header-copy.7z": "plain header；COPY coder（无 props）对照，预检应放行",
    "header-lzma.7z": "plain header；LZMA dict=64 KiB 对照，预检应放行",
    "header-delta-lzma2.7z": "plain header；[LZMA2(2 MiB), Delta(dist=1)] 链对照，预检应放行",
    "header-bcj-x86-lzma2.7z": "plain header；[LZMA2(2 MiB), BCJ-x86] 链对照，预检应放行",
    "header-kdf-over.7z": "encoded header；AES256SHA256 numCyclesPower=24（真实归档典型 19），header 解密预算拒绝载体",
    "content-kdf-over.7z": "plain header 主 streams；AES256SHA256 numCyclesPower=24，内容解密预算拒绝载体",
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
                      "coders", "total_declared_dict"):
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

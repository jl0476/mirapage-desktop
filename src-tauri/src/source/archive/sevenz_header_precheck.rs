//! 7z header 有界预检（任务 6）：自研受限 header decoder + 两阶段有界解析 + AES KDF。
//!
//! sevenz-rust 0.6.1 的 `SevenZReader::open` 在本模块能看到 `archive().folders` 之前就有
//! 前置分配路径（按不可信 `next_header_size` 建 Vec；encoded/encrypted header 还会按声明
//! unpack size resize 输出缓冲），folder 级 dictionary 检查保护不到——因此 7z 的内存边界
//! 分两层：
//!
//! 1. **打开前预检（本模块）**：调用 `SevenZReader::open` 之前执行有界解析，钳制三类数值
//!    （常量与 spec §4.5 逐字一致，见 [`MAX_NEXT_HEADER_BYTES`] 等）。
//!    - **定位**：32 字节签名头 + magic + start-header CRC32 校验；按规范
//!      `checked_add(SIGNATURE_HEADER_SIZE + next_header_offset, next_header_size)` 计算绝对
//!      区间，不做「从文件尾部猜测」。**有意的兼容性退化**：上游在 start-header 校验失败
//!      时会 `try_to_locale_end_header` 尾部搜索恢复，本模块收紧为直接拒绝（安全优先于
//!      损坏包恢复；回归用例断言 `bytes_scanned_total() == 32` 证明未做尾部扫描）。
//!    - **两阶段计数**：encoded header 自带外层 `StreamsInfo`，预检必须先解析它才能建立
//!      decoder。阶段一（外层，纯声明解析、零分配）：`numPackStreams/numFolders/numCoders`
//!      各 ≤ 4、packed 输入累加 ≤ 16 MiB、unpack 累加 ≤ 8 MiB、coder dictionary ≤ 8 MiB、
//!      AES cycles ≤ 24（0x3F 特殊分支放行）。阶段二（内层，受限解码后再解析）：folders/
//!      coders/substreams/numFiles 各 ≤ 100,000、pack sizes 累加 ≤ 文件长度——**内层不复用
//!      外层 4 条流水线上限**（单个 solid folder 含 5 张以上图片的正常包必须放行）。
//!    - **受限解码**：用阶段一验证过的参数构造 COPY / LZMA / LZMA2 / DELTA / BCJ（x86/ARM/
//!      ARMT/PPC/SPARC/IA64）/ AES-CBC 线性 coder 链，输出经声明 unpack size 硬上限约束；
//!      BCJ2 是多输入 coder graph，如实返回 `UnsupportedCodec`（显式声明的兼容性退化）。
//! 2. **folder 级检查**（`sevenz_backend`）：open 成功后、条目解码前逐 folder 解析
//!    dictionary 与 AES cycles（见 `sevenz_backend::folder_facts`）。
//!
//! **验收条件：任何按计数/尺寸驱动的 `Vec::with_capacity/resize` 发生之前拒绝。**

use crate::source::archive::backend::{ArchiveAccessError, MAX_CATALOG_ENTRIES};
use aes::cipher::{generic_array::GenericArray, BlockDecryptMut, KeyIvInit};
use sha2::Digest;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use zeroize::Zeroizing;

// ---------------------------------------------------------------------------
// 上限常量（spec §4.5 逐字）
// ---------------------------------------------------------------------------

/// next header 原始描述块上限（plain header 直接解析的 blob 尺寸）
pub(crate) const MAX_NEXT_HEADER_BYTES: u64 = 1024 * 1024; // 1 MiB
/// encoded header 解码后（内层属性流）的 unpack 累加上限
pub(crate) const MAX_ENCODED_HEADER_BYTES: u64 = 8 * 1024 * 1024; // 8 MiB
/// encoded header 解码链 coder dictionary 上限（SevenZWriter 默认 header LZMA dict
/// 恰为 8 MiB——判断必须用 `>` 而非 `>=`，否则合法 writer 产物被误拒）。
/// 32 MiB：实机验证（2026-08-26）py7zr 的 header 压缩流固定 16 MiB dict
/// （filters 参数只控数据流）——8 MiB 会拒掉整个 Python 生态产物，按 spec
/// 「真实样本证明不够再评估」条款放宽一档；仍防 GiB 级恶意声明。
pub(crate) const MAX_HEADER_DICT_BYTES: u64 = 32 * 1024 * 1024; // 32 MiB
/// encoded header 的 packed 输入总量上限（位于 32 + pack_pos 的独立 packed streams，
/// 不是 next-header 描述块自身：COPY coder 的 packed 尺寸 = 解码后尺寸，8 MiB 级
/// header 配 1 MiB 上限会把合法 encoded header 直接拒掉）
pub(crate) const MAX_HEADER_PACKED_BYTES: u64 = 16 * 1024 * 1024; // 16 MiB
/// AES KDF cycles 上限；`0x3F` 是无哈希特殊分支（salt||password 截断 32B 直作 key）放行
pub(crate) const MAX_KDF_CYCLES: u8 = 24;
pub(crate) const KDF_NO_HASH_CYCLES: u8 = 0x3F;

/// 阶段一外层流水线上限（encoded-header 解码管线，几条足够）
const OUTER_PIPELINE_LIMIT: u64 = 4;
/// 阶段二内层计数上限（不得复用外层 4——单个 solid folder 多文件正常包；
/// 与 MAX_CATALOG_ENTRIES 同值，spec 固定）
const INNER_STREAM_LIMIT: u64 = 100_000;

const SIGNATURE_HEADER_SIZE: u64 = 32;
const SEVEN_Z_SIGNATURE: [u8; 6] = *b"7z\xbc\xaf\x27\x1c";

// 7z header 属性 id（格式规范常量；sevenz-rust 0.6.1 archive.rs 同值但 pub(crate) 不可引）
const K_END: u8 = 0x00;
const K_HEADER: u8 = 0x01;
const K_ARCHIVE_PROPERTIES: u8 = 0x02;
const K_ADDITIONAL_STREAMS_INFO: u8 = 0x03;
const K_MAIN_STREAMS_INFO: u8 = 0x04;
const K_FILES_INFO: u8 = 0x05;
const K_PACK_INFO: u8 = 0x06;
const K_UNPACK_INFO: u8 = 0x07;
const K_SUB_STREAMS_INFO: u8 = 0x08;
const K_SIZE: u8 = 0x09;
const K_CRC: u8 = 0x0A;
const K_FOLDER: u8 = 0x0B;
const K_CODERS_UNPACK_SIZE: u8 = 0x0C;
const K_NUM_UNPACK_STREAM: u8 = 0x0D;
const K_ENCODED_HEADER: u8 = 0x17;

// ---------------------------------------------------------------------------
// CRC-32（ISO-HDLC，与 sevenz-rust CRC_32_ISO_HDLC / zlib.crc32 同值）
// ---------------------------------------------------------------------------

fn crc32(buf: &[u8]) -> u32 {
    fn table() -> &'static [u32; 256] {
        static TABLE: std::sync::OnceLock<[u32; 256]> = std::sync::OnceLock::new();
        TABLE.get_or_init(|| {
            let mut t = [0u32; 256];
            for (i, item) in t.iter_mut().enumerate() {
                let mut c = i as u32;
                for _ in 0..8 {
                    c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
                }
                *item = c;
            }
            t
        })
    }
    let mut c = 0xFFFF_FFFFu32;
    for &b in buf {
        c = table()[(c ^ b as u32) as usize & 0xFF] ^ (c >> 8);
    }
    c ^ 0xFFFF_FFFF
}

// ---------------------------------------------------------------------------
// 游标读取（有界解析的底层；所有越界都是 CorruptArchive）
// ---------------------------------------------------------------------------

struct Cursor<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }

    fn u8(&mut self) -> Result<u8, ArchiveAccessError> {
        let b = *self
            .buf
            .get(self.pos)
            .ok_or_else(|| corrupt("header 解析越界（u8）"))?;
        self.pos += 1;
        Ok(b)
    }

    fn u32le(&mut self) -> Result<u32, ArchiveAccessError> {
        let bytes = self.take(4)?;
        Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], ArchiveAccessError> {
        let end = self
            .pos
            .checked_add(n)
            .filter(|&e| e <= self.buf.len())
            .ok_or_else(|| corrupt("header 解析越界（take）"))?;
        let out = &self.buf[self.pos..end];
        self.pos = end;
        Ok(out)
    }

    fn skip(&mut self, n: u64) -> Result<(), ArchiveAccessError> {
        let n = usize::try_from(n).map_err(|_| corrupt("skip 长度超出 usize"))?;
        self.take(n).map(|_| ())
    }

    /// 7z 变长 number（镜像 sevenz-rust reader.rs `read_u64`）
    fn number(&mut self) -> Result<u64, ArchiveAccessError> {
        let first = self.u8()? as u64;
        let mut mask = 0x80u64;
        let mut value = 0u64;
        for i in 0..8 {
            if (first & mask) == 0 {
                return Ok(value | ((first & (mask - 1)) << (8 * i)));
            }
            let b = self.u8()? as u64;
            value |= b << (8 * i);
            mask >>= 1;
        }
        Ok(value)
    }

    /// all_defined 字节或逐位 bitfield（镜像 `read_all_or_bits`）；分配受上游计数上限约束
    fn all_or_bits(&mut self, size: usize) -> Result<Vec<bool>, ArchiveAccessError> {
        let all = self.u8()?;
        if all != 0 {
            return Ok(vec![true; size]);
        }
        let bits = self.take(size.div_ceil(8))?;
        Ok((0..size)
            .map(|i| bits[i / 8] & (0x80 >> (i % 8)) != 0)
            .collect())
    }
}

fn corrupt(msg: &str) -> ArchiveAccessError {
    ArchiveAccessError::CorruptArchive(msg.to_string())
}

fn over_limit(msg: impl Into<String>) -> ArchiveAccessError {
    ArchiveAccessError::ResourceLimitExceeded(msg.into())
}

// ---------------------------------------------------------------------------
// AES KDF 与 properties（对齐 7-Zip 7zAes.cpp 的 CKeyInfo::CalcKey / ReadProps）
// ---------------------------------------------------------------------------

/// 解析后的 AES coder properties：cycles + salt + 右侧补零到 16 bytes 的 IV。
pub(crate) struct AesProperties {
    pub cycles: u8,
    pub salt: Vec<u8>,
    pub iv16: [u8; 16],
}

/// 严格公式：`cycles = b0 & 0x3F`；`b0 & 0xC0 == 0` → properties **恰 1 字节**；否则
/// `salt_len = ((b0>>7)&1) + (b1>>4)`、`iv_len = ((b0>>6)&1) + (b1&0x0F)`（高位 +1，
/// 非 ×16——按错误公式实现时 b0=0x20 的恶意 fixture 会被错判长度），总长
/// `2 + salt_len + iv_len`，不符即 `CorruptArchive`。
pub(crate) fn parse_aes_properties(props: &[u8]) -> Result<AesProperties, ArchiveAccessError> {
    let b0 = *props.first().ok_or_else(|| corrupt("AES properties 为空"))?;
    let cycles = b0 & 0x3F;
    let (salt_len, iv_len) = if b0 & 0xC0 == 0 {
        if props.len() != 1 {
            return Err(corrupt("AES properties 高位 0 但长度非 1 字节"));
        }
        (0usize, 0usize)
    } else {
        let b1 = *props.get(1).ok_or_else(|| corrupt("AES properties 缺第二字节"))?;
        let salt_len = ((b0 >> 7) & 1) as usize + (b1 >> 4) as usize;
        let iv_len = ((b0 >> 6) & 1) as usize + (b1 & 0x0F) as usize;
        if props.len() != 2 + salt_len + iv_len {
            return Err(corrupt("AES properties 长度与 salt/iv 编码不符"));
        }
        (salt_len, iv_len)
    };
    if salt_len == 0 && iv_len == 0 {
        return Ok(AesProperties {
            cycles,
            salt: Vec::new(),
            iv16: [0u8; 16],
        });
    }
    let mut iv16 = [0u8; 16];
    iv16[..iv_len].copy_from_slice(&props[2 + salt_len..2 + salt_len + iv_len]);
    Ok(AesProperties {
        cycles,
        salt: props[2..2 + salt_len].to_vec(),
        iv16,
    })
}

/// KDF 成本上限：长度校验通过后、任何派生启动之前调用。`cycles ≤ 24` 或 `0x3F` 放行；
/// 不得直接比较 `properties[0]`——高两位非零的正常加密包（SevenZWriter 默认带 IV）会被误拒。
pub(crate) fn check_kdf_cycles(cycles: u8) -> Result<(), ArchiveAccessError> {
    if cycles > MAX_KDF_CYCLES && cycles != KDF_NO_HASH_CYCLES {
        return Err(over_limit(format!(
            "AES KDF cycles {cycles} exceeds limit {MAX_KDF_CYCLES}"
        )));
    }
    Ok(())
}

/// 密钥派生（任务简报伪代码逐字）。**单一 SHA-256 context**：每个 counter 都重新写入完整
/// `salt || password_utf16le || counter_le64`（salt 与 password 只在循环前写一次、或逐轮
/// digest 链式喂下一轮，都是错误实现——KAT 向量会对不上），全部 update 后只 finalize 一次。
/// `cycles == 0x3F` 分支：`salt || password` 截断/零填充到 32 bytes 直作 key（单次哈希都不执行）。
pub(crate) fn derive_key(
    salt: &[u8],
    password_utf16le: &Zeroizing<Vec<u8>>,
    cycles: u8,
) -> Zeroizing<[u8; 32]> {
    if cycles == KDF_NO_HASH_CYCLES {
        let mut key = Zeroizing::new([0u8; 32]);
        let material = salt.iter().chain(password_utf16le.iter()); // salt || password
        for (i, b) in material.take(32).enumerate() {
            key[i] = *b; // 截断/零填充到 32B
        }
        return key;
    }
    let mut hasher = sha2::Sha256::new(); // 唯一 context
    for counter in 0u64..(1u64 << cycles) {
        hasher.update(salt); // 每个 counter 都重写 salt
        hasher.update(password_utf16le); // 与 password——只写一次是错误实现
        hasher.update(counter.to_le_bytes()); // 再追加 counter，不 finalize
    }
    let digest = hasher.finalize(); // 只 finalize 一次
    Zeroizing::new(digest.into())
}

// ---------------------------------------------------------------------------
// 受限解码 stages：Delta / BCJ×6 / AES-CBC（LZMA/LZMA2/COPY 用 lzma-rust 直连）
// ---------------------------------------------------------------------------

/// Delta 反变换（镜像 sevenz-rust delta.rs 私有实现的语义；dist = props[0] + 1）
struct DeltaDecodeReader<R: Read> {
    inner: R,
    history: [u8; 256],
    pos: u8,
    distance: usize,
}

impl<R: Read> DeltaDecodeReader<R> {
    fn new(inner: R, distance: usize) -> Self {
        Self {
            inner,
            history: [0; 256],
            pos: 0,
            distance: distance.clamp(1, 256),
        }
    }
}

impl<R: Read> Read for DeltaDecodeReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        for item in &mut buf[..n] {
            let pos = self.pos as usize;
            let h = self.history[self.distance.wrapping_add(pos) & 0xFF];
            *item = item.wrapping_add(h);
            self.history[pos & 0xFF] = *item;
            self.pos = self.pos.wrapping_sub(1);
        }
        Ok(n)
    }
}

// ---- BCJ 反变换（x86/ARM/ARMT/PPC/SPARC 镜像 sevenz-rust bcj/*；IA64 镜像 xz 5.2
//      ia64.c——公有领域，Pavlov/Collin；上游 sevenz-rust 未实现 IA64） ----

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BcjArch {
    X86,
    Arm,
    ArmThumb,
    Ppc,
    Sparc,
    Ia64,
}

const X86_MASK_TO_ALLOWED_STATUS: [bool; 8] = [true, true, true, false, true, false, false, false];
const X86_MASK_TO_BIT_NUMBER: [u8; 8] = [0, 1, 2, 2, 3, 3, 3, 3];

/// BCJ 滤波器核心（编码/解码共用；`pos` 的初值因架构而异——镜像上游各 new_* 常量）。
pub(crate) struct BcjFilter {
    arch: BcjArch,
    is_encoder: bool,
    pos: usize,
    prev_mask: u32,
}

impl BcjFilter {
    pub(crate) fn new_decoder(arch: BcjArch) -> Self {
        Self::new(arch, false)
    }

    pub(crate) fn new(arch: BcjArch, encoder: bool) -> Self {
        let pos = match arch {
            BcjArch::X86 => 5,
            BcjArch::Arm => 8,
            BcjArch::ArmThumb => 4,
            BcjArch::Ppc | BcjArch::Sparc | BcjArch::Ia64 => 0,
        };
        Self {
            arch,
            is_encoder: encoder,
            pos,
            prev_mask: 0,
        }
    }

    /// 就地变换 `buf`，返回已过滤的前缀字节数（其余字节需与后续输入拼接再过滤）
    fn code(&mut self, buf: &mut [u8]) -> usize {
        match self.arch {
            BcjArch::X86 => self.x86_code(buf),
            BcjArch::Arm => self.arm_code(buf),
            BcjArch::ArmThumb => self.arm_thumb_code(buf),
            BcjArch::Ppc => self.ppc_code(buf),
            BcjArch::Sparc => self.sparc_code(buf),
            BcjArch::Ia64 => self.ia64_code(buf),
        }
    }

    fn x86_code(&mut self, buf: &mut [u8]) -> usize {
        #[inline(always)]
        fn test_86_ms_byte(b: u8) -> bool {
            b == 0x00 || b == 0xff
        }
        let len = buf.len();
        if len < 5 {
            return 0;
        }
        let end = len - 5;
        let mut prev_pos: isize = -1;
        let mut prev_mask = self.prev_mask;
        let mut i = 0usize;
        while i <= end {
            let b = buf[i];
            if b != 0xE9 && b != 0xE8 {
                i += 1;
                continue;
            }
            prev_pos = i as isize - prev_pos;
            if (prev_pos & !3) != 0 {
                prev_mask = 0;
            } else {
                prev_mask = (prev_mask << (prev_pos - 1)) & 7;
                if prev_mask != 0
                    && (!X86_MASK_TO_ALLOWED_STATUS[prev_mask as usize]
                        || test_86_ms_byte(buf[i + 4 - X86_MASK_TO_BIT_NUMBER[prev_mask as usize] as usize]))
                {
                    prev_pos = i as isize;
                    prev_mask = (prev_mask << 1) | 1;
                    i += 1;
                    continue;
                }
            }

            prev_pos = i as isize;
            if test_86_ms_byte(buf[i + 4]) {
                let mut src: i32 = (buf[i + 1] as i32)
                    | ((buf[i + 2] as i32) << 8)
                    | ((buf[i + 3] as i32) << 16)
                    | ((buf[i + 4] as i32) << 24);
                let mut dest: i32;
                loop {
                    if self.is_encoder {
                        dest = src.wrapping_add((self.pos + i) as i32);
                    } else {
                        dest = src.wrapping_sub((self.pos + i) as i32);
                    }

                    if prev_mask == 0 {
                        break;
                    }

                    let index = (X86_MASK_TO_BIT_NUMBER[prev_mask as usize] * 8) as i32;
                    if !test_86_ms_byte(((dest >> (24 - index)) & 0xff) as u8) {
                        break;
                    }

                    src = dest ^ ((1i32 << (32 - index)) - 1);
                }

                buf[i + 1] = dest as u8;
                buf[i + 2] = (dest >> 8) as u8;
                buf[i + 3] = (dest >> 16) as u8;
                buf[i + 4] = (!(((dest >> 24) & 1) - 1)) as u8;
                i += 4;
            } else {
                prev_mask = (prev_mask << 1) | 1;
            }
            i += 1;
        }

        prev_pos = i as isize - prev_pos;
        prev_mask = if (prev_pos & !3) != 0 {
            0
        } else {
            prev_mask << (prev_pos - 1)
        };

        self.prev_mask = prev_mask;
        self.pos += i;
        i
    }

    fn arm_code(&mut self, buf: &mut [u8]) -> usize {
        if buf.len() < 4 {
            return 0;
        }
        let end = buf.len() - 4;
        let mut i = 0;
        while i <= end {
            if buf[i + 3] == 0xEB {
                let src = (((buf[i + 2] as i32) << 16)
                    | ((buf[i + 1] as i32) << 8)
                    | (buf[i] as i32))
                    << 2;
                let p = (self.pos + i) as i32;
                let dest = if self.is_encoder {
                    src.wrapping_add(p)
                } else {
                    src.wrapping_sub(p)
                } >> 2;
                buf[i + 2] = ((dest >> 16) & 0xff) as u8;
                buf[i + 1] = ((dest >> 8) & 0xff) as u8;
                buf[i] = (dest & 0xff) as u8;
            }
            i += 4;
        }
        self.pos += i;
        i
    }

    fn arm_thumb_code(&mut self, buf: &mut [u8]) -> usize {
        if buf.len() < 4 {
            return 0;
        }
        let end = buf.len() - 4;
        let mut i = 0;
        while i <= end {
            let b1 = buf[i + 1] as i32;
            let b3 = buf[i + 3] as i32;
            if (b3 & 0xF8) == 0xF8 && (b1 & 0xF8) == 0xF0 {
                let b2 = buf[i + 2] as i32;
                let b0 = buf[i] as i32;
                let src = ((b1 & 0x07) << 19) | ((b0 & 0xFF) << 11) | ((b3 & 0x07) << 8) | (b2 & 0xFF);
                let src = src << 1;
                let dest = if self.is_encoder {
                    src.wrapping_add((self.pos + i) as i32)
                } else {
                    src.wrapping_sub((self.pos + i) as i32)
                } >> 1;
                buf[i + 1] = (0xF0 | ((dest >> 19) & 0x07)) as u8;
                buf[i] = (dest >> 11) as u8;
                buf[i + 3] = (0xf8 | ((dest >> 8) & 0x07)) as u8;
                buf[i + 2] = (dest & 0xff) as u8;
                i += 2;
            }
            i += 2;
        }
        self.pos += i;
        i
    }

    fn ppc_code(&mut self, buf: &mut [u8]) -> usize {
        if buf.len() < 4 {
            return 0;
        }
        let end = buf.len() - 4;
        let mut i = 0;
        while i <= end {
            let b3 = buf[i + 3] as i32;
            let b0 = buf[i] as i32;
            if (b0 & 0xFC) == 0x48 && (b3 & 0x03) == 0x01 {
                let b2 = buf[i + 2] as i32;
                let b1 = buf[i + 1] as i32;
                let src = ((b0 & 0x03) << 24) | ((b1 & 0xff) << 16) | ((b2 & 0xff) << 8) | (b3 & 0xFC);
                let p = (self.pos + i) as i32;
                let dest = if self.is_encoder {
                    src.wrapping_add(p)
                } else {
                    src.wrapping_sub(p)
                };
                buf[i] = (0x48 | ((dest >> 24) & 0x03)) as u8;
                buf[i + 1] = (dest >> 16) as u8;
                buf[i + 2] = (dest >> 8) as u8;
                buf[i + 3] = ((b3 & 0x03) | dest) as u8;
            }
            i += 4;
        }
        self.pos += i;
        i
    }

    fn sparc_code(&mut self, buf: &mut [u8]) -> usize {
        if buf.len() < 4 {
            return 0;
        }
        let end = buf.len() - 4;
        let mut i = 0;
        while i <= end {
            let b0 = buf[i] as i32;
            let b1 = buf[i + 1] as i32;
            if (b0 == 0x40 && (b1 & 0xC0) == 0x00) || (b0 == 0x7F && (b1 & 0xC0) == 0xC0) {
                let b2 = buf[i + 2] as i32;
                let b3 = buf[i + 3] as i32;
                let src = ((b0 & 0xFF) << 24) | ((b1 & 0xFF) << 16) | ((b2 & 0xFF) << 8) | (b3 & 0xFF);
                let src = src << 2;
                let p = (self.pos + i) as i32;
                let dest = if self.is_encoder {
                    src.wrapping_add(p)
                } else {
                    src.wrapping_sub(p)
                } >> 2;
                let dest = (((0i32.wrapping_sub((dest >> 22) & 1)) << 22) & 0x3FFFFFFF)
                    | (dest & 0x3FFFFF)
                    | 0x40000000;
                buf[i] = (dest >> 24) as u8;
                buf[i + 1] = (dest >> 16) as u8;
                buf[i + 2] = (dest >> 8) as u8;
                buf[i + 3] = dest as u8;
            }
            i += 4;
        }
        self.pos += i;
        i
    }

    /// IA64（镜像 xz 5.2 src/liblzma/simple/ia64.c——16 字节指令包 + 41 bit slot）
    fn ia64_code(&mut self, buf: &mut [u8]) -> usize {
        const BRANCH_TABLE: [u32; 32] = [
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 4, 6, 6, 0, 0, 7, 7, 4, 4, 0, 0,
            4, 4, 0, 0,
        ];
        let mut i = 0usize;
        while i + 16 <= buf.len() {
            let instr_template = (buf[i] & 0x1F) as u32;
            let mask = BRANCH_TABLE[instr_template as usize];
            let mut bit_pos: u32 = 5;
            for slot in 0..3 {
                if ((mask >> slot) & 1) != 0 {
                    let byte_pos = (bit_pos >> 3) as usize;
                    let bit_res = bit_pos & 7;
                    let mut instruction: u64 = 0;
                    for j in 0..6 {
                        instruction += (buf[i + j + byte_pos] as u64) << (8 * j);
                    }
                    let inst_norm = instruction >> bit_res;
                    if ((inst_norm >> 37) & 0xF) == 0x5 && ((inst_norm >> 9) & 0x7) == 0 {
                        let mut src = ((inst_norm >> 13) & 0xFFFFF) as u32;
                        src |= (((inst_norm >> 36) & 1) as u32) << 20;
                        let src = src << 4;
                        let dest = if self.is_encoder {
                            (self.pos as u32).wrapping_add(i as u32).wrapping_add(src)
                        } else {
                            src.wrapping_sub((self.pos as u32).wrapping_add(i as u32))
                        };
                        let dest = dest >> 4;
                        let mut inst_norm = inst_norm & !((0x8FFFFFu64) << 13);
                        inst_norm |= ((dest & 0xFFFFF) as u64) << 13;
                        inst_norm |= ((dest & 0x100000) as u64) << (36 - 20);
                        instruction &= (1u64 << bit_res) - 1;
                        instruction |= inst_norm << bit_res;
                        for j in 0..6 {
                            buf[i + j + byte_pos] = (instruction >> (8 * j)) as u8;
                        }
                    }
                }
                bit_pos += 41;
            }
            i += 16;
        }
        i
    }
}

/// 供单测直接做滤波级向量断言（编码/解码双向；decode(ENC)==RAW 且 encode(RAW)==ENC）。
#[cfg(test)]
pub(crate) fn bcj_filter_bytes(arch: BcjArch, encoder: bool, data: &mut [u8]) {
    let mut f = BcjFilter::new(arch, encoder);
    f.code(data);
}

const BCJ_FILTER_BUF_SIZE: usize = 4096;

/// BCJ 有缓冲 Reader（镜像 sevenz-rust bcj::SimpleReader 的 4096 状态机——
/// 跨 chunk 边界的指令模式必须经缓冲拼接才能正确过滤）
struct BcjSimpleReader<R: Read> {
    inner: R,
    filter: BcjFilter,
    filter_buf: Vec<u8>,
    pos: usize,      // filter_buf 内待输出位置
    filtered: usize, // 已过滤待输出字节数
    unfiltered: usize,
    end_reached: bool,
}

impl<R: Read> BcjSimpleReader<R> {
    fn new(inner: R, arch: BcjArch) -> Self {
        Self {
            inner,
            filter: BcjFilter::new_decoder(arch),
            filter_buf: vec![0; BCJ_FILTER_BUF_SIZE],
            pos: 0,
            filtered: 0,
            unfiltered: 0,
            end_reached: false,
        }
    }
}

impl<R: Read> Read for BcjSimpleReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        let mut len = buf.len();
        let mut off = 0usize;
        let mut size = 0usize;
        loop {
            if self.filtered > 0 {
                let copy_size = self.filtered.min(len);
                let pos = self.pos;
                buf[off..off + copy_size]
                    .copy_from_slice(&self.filter_buf[pos..pos + copy_size]);
                self.pos += copy_size;
                self.filtered -= copy_size;
                off += copy_size;
                len -= copy_size;
                size += copy_size;
            }
            // filter_buf 尾部到达时把未消费数据旋转到头部
            if self.pos + self.filtered + self.unfiltered == BCJ_FILTER_BUF_SIZE {
                self.filter_buf.rotate_left(self.pos);
                self.pos = 0;
            }
            if len == 0 || self.end_reached {
                return Ok(if size > 0 { size } else { 0 });
            }
            debug_assert_eq!(self.filtered, 0);
            let start = self.pos + self.unfiltered;
            let in_size = BCJ_FILTER_BUF_SIZE - start;
            let temp = &mut self.filter_buf[start..start + in_size];
            let in_size = match self.inner.read(temp) {
                Ok(s) => s,
                Err(e) => return Err(e),
            };
            if in_size == 0 {
                self.end_reached = true;
                self.filtered = self.unfiltered;
                self.unfiltered = 0;
            } else {
                self.unfiltered += in_size;
                let pos = self.pos;
                let unfiltered = self.unfiltered;
                self.filtered = self.filter.code(&mut self.filter_buf[pos..pos + unfiltered]);
                self.unfiltered -= self.filtered;
            }
        }
    }
}

// ---- AES-256-CBC stage（无 PKCS#7：7z 不使用该填充；按 coder 声明 unpack 截取输出） ----

type Aes256CbcDec = cbc::Decryptor<aes::Aes256>;

/// 密文非 16 字节对齐的专属错误形态：经 `io::Error` payload 传递，
/// `stage_read_error` downcast 识别后归 CorruptArchive（截断/损坏，与密码对错无关）。
#[derive(Debug)]
struct CiphertextMisaligned;

impl std::fmt::Display for CiphertextMisaligned {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("AES ciphertext not 16-byte aligned")
    }
}

impl std::error::Error for CiphertextMisaligned {}

/// 预检注入点：KDF 计数（测试）与生产实现。
pub(crate) type DeriveKeyFn =
    Arc<dyn Fn(&[u8], &Zeroizing<Vec<u8>>, u8) -> Zeroizing<[u8; 32]> + Send + Sync>;

struct AesCbcStageReader<R: Read> {
    inner: R,
    dec: Aes256CbcDec,
    pending: Vec<u8>,
    pos: usize,
    eof: bool,
    read_total: u64,
}

impl<R: Read> AesCbcStageReader<R> {
    fn new(
        inner: R,
        props: &AesProperties,
        password_utf16le: &Zeroizing<Vec<u8>>,
        derive: &DeriveKeyFn,
    ) -> Self {
        // derive_key 返回 Zeroizing<[u8;32]>；key schedule 拷贝后原 key 副本随即清零释放，
        // cipher 自身经 aes/zeroize feature 在 drop 时清除 key schedule（§5.2 生命周期约束）
        let key = derive(&props.salt, password_utf16le, props.cycles);
        let cipher = Aes256CbcDec::new(
            &GenericArray::from(*key),
            &GenericArray::from(props.iv16),
        );
        Self {
            inner,
            dec: cipher,
            pending: Vec::new(),
            pos: 0,
            eof: false,
            read_total: 0,
        }
    }

    fn refill(&mut self) -> std::io::Result<()> {
        debug_assert!(self.pos >= self.pending.len());
        self.pending.clear();
        self.pos = 0;
        // 按 16 字节块组读取：密文必须 16 字节对齐，非对齐（EOF 时余量 ≠ 0 mod 16）即损坏
        let mut chunk = [0u8; 16 * 256];
        let mut filled = 0usize;
        while filled < chunk.len() {
            match self.inner.read(&mut chunk[filled..]) {
                Ok(0) => break,
                Ok(n) => filled += n,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e),
            }
        }
        self.read_total += filled as u64;
        if filled == 0 {
            self.eof = true;
            return Ok(());
        }
        if filled % 16 != 0 {
            // 截断/损坏信号（不是密码错误）：携带专属 marker，stage_read_error downcast
            // 识别后归 CorruptArchive——正确密码下也不得被归一成 WrongPassword 反复重输
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                CiphertextMisaligned,
            ));
        }
        self.pending.extend_from_slice(&chunk[..filled]);
        for block in self.pending.chunks_exact_mut(16) {
            let b = GenericArray::from_mut_slice(block);
            self.dec.decrypt_block_mut(b); // 原始块解密，不走 decrypt_vec 等 PKCS#7 API
        }
        Ok(())
    }
}

impl<R: Read> Read for AesCbcStageReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        loop {
            if self.pos < self.pending.len() {
                let avail = self.pending.len() - self.pos;
                let n = avail.min(buf.len());
                buf[..n].copy_from_slice(&self.pending[self.pos..self.pos + n]);
                self.pos += n;
                return Ok(n);
            }
            if self.eof {
                return Ok(0);
            }
            self.refill()?;
        }
    }
}

// ---------------------------------------------------------------------------
// 阶段一：外层 encoded-header StreamsInfo（纯声明解析，任何 Vec 分配前完成全部数值校验）
// ---------------------------------------------------------------------------

struct OuterCoder {
    id: Vec<u8>,
    props: Vec<u8>,
}

struct OuterFolder {
    coders: Vec<OuterCoder>,
    /// (in_index, out_index)
    bind_pairs: Vec<(u64, u64)>,
    packed_streams: Vec<u64>,
    unpack_sizes: Vec<u64>,
    has_crc: bool,
    crc: u32,
}

struct OuterStreams {
    pack_pos: u64,
    pack_sizes: Vec<u64>,
    folders: Vec<OuterFolder>,
}

/// 外层 coder 兼容矩阵：id 一律与 `SevenZMethod::ID_*` 常量的字节合同比较。
/// 完整支持线性链 COPY/LZMA/LZMA2/DELTA/BCJ 六变体/AES；BCJ2（多输入 coder graph）
/// 显式 `UnsupportedCodec`（兼容性退化：上游能开 BCJ2 header 的包在本模块被拒并提示不支持）。
fn parse_outer_streams(
    cur: &mut Cursor<'_>,
    password: Option<&Zeroizing<Vec<u8>>>,
) -> Result<OuterStreams, ArchiveAccessError> {
    let mut out = OuterStreams {
        pack_pos: 0,
        pack_sizes: Vec::new(),
        folders: Vec::new(),
    };
    let mut nid = cur.u8()?;
    // PackInfo
    if nid == K_PACK_INFO {
        out.pack_pos = cur.number()?;
        let num_pack = cur.number()?;
        if num_pack > OUTER_PIPELINE_LIMIT {
            return Err(over_limit(format!(
                "encoded header pack streams {num_pack} exceed {OUTER_PIPELINE_LIMIT}"
            )));
        }
        nid = cur.u8()?;
        if nid == K_SIZE {
            let mut sum = 0u64;
            for _ in 0..num_pack {
                let s = cur.number()?;
                sum = sum
                    .checked_add(s)
                    .filter(|v| *v <= MAX_HEADER_PACKED_BYTES)
                    .ok_or_else(|| {
                        over_limit("encoded header packed bytes exceed MAX_HEADER_PACKED_BYTES")
                    })?;
                out.pack_sizes.push(s);
            }
            nid = cur.u8()?;
        }
        if nid == K_CRC {
            let defined = cur.all_or_bits(num_pack as usize)?;
            for d in defined {
                if d {
                    cur.u32le()?;
                }
            }
            nid = cur.u8()?;
        }
        if nid != K_END {
            return Err(corrupt("pack info 终止符错误"));
        }
        nid = cur.u8()?;
    }
    // UnpackInfo
    let mut folder_has_crc: Vec<bool> = Vec::new();
    if nid == K_UNPACK_INFO {
        if cur.u8()? != K_FOLDER {
            return Err(corrupt("unpack info 缺 kFolder"));
        }
        let num_folders = cur.number()?;
        if num_folders > OUTER_PIPELINE_LIMIT {
            return Err(over_limit(format!(
                "encoded header folders {num_folders} exceed {OUTER_PIPELINE_LIMIT}"
            )));
        }
        if cur.u8()? != 0 {
            return Err(corrupt("external folder 定义不支持"));
        }
        for _ in 0..num_folders {
            out.folders.push(parse_outer_folder(cur, password)?);
        }
        if cur.u8()? != K_CODERS_UNPACK_SIZE {
            return Err(corrupt("unpack info 缺 kCodersUnpackSize"));
        }
        let mut unpack_total = 0u64;
        for folder in &mut out.folders {
            for _ in 0..folder.coders.len() {
                let size = cur.number()?;
                unpack_total = unpack_total
                    .checked_add(size)
                    .filter(|v| *v <= MAX_ENCODED_HEADER_BYTES)
                    .ok_or_else(|| {
                        over_limit("encoded header unpack sizes exceed MAX_ENCODED_HEADER_BYTES")
                    })?;
                folder.unpack_sizes.push(size);
            }
        }
        folder_has_crc = vec![false; out.folders.len()];
        nid = cur.u8()?;
        if nid == K_CRC {
            let defined = cur.all_or_bits(out.folders.len())?;
            for (i, d) in defined.into_iter().enumerate() {
                if d {
                    folder_has_crc[i] = true;
                    out.folders[i].crc = cur.u32le()?;
                }
            }
            nid = cur.u8()?;
        }
        for (folder, has_crc) in out.folders.iter_mut().zip(&folder_has_crc) {
            folder.has_crc = *has_crc;
        }
        if nid != K_END {
            return Err(corrupt("unpack info 终止符错误"));
        }
        nid = cur.u8()?;
    } else {
        return Err(corrupt("encoded header 缺 unpack info"));
    }
    // SubStreamsInfo（外层计数已由 folder ≤ 4 约束；按缺省/显式两种形态走查）
    if nid == K_SUB_STREAMS_INFO {
        let mut substream_counts: Vec<u64> = vec![1; out.folders.len()];
        nid = cur.u8()?;
        if nid == K_NUM_UNPACK_STREAM {
            for slot in substream_counts.iter_mut() {
                *slot = cur.number()?;
            }
            nid = cur.u8()?;
        }
        if nid == K_SIZE {
            for n in &substream_counts {
                for _ in 0..n.saturating_sub(1) {
                    cur.number()?;
                }
            }
            nid = cur.u8()?;
        }
        if nid == K_CRC {
            let digest_count: usize = substream_counts
                .iter()
                .zip(folder_has_crc.iter())
                .map(|(n, has)| if *n != 1 || !*has { *n as usize } else { 0 })
                .sum();
            let defined = cur.all_or_bits(digest_count)?;
            for d in defined {
                if d {
                    cur.u32le()?;
                }
            }
            nid = cur.u8()?;
        }
        if nid != K_END {
            return Err(corrupt("substreams info 终止符错误"));
        }
        nid = cur.u8()?;
    }
    if nid != K_END {
        return Err(corrupt("streams info 终止符错误"));
    }
    Ok(out)
}

fn parse_outer_folder(
    cur: &mut Cursor<'_>,
    password: Option<&Zeroizing<Vec<u8>>>,
) -> Result<OuterFolder, ArchiveAccessError> {
    use sevenz_rust::SevenZMethod as M;
    let num_coders = cur.number()?;
    if num_coders > OUTER_PIPELINE_LIMIT {
        return Err(over_limit(format!(
            "encoded header folder coders {num_coders} exceed {OUTER_PIPELINE_LIMIT}"
        )));
    }
    let mut total_in: u64 = 0;
    let mut total_out: u64 = 0;
    let mut coders = Vec::new();
    for _ in 0..num_coders {
        let bits = cur.u8()?;
        let id_size = (bits & 0x0F) as usize;
        let is_simple = (bits & 0x10) == 0;
        let has_attributes = (bits & 0x20) != 0;
        let more_alternative_methods = (bits & 0x80) != 0;
        if more_alternative_methods {
            return Err(corrupt("alternative methods 不支持"));
        }
        let id = cur.take(id_size)?.to_vec();
        let (num_in, num_out) = if is_simple {
            (1u64, 1u64)
        } else {
            (cur.number()?, cur.number()?)
        };
        if num_in != 1 || num_out != 1 {
            // 多输入/输出 stream（BCJ2 coder graph 等）——受限线性解码器不支持
            return Err(ArchiveAccessError::UnsupportedCodec(format!(
                "multi input/output stream coder {:02x?}",
                id
            )));
        }
        let props = if has_attributes {
            let size = cur.number()?;
            let size = usize::try_from(size).map_err(|_| corrupt("props 长度超出 usize"))?;
            cur.take(size)?.to_vec()
        } else {
            Vec::new()
        };
        // ---- coder 兼容矩阵 + properties 校验（在构造任何 decoder 之前）----
        if id.as_slice() == M::ID_BCJ2 {
            return Err(ArchiveAccessError::UnsupportedCodec(
                "BCJ2 encoded header 不支持".into(),
            ));
        } else if id.as_slice() == M::ID_LZMA {
            if props.len() < 5 {
                return Err(corrupt("LZMA properties 过短"));
            }
            // 第 0 字节编码 lc/lp/pb——dictionary 是 props[1..5] 小端 u32（与官方 decoder 一致）
            let dict = u32::from_le_bytes([props[1], props[2], props[3], props[4]]) as u64;
            if dict > MAX_HEADER_DICT_BYTES {
                return Err(over_limit(format!(
                    "encoded header LZMA dictionary {dict} exceeds {MAX_HEADER_DICT_BYTES}"
                )));
            }
        } else if id.as_slice() == M::ID_LZMA2 {
            let dict = lzma2_dict_from_props(&props)?;
            if dict > MAX_HEADER_DICT_BYTES {
                return Err(over_limit(format!(
                    "encoded header LZMA2 dictionary {dict} exceeds {MAX_HEADER_DICT_BYTES}"
                )));
            }
        } else if id.as_slice() == M::ID_AES256SHA256 {
            // 判定与属性比较一律用完整 4 字节 ID（06 F1 07 01），不得手写截短 ID
            let aes = parse_aes_properties(&props)?;
            check_kdf_cycles(aes.cycles)?;
            if password.is_none() {
                return Err(ArchiveAccessError::PasswordRequired);
            }
        } else if !(id.as_slice() == M::ID_COPY
            || id.as_slice() == M::ID_DELTA
            || id.as_slice() == M::ID_BCJ_X86
            || id.as_slice() == M::ID_BCJ_ARM
            || id.as_slice() == M::ID_BCJ_ARM_THUMB
            || id.as_slice() == M::ID_BCJ_PPC
            || id.as_slice() == M::ID_BCJ_SPARC
            || id.as_slice() == M::ID_BCJ_IA64)
        {
            return Err(ArchiveAccessError::UnsupportedCodec(format!(
                "encoded header coder {:02x?} 不支持",
                id
            )));
        }
        total_in = total_in
            .checked_add(num_in)
            .ok_or_else(|| corrupt("total_in_streams 溢出"))?;
        total_out = total_out
            .checked_add(num_out)
            .ok_or_else(|| corrupt("total_out_streams 溢出"))?;
        coders.push(OuterCoder { id, props });
    }
    if total_out == 0 {
        return Err(corrupt("folder 输出 stream 数为 0"));
    }
    let num_bind_pairs = (total_out - 1) as usize;
    let mut bind_pairs = Vec::with_capacity(num_bind_pairs);
    for _ in 0..num_bind_pairs {
        let in_index = cur.number()?;
        let out_index = cur.number()?;
        bind_pairs.push((in_index, out_index));
    }
    if total_in < num_bind_pairs as u64 {
        return Err(corrupt("total_in_streams 小于 bind pair 数"));
    }
    let num_packed = (total_in - num_bind_pairs as u64) as usize;
    let mut packed_streams = vec![0u64; num_packed];
    if num_packed == 1 {
        // 7z 语义：单一 packed stream 隐式指向「未被 bind pair 消费的输入 stream」
        let mut index = u64::MAX;
        for i in 0..total_in {
            if !bind_pairs.iter().any(|(inp, _)| *inp == i) {
                index = i;
                break;
            }
        }
        if index == u64::MAX {
            return Err(corrupt("找不到 packed stream 的隐式索引"));
        }
        packed_streams[0] = index;
    } else {
        for slot in packed_streams.iter_mut() {
            *slot = cur.number()?;
        }
    }
    Ok(OuterFolder {
        coders,
        bind_pairs,
        packed_streams,
        unpack_sizes: Vec::new(),
        has_crc: false,
        crc: 0,
    })
}

/// LZMA2 props 档位查表（镜像 sevenz-rust decoders.rs get_lzma2_dic_size）
pub(crate) fn lzma2_dict_from_props(props: &[u8]) -> Result<u64, ArchiveAccessError> {
    let bits = *props.first().ok_or_else(|| corrupt("LZMA2 properties 为空"))? as u32;
    if (bits & !0x3F) != 0 {
        return Err(corrupt("LZMA2 properties 含不支持的高位"));
    }
    if bits > 40 {
        return Err(corrupt("LZMA2 dictionary 超过 4 GiB 上限"));
    }
    if bits == 40 {
        return Ok(0xFFFF_FFFF);
    }
    Ok(((2 | (bits & 0x1)) << (bits / 2 + 11)) as u64)
}

// ---------------------------------------------------------------------------
// 受限解码 encoded header（线性 coder 链；输出经声明 unpack size 硬上限约束）
// ---------------------------------------------------------------------------

fn decode_encoded_header(
    file: &mut std::fs::File,
    outer: &OuterStreams,
    file_len: u64,
    password: Option<&Zeroizing<Vec<u8>>>,
    hooks: &PrecheckHooks,
) -> Result<Vec<u8>, ArchiveAccessError> {
    let folder = outer
        .folders
        .first()
        .ok_or_else(|| corrupt("encoded header 无 folder"))?;
    let pack_size = *outer
        .pack_sizes
        .first()
        .ok_or_else(|| corrupt("encoded header 无 packed stream"))?;
    // pack_pos 与 stream 尺寸的绝对区间校验（checked_add；不做尾部扫描）
    let pack_start = SIGNATURE_HEADER_SIZE
        .checked_add(outer.pack_pos)
        .ok_or_else(|| corrupt("pack_pos 溢出"))?;
    let pack_end = pack_start
        .checked_add(pack_size)
        .filter(|v| *v <= file_len)
        .ok_or_else(|| corrupt("packed stream 区间越出文件长度"))?;
    file.seek(SeekFrom::Start(pack_start))
        .map_err(|e| ArchiveAccessError::Io(e.to_string()))?;
    let mut packed = vec![0u8; usize::try_from(pack_size).map_err(|_| corrupt("pack 尺寸溢出"))?];
    file.read_exact(&mut packed)
        .map_err(|e| ArchiveAccessError::Io(e.to_string()))?;
    hooks.bytes_scanned.fetch_add(pack_size, Ordering::Relaxed);

    let has_aes = folder
        .coders
        .iter()
        .any(|c| c.id.as_slice() == sevenz_rust::SevenZMethod::ID_AES256SHA256);
    // 链起点：pack stream 索引（线性链下 stream 索引与 coder 索引一致，镜像上游 ordered_coder_iter）
    let mut current = *folder
        .packed_streams
        .first()
        .ok_or_else(|| corrupt("folder 无 packed stream"))?
        as usize;
    let mut chain: Box<dyn Read> = Box::new(std::io::Cursor::new(packed));
    let mut steps = 0usize;
    loop {
        if steps > folder.coders.len() {
            return Err(corrupt("coder 链存在环"));
        }
        let coder = folder
            .coders
            .get(current)
            .ok_or_else(|| corrupt("coder 链索引越界"))?;
        let out_size = folder
            .unpack_sizes
            .get(current)
            .copied()
            .ok_or_else(|| corrupt("coder 链缺 unpack size"))?;
        chain = build_stage(chain, coder, out_size, password, has_aes, hooks)?;
        steps += 1;
        match folder
            .bind_pairs
            .iter()
            .find(|(_, out)| *out == current as u64)
        {
            Some((inp, _)) => current = *inp as usize,
            None => break,
        }
    }
    // 最终输出 stream 的声明大小 = 未被 bind pair 消费的最后一个 out（线性链即末段）
    let final_size = final_unpack_size(folder)?;
    let mut decoded = Vec::new();
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        let n = chain
            .read(&mut chunk)
            .map_err(|e| stage_read_error(e, has_aes, password.is_some()))?;
        if n == 0 {
            break;
        }
        // 7z 语义：声明 unpack size 是权威输出长度，达到即停。AES-CBC 等块对齐
        // coder 的密文含尾部填充，解密输出可多于声明值（py7zr header 加密实测：
        // 声明 189、块填充后密文/解密输出 192）——上游 sevenz-rust/7-Zip 均按
        // 声明值 take 截断而非报错。截断后内容真伪由下方 folder CRC 兜底；
        // 缓冲仍以 final_size 为硬上限（危险分配防线不变）。
        let remaining = final_size - decoded.len() as u64;
        if remaining == 0 {
            break;
        }
        let take = (n as u64).min(remaining) as usize;
        decoded.extend_from_slice(&chunk[..take]);
    }
    if folder.has_crc && crc32(&decoded) != folder.crc {
        return Err(corrupt("encoded header folder CRC 不匹配"));
    }
    Ok(decoded)
}

fn final_unpack_size(folder: &OuterFolder) -> Result<u64, ArchiveAccessError> {
    for i in (0..folder.coders.len()).rev() {
        if !folder.bind_pairs.iter().any(|(_, out)| *out == i as u64) {
            return folder
                .unpack_sizes
                .get(i)
                .copied()
                .ok_or_else(|| corrupt("folder 缺最终 unpack size"));
        }
    }
    Err(corrupt("folder 无最终输出 stream"))
}

fn build_stage(
    inner: Box<dyn Read>,
    coder: &OuterCoder,
    out_size: u64,
    password: Option<&Zeroizing<Vec<u8>>>,
    has_aes: bool,
    hooks: &PrecheckHooks,
) -> Result<Box<dyn Read>, ArchiveAccessError> {
    use sevenz_rust::SevenZMethod as M;
    let id = &coder.id[..];
    if id == M::ID_COPY {
        Ok(inner)
    } else if id == M::ID_LZMA {
        let dict = u32::from_le_bytes([
            coder.props[1], coder.props[2], coder.props[3], coder.props[4],
        ]);
        let r = sevenz_rust::lzma::LZMAReader::new_with_props(
            inner,
            out_size,
            coder.props[0],
            dict,
            None,
        )
        .map_err(|e| stage_read_error(e, has_aes, password.is_some()))?;
        Ok(Box::new(r))
    } else if id == M::ID_LZMA2 {
        let dict = lzma2_dict_from_props(&coder.props)? as u32;
        Ok(Box::new(sevenz_rust::lzma::LZMA2Reader::new(inner, dict, None)))
    } else if id == M::ID_DELTA {
        let dist = if coder.props.is_empty() {
            1
        } else {
            coder.props[0] as usize + 1
        };
        Ok(Box::new(DeltaDecodeReader::new(inner, dist)))
    } else if id == M::ID_BCJ_X86 {
        Ok(Box::new(BcjSimpleReader::new(inner, BcjArch::X86)))
    } else if id == M::ID_BCJ_ARM {
        Ok(Box::new(BcjSimpleReader::new(inner, BcjArch::Arm)))
    } else if id == M::ID_BCJ_ARM_THUMB {
        Ok(Box::new(BcjSimpleReader::new(inner, BcjArch::ArmThumb)))
    } else if id == M::ID_BCJ_PPC {
        Ok(Box::new(BcjSimpleReader::new(inner, BcjArch::Ppc)))
    } else if id == M::ID_BCJ_SPARC {
        Ok(Box::new(BcjSimpleReader::new(inner, BcjArch::Sparc)))
    } else if id == M::ID_BCJ_IA64 {
        Ok(Box::new(BcjSimpleReader::new(inner, BcjArch::Ia64)))
    } else if id == M::ID_AES256SHA256 {
        let props = parse_aes_properties(&coder.props)?;
        let pw = password.ok_or(ArchiveAccessError::PasswordRequired)?;
        Ok(Box::new(AesCbcStageReader::new(inner, &props, pw, &hooks.derive_key)))
    } else {
        Err(ArchiveAccessError::UnsupportedCodec(format!(
            "encoded header coder {id:02x?} 不支持"
        )))
    }
}

/// 解码阶段 io 错误分类：链上有 AES 且提供了密码时，垃圾输出多半是错密码 → WrongPassword；
/// 但非对齐密文（`CiphertextMisaligned` marker）是截断/损坏信号，正确密码下也不归 WrongPassword
fn stage_read_error(e: std::io::Error, has_aes: bool, has_password: bool) -> ArchiveAccessError {
    if e.get_ref()
        .and_then(|c| c.downcast_ref::<CiphertextMisaligned>())
        .is_some()
    {
        return corrupt(&format!("encoded header AES 密文非 16 字节对齐（截断/损坏）: {e}"));
    }
    if has_aes && has_password {
        ArchiveAccessError::WrongPassword
    } else {
        corrupt(&format!("encoded header 解码失败: {e}"))
    }
}

// ---------------------------------------------------------------------------
// 阶段二：header blob 有界解析（plain next header 与受限解码后的内层共用）
// ---------------------------------------------------------------------------

/// 解析 kHeader 正文（首字节 0x01 已消费）。**内层计数不复用外层 4 条流水线上限**。
fn parse_header_body(
    cur: &mut Cursor<'_>,
    file_len: u64,
) -> Result<(), ArchiveAccessError> {
    let mut nid = cur.u8()?;
    if nid == K_ARCHIVE_PROPERTIES {
        loop {
            let p_nid = cur.u8()?;
            if p_nid == K_END {
                break;
            }
            let size = cur.number()?;
            cur.skip(size)?;
        }
        nid = cur.u8()?;
    }
    if nid == K_ADDITIONAL_STREAMS_INFO {
        return Err(corrupt("additional streams info 不支持"));
    }
    if nid == K_MAIN_STREAMS_INFO {
        parse_inner_streams(cur, file_len)?;
        nid = cur.u8()?;
    }
    if nid == K_FILES_INFO {
        parse_inner_files(cur)?;
        nid = cur.u8()?;
    }
    if nid != K_END {
        return Err(corrupt("header 终止符错误"));
    }
    Ok(())
}

fn parse_inner_streams(
    cur: &mut Cursor<'_>,
    file_len: u64,
) -> Result<(), ArchiveAccessError> {
    let mut nid = cur.u8()?;
    let mut num_folders = 0usize;
    let mut folder_has_crc: Vec<bool> = Vec::new();
    if nid == K_PACK_INFO {
        let _pack_pos = cur.number()?;
        let num_pack = cur.number()?;
        if num_pack > INNER_STREAM_LIMIT {
            return Err(over_limit(format!(
                "pack streams {num_pack} exceed {INNER_STREAM_LIMIT}"
            )));
        }
        nid = cur.u8()?;
        if nid == K_SIZE {
            let mut sum = 0u64;
            for _ in 0..num_pack {
                let s = cur.number()?;
                sum = sum
                    .checked_add(s)
                    .ok_or_else(|| corrupt("pack sizes 累加溢出"))?;
            }
            // 内层 StreamsInfo 描述数据区：以实际文件大小为天然上界
            if sum > file_len {
                return Err(over_limit("pack sizes 累加超过文件长度"));
            }
            nid = cur.u8()?;
        }
        if nid == K_CRC {
            let defined = cur.all_or_bits(num_pack as usize)?;
            for d in defined {
                if d {
                    cur.u32le()?;
                }
            }
            nid = cur.u8()?;
        }
        if nid != K_END {
            return Err(corrupt("pack info 终止符错误"));
        }
        nid = cur.u8()?;
    }
    if nid == K_UNPACK_INFO {
        if cur.u8()? != K_FOLDER {
            return Err(corrupt("unpack info 缺 kFolder"));
        }
        num_folders = usize::try_from(cur.number()?)
            .map_err(|_| corrupt("num_folders 溢出"))?
            .min(usize::MAX);
        let num_folders_u64 = num_folders as u64;
        if num_folders_u64 > INNER_STREAM_LIMIT {
            return Err(over_limit(format!(
                "folders {num_folders} exceed {INNER_STREAM_LIMIT}"
            )));
        }
        if cur.u8()? != 0 {
            return Err(corrupt("external folder 定义不支持"));
        }
        let mut total_coders = 0usize;
        let mut folder_stream_counts: Vec<(u64, u64)> = Vec::with_capacity(num_folders);
        for _ in 0..num_folders {
            let (total_in, total_out) = parse_inner_folder(cur, &mut total_coders)?;
            folder_stream_counts.push((total_in, total_out));
        }
        let _ = total_coders;
        // 无条件初始化：substreams 的 num_digests 依赖每 folder has_crc（缺 folder CRC 段时全 false）
        folder_has_crc = vec![false; num_folders];
        if cur.u8()? != K_CODERS_UNPACK_SIZE {
            return Err(corrupt("unpack info 缺 kCodersUnpackSize"));
        }
        for (total_in, total_out) in &folder_stream_counts {
            let _ = total_in;
            for _ in 0..*total_out {
                cur.number()?; // 声明解压大小（数据区尺寸，不设上限——读取路径另有限额）
            }
        }
        nid = cur.u8()?;
        if nid == K_CRC {
            let defined = cur.all_or_bits(num_folders)?;
            for (i, d) in defined.into_iter().enumerate() {
                if d {
                    folder_has_crc[i] = true;
                    cur.u32le()?;
                }
            }
            nid = cur.u8()?;
        }
        if nid != K_END {
            return Err(corrupt("unpack info 终止符错误"));
        }
        nid = cur.u8()?;
    }
    if nid == K_SUB_STREAMS_INFO {
        // 内层 substream 计数 ≤ 100,000（不得复用外层 4——solid folder 多 substream 正常包）
        let mut substream_counts: Vec<u64> = vec![1; num_folders];
        nid = cur.u8()?;
        if nid == K_NUM_UNPACK_STREAM {
            let mut total = 0u64;
            for slot in substream_counts.iter_mut() {
                let n = cur.number()?;
                *slot = n;
                total = total
                    .checked_add(n)
                    .ok_or_else(|| corrupt("substream 计数溢出"))?;
            }
            if total > INNER_STREAM_LIMIT {
                return Err(over_limit(format!(
                    "substreams {total} exceed {INNER_STREAM_LIMIT}"
                )));
            }
            nid = cur.u8()?;
        }
        if nid == K_SIZE {
            for n in &substream_counts {
                for _ in 0..n.saturating_sub(1) {
                    cur.number()?;
                }
            }
            nid = cur.u8()?;
        }
        if nid == K_CRC {
            let num_digests: u64 = substream_counts
                .iter()
                .zip(folder_has_crc.iter())
                .map(|(n, has)| if *n != 1 || !*has { *n } else { 0 })
                .sum();
            if num_digests > INNER_STREAM_LIMIT {
                return Err(over_limit(format!(
                    "digests {num_digests} exceed {INNER_STREAM_LIMIT}"
                )));
            }
            let defined = cur.all_or_bits(num_digests as usize)?;
            for d in defined {
                if d {
                    cur.u32le()?;
                }
            }
            nid = cur.u8()?;
        }
        if nid != K_END {
            return Err(corrupt("substreams info 终止符错误"));
        }
        nid = cur.u8()?;
    }
    if nid != K_END {
        return Err(corrupt("streams info 终止符错误"));
    }
    Ok(())
}

/// 单个内层 folder 的结构走查（计数进 `total_coders`，由调用方检查总上限）
fn parse_inner_folder(
    cur: &mut Cursor<'_>,
    total_coders: &mut usize,
) -> Result<(u64, u64), ArchiveAccessError> {
    let num_coders = cur.number()?;
    *total_coders = total_coders
        .checked_add(usize::try_from(num_coders).map_err(|_| corrupt("num_coders 溢出"))?)
        .filter(|v| *v as u64 <= INNER_STREAM_LIMIT)
        .ok_or_else(|| over_limit(format!("total coders exceed {INNER_STREAM_LIMIT}")))?;
    let mut total_in: u64 = 0;
    let mut total_out: u64 = 0;
    for _ in 0..num_coders {
        let bits = cur.u8()?;
        let id_size = (bits & 0x0F) as usize;
        cur.take(id_size)?;
        let is_simple = (bits & 0x10) == 0;
        if !is_simple {
            total_in = total_in
                .checked_add(cur.number()?)
                .ok_or_else(|| corrupt("num_in_streams 溢出"))?;
            total_out = total_out
                .checked_add(cur.number()?)
                .ok_or_else(|| corrupt("num_out_streams 溢出"))?;
        } else {
            total_in += 1;
            total_out += 1;
        }
        if bits & 0x20 != 0 {
            let size = cur.number()?;
            cur.skip(size)?;
        }
        if bits & 0x80 != 0 {
            return Err(corrupt("alternative methods 不支持"));
        }
    }
    if total_out == 0 {
        return Err(corrupt("folder 输出 stream 数为 0"));
    }
    let num_bind_pairs = (total_out - 1) as usize;
    for _ in 0..num_bind_pairs {
        cur.number()?;
        cur.number()?;
    }
    if total_in < num_bind_pairs as u64 {
        return Err(corrupt("total_in_streams 小于 bind pair 数"));
    }
    let num_packed = total_in - num_bind_pairs as u64;
    if num_packed != 1 {
        for _ in 0..num_packed {
            cur.number()?;
        }
    }
    Ok((total_in, total_out))
}

fn parse_inner_files(cur: &mut Cursor<'_>) -> Result<(), ArchiveAccessError> {
    let num_files = cur.number()?;
    // **在条目分配之前**按数量拒绝（numFiles 是 Vec 分配的直接驱动）
    if num_files > MAX_CATALOG_ENTRIES as u64 {
        return Err(over_limit(format!(
            "numFiles {num_files} exceed MAX_CATALOG_ENTRIES {MAX_CATALOG_ENTRIES}"
        )));
    }
    // FilesInfo 属性按 (type, size) 成对走查、payload 按 size 有界跳过；
    // 名字/时间戳/位图等细结构交由上游 open 解析（其分配已被本上限约束）
    loop {
        let prop_type = cur.u8()?;
        if prop_type == K_END {
            return Ok(());
        }
        let size = cur.number()?;
        cur.skip(size)?;
    }
}

// ---------------------------------------------------------------------------
// 预检入口
// ---------------------------------------------------------------------------

/// 预检注入点（生产 derive_key / 测试计数包装；bytes_scanned 统计预检总读取量）。
#[derive(Clone)]
pub(crate) struct PrecheckHooks {
    pub derive_key: DeriveKeyFn,
    pub bytes_scanned: Arc<AtomicU64>,
}

impl Default for PrecheckHooks {
    fn default() -> Self {
        Self {
            derive_key: Arc::new(|salt, pw, cycles| derive_key(salt, pw, cycles)),
            bytes_scanned: Arc::new(AtomicU64::new(0)),
        }
    }
}

/// `SevenZReader::open` 之前的有界预检（唯一调用约定：backend 的 open_checked 先跑本函数）。
pub(crate) fn precheck(
    path: &Path,
    password: Option<&[u8]>,
    hooks: &PrecheckHooks,
) -> Result<(), ArchiveAccessError> {
    let password_utf16 = match password {
        Some(bytes) => Some(Zeroizing::new(sevenz_rust::Password::from(
            std::str::from_utf8(bytes).map_err(|_| ArchiveAccessError::WrongPassword)?,
        )
        .to_vec())),
        None => None,
    };
    let mut file = std::fs::File::open(path).map_err(|e| ArchiveAccessError::Io(e.to_string()))?;
    let file_len = file
        .metadata()
        .map_err(|e| ArchiveAccessError::Io(e.to_string()))?
        .len();
    let mut signature = [0u8; SIGNATURE_HEADER_SIZE as usize];
    // 读不足 32 字节 = 截断/损坏的压缩包（非 IO 故障）：映射 CorruptArchive，
    // 与后续所有「文件内容坏」错误同一模型，避免前端把坏包提示成 IO 问题
    file.read_exact(&mut signature)
        .map_err(|_| corrupt("7z 签名头不足 32 字节（截断）"))?;
    hooks
        .bytes_scanned
        .fetch_add(SIGNATURE_HEADER_SIZE, Ordering::Relaxed);
    if signature[0..6] != SEVEN_Z_SIGNATURE {
        return Err(corrupt("7z 签名不匹配"));
    }
    if signature[6] != 0 {
        return Err(corrupt("7z 主版本号非 0"));
    }
    let start_crc = u32::from_le_bytes([
        signature[8], signature[9], signature[10], signature[11],
    ]);
    // 有意的兼容性退化：不做 try_to_locale_end_header 尾部扫描，直接拒绝
    if crc32(&signature[12..32]) != start_crc {
        return Err(corrupt("start header CRC 不匹配"));
    }
    let nh_offset = u64::from_le_bytes(signature[12..20].try_into().unwrap());
    let nh_size = u64::from_le_bytes(signature[20..28].try_into().unwrap());
    let nh_crc = u32::from_le_bytes(signature[28..32].try_into().unwrap());
    if nh_size > MAX_NEXT_HEADER_BYTES {
        return Err(over_limit(format!(
            "next header size {nh_size} exceeds {MAX_NEXT_HEADER_BYTES}"
        )));
    }
    // 定位：按规范 checked_add 计算绝对区间，不从文件尾部猜测
    let nh_end = SIGNATURE_HEADER_SIZE
        .checked_add(nh_offset)
        .and_then(|v| v.checked_add(nh_size))
        .filter(|v| *v <= file_len)
        .ok_or_else(|| corrupt("next header 区间越出文件长度"))?;
    let nh_start = nh_end - nh_size;
    file.seek(SeekFrom::Start(nh_start))
        .map_err(|e| ArchiveAccessError::Io(e.to_string()))?;
    let mut blob = vec![0u8; nh_size as usize]; // ≤ 1 MiB，尺寸已查
    file.read_exact(&mut blob)
        .map_err(|e| ArchiveAccessError::Io(e.to_string()))?;
    hooks.bytes_scanned.fetch_add(nh_size, Ordering::Relaxed);
    if crc32(&blob) != nh_crc {
        return Err(corrupt("next header CRC 不匹配"));
    }
    // 空 NextHeader（nh_size == 0 且空数据 CRC 恰为 0 可通过校验）不是合法 7z：
    // 下方 blob[0] 会越界 panic——按损坏拒绝
    if blob.is_empty() {
        return Err(corrupt("next header 为空"));
    }
    match blob[0] {
        K_HEADER => {
            let mut cur = Cursor::new(&blob[1..]);
            parse_header_body(&mut cur, file_len)
        }
        K_ENCODED_HEADER => {
            let mut cur = Cursor::new(&blob[1..]);
            let outer = parse_outer_streams(&mut cur, password_utf16.as_ref())?;
            let decoded = decode_encoded_header(
                &mut file,
                &outer,
                file_len,
                password_utf16.as_ref(),
                hooks,
            )?;
            if decoded.first() != Some(&K_HEADER) {
                return Err(corrupt("解码后的 header 缺 kHeader"));
            }
            let mut cur = Cursor::new(&decoded[1..]);
            parse_header_body(&mut cur, file_len)
        }
        _ => Err(corrupt("broken or unsupported archive: no header")),
    }
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::test_support::PrecheckHarness;
    use super::*;
    use crate::source::archive::backend::ArchiveBackend as _;
    use crate::source::archive::backend::ArchiveInput;

    fn fixture_input(name: &str) -> ArchiveInput {
        ArchiveInput::Path(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests")
                .join("fixtures")
                .join("archive")
                .join(name),
        )
    }

    fn fixture_path(name: &str) -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("archive")
            .join(name)
    }

    // ---- KAT（任务简报两组向量；向量①期望值由 Python hashlib 独立实现 KAT 伪代码生成，
    //      与 7-Zip 24.09 7zAes.cpp CKeyInfo::CalcKey 双重核对；kat_vectors.json 为 fixture
    //      结构 KAT，KDF KAT 向量因首版脚本未产出而内嵌于此并注明来源）----

    /// `salt = b"SALT1234"`（8B）、`password = "test-pass-中文"`（UTF-16LE 24B）、cycles=19
    #[test]
    fn derive_key_matches_kat_cycles_19_vector() {
        let pw = Zeroizing::new(
            sevenz_rust::Password::from("test-pass-中文").to_vec(),
        );
        assert_eq!(pw.len(), 24); // 10 ASCII + 2 中文 BMP 字符 → UTF-16LE 24B
        let key = derive_key(b"SALT1234", &pw, 19);
        let expected: [u8; 32] = [
            0xed, 0x64, 0xf6, 0xd0, 0x02, 0xd3, 0x31, 0x2e, 0x10, 0x22, 0x53, 0xbc, 0x4a, 0x85,
            0x39, 0x70, 0x33, 0x8e, 0x39, 0xb2, 0x1c, 0x66, 0xa4, 0x8a, 0xd3, 0x89, 0x22, 0x7a,
            0xe3, 0x3e, 0xfa, 0x4b,
        ];
        assert_eq!(*key, expected);
    }

    /// cycles=0x3F：`salt || password` 截断/零填充到 32B 直作 key（本组恰 8+24=32 无填充）
    #[test]
    fn derive_key_0x3f_branch_is_truncated_salt_password() {
        let pw = Zeroizing::new(
            sevenz_rust::Password::from("test-pass-中文").to_vec(),
        );
        let key = derive_key(b"SALT1234", &pw, 0x3F);
        let mut expected = [0u8; 32];
        let material: Vec<u8> = b"SALT1234".iter().chain(pw.iter()).copied().collect();
        expected[..32].copy_from_slice(&material[..32]);
        assert_eq!(*key, expected);
        // 链式 digest / salt 只写一次的错误实现与本分支显式不同（另一分支已由向量①锁定）
    }

    // ---- AES properties 公式（精确字节合同）----

    #[test]
    fn aes_properties_formula_single_and_multi_byte() {
        // b0&0xC0==0 → 恰 1 字节（cycles=0x20=32）
        let p = parse_aes_properties(&[0x20]).unwrap();
        assert_eq!(p.cycles, 32);
        assert!(p.salt.is_empty());
        assert_eq!(p.iv16, [0u8; 16]);
        // 高位非零（SevenZWriter 默认 0xC8 0xFF + salt16 + iv16 = 34B）
        let mut props = vec![0xC8, 0xFF];
        props.extend_from_slice(&[7u8; 16]);
        props.extend_from_slice(&[9u8; 16]);
        let p = parse_aes_properties(&props).unwrap();
        assert_eq!(p.cycles, 8);
        assert_eq!(p.salt, vec![7u8; 16]);
        assert_eq!(&p.iv16[..16], &[9u8; 16]);
        // 长度与编码不符 → CorruptArchive（不是 ResourceLimitExceeded）：
        // b0=0x40 → iv_len=1，应总长 3 字节而实际只有 2
        assert!(matches!(
            parse_aes_properties(&[0x40, 0x00]),
            Err(ArchiveAccessError::CorruptArchive(_))
        ));
        assert!(matches!(
            parse_aes_properties(&[]),
            Err(ArchiveAccessError::CorruptArchive(_))
        ));
    }

    #[test]
    fn kdf_cycles_boundary_is_extracted_not_raw_byte() {
        // 不得直接比较 properties[0]：0xC8 的原始字节 > 24 但 cycles=8 应放行
        assert!(check_kdf_cycles(24).is_ok());
        assert!(matches!(check_kdf_cycles(25), Err(ArchiveAccessError::ResourceLimitExceeded(_))));
        assert!(check_kdf_cycles(0x3F).is_ok());
    }

    // ---- BCJ 六架构独立向量（Python 镜像生成：sevenz-rust bcj/* + xz 5.2 ia64.c）----

    const BCJ_RAW_X86: &[u8] =
        &[232, 16, 0, 0, 0, 144, 144, 144, 233, 224, 255, 255, 255, 81, 82];
    const BCJ_ENC_X86: &[u8] =
        &[232, 21, 0, 0, 0, 144, 144, 144, 233, 237, 255, 255, 255, 81, 82];
    const BCJ_RAW_ARM: &[u8] = &[0, 1, 0, 235, 80, 65, 68, 33, 64, 48, 32, 235];
    const BCJ_ENC_ARM: &[u8] = &[2, 1, 0, 235, 80, 65, 68, 33, 68, 48, 32, 235];
    const BCJ_RAW_ARM_THUMB: &[u8] = &[0, 240, 0, 248, 84, 80, 65, 68, 52, 243, 18, 248];
    const BCJ_ENC_ARM_THUMB: &[u8] = &[0, 240, 2, 248, 84, 80, 65, 68, 52, 243, 24, 248];
    const BCJ_RAW_PPC: &[u8] = &[72, 0, 16, 1, 80, 80, 65, 68, 75, 255, 255, 1];
    const BCJ_ENC_PPC: &[u8] = &[72, 0, 16, 1, 80, 80, 65, 68, 75, 255, 255, 9];
    const BCJ_RAW_SPARC: &[u8] = &[64, 0, 0, 8, 83, 80, 65, 68, 127, 192, 0, 16];
    const BCJ_ENC_SPARC: &[u8] = &[64, 0, 0, 8, 83, 80, 65, 68, 127, 192, 0, 18];
    const BCJ_RAW_IA64: &[u8] = &[
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 22, 0, 20, 141, 4, 22, 0, 40, 26, 9, 44,
        0, 80, 52, 18, 88,
    ];
    const BCJ_ENC_IA64: &[u8] = &[
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 22, 0, 24, 141, 4, 22, 0, 48, 26, 9, 44,
        0, 96, 52, 18, 88,
    ];

    #[test]
    fn bcj_decode_and_encode_match_reference_vectors() {
        let cases: [(BcjArch, &[u8], &[u8]); 6] = [
            (BcjArch::X86, BCJ_RAW_X86, BCJ_ENC_X86),
            (BcjArch::Arm, BCJ_RAW_ARM, BCJ_ENC_ARM),
            (BcjArch::ArmThumb, BCJ_RAW_ARM_THUMB, BCJ_ENC_ARM_THUMB),
            (BcjArch::Ppc, BCJ_RAW_PPC, BCJ_ENC_PPC),
            (BcjArch::Sparc, BCJ_RAW_SPARC, BCJ_ENC_SPARC),
            (BcjArch::Ia64, BCJ_RAW_IA64, BCJ_ENC_IA64),
        ];
        for (arch, raw, enc) in cases {
            let mut decoded = enc.to_vec();
            bcj_filter_bytes(arch, false, &mut decoded);
            assert_eq!(decoded, raw, "{arch:?} decode(ENC) != RAW");
            let mut encoded = raw.to_vec();
            bcj_filter_bytes(arch, true, &mut encoded);
            assert_eq!(encoded, enc, "{arch:?} encode(RAW) != ENC");
        }
    }

    #[test]
    fn bcj_buffered_reader_decodes_across_chunk_boundary() {
        // BcjSimpleReader 的 4096 缓冲状态机：跨越 chunk 边界的指令仍正确反变换。
        // BCJ 转换是位置敏感的——先对复合流整体编码（同一 Rust 实现的 encode 方向），
        // 再经有缓冲 Reader 解码，两者必须在任意 chunk 划分下互逆。
        let mut composite = BCJ_RAW_X86.to_vec();
        composite.extend_from_slice(&[0u8; 8192]);
        composite.extend_from_slice(BCJ_RAW_X86);
        let mut encoded = composite.clone();
        bcj_filter_bytes(BcjArch::X86, true, &mut encoded);
        assert_ne!(encoded, composite); // 复合流里确有被转换的指令
        let mut reader = BcjSimpleReader::new(std::io::Cursor::new(encoded), BcjArch::X86);
        let mut out = Vec::new();
        reader.read_to_end(&mut out).unwrap();
        assert_eq!(out, composite);
    }

    // ---- Delta 反变换语义 ----

    #[test]
    fn delta_decode_restores_incremented_history() {
        // dist=1：decode([10,2,0]) == [10,12,12]（首字节走零历史，其后逐步累加）
        let mut reader = DeltaDecodeReader::new(std::io::Cursor::new(vec![10u8, 2, 0]), 1);
        let mut out = Vec::new();
        reader.read_to_end(&mut out).unwrap();
        assert_eq!(out, vec![10, 12, 12]);
    }

    // ---- 预检防线（走生产 open_checked 链路，注入计数 opener）----

    #[test]
    fn sevenz_precheck_rejects_oversized_encoded_header_and_numfiles_before_open() {
        // 走生产链路 open_checked（SevenZBackend 唯一的 open 入口，内部先 precheck 再调
        // 注入的计数 opener），不是只调 precheck——否则 open_call_count 恒为 0，测试恒真。
        let harness = PrecheckHarness::with_counting_opener();
        // 合法 fixture 对照：预检通过、open 恰好被调用一次（证明计数器与链路本身工作）
        let (_guard_ok, ok) = crate::source::archive::sevenz_backend::tests::create_7z(false, None);
        assert!(harness.open_checked(&ArchiveInput::Path(ok)).is_ok());
        assert_eq!(harness.open_call_count(), 1);
        // 恶意 fixture：在 SevenZReader::open 之前（含 header 解码路径）拒绝
        assert!(matches!(
            harness.open_checked(&fixture_input("header-encoded-oversize.7z")),
            Err(ArchiveAccessError::ResourceLimitExceeded(_))
        ));
        assert!(matches!(
            harness.open_checked(&fixture_input("header-numfiles-over.7z")),
            Err(ArchiveAccessError::ResourceLimitExceeded(_))
        ));
        assert_eq!(harness.open_call_count(), 1); // 两个恶意包都没有再触发 open
    }

    #[test]
    fn sevenz_solid_folder_with_many_files_passes_precheck() {
        // 内层计数不得复用外层 4 条流水线上限：单个 solid folder 含 6 个文件（> 4）的正常包
        // 必须通过预检——否则会拒绝正常的 solid 漫画包。用 solid 专用 helper（push_source_path
        // 同一 pack/folder，create_7z_with_files 是逐条目 non-solid，证明不了本合同）
        let (_guard, path) = crate::source::archive::sevenz_backend::tests::create_solid_7z_with_files(
            &["p0.png", "p1.png", "p2.png", "p3.png", "p4.png", "p5.png"],
            None,
            false,
        );
        let harness = PrecheckHarness::with_counting_opener();
        assert!(harness.open_checked(&ArchiveInput::Path(path.clone())).is_ok());
        assert_eq!(harness.open_call_count(), 1);
        // 打开后的 archive 验证（sevenz-rust 0.6.1 公开 API；SubStreamsInfo 公开字段只有
        // unpack_sizes/has_crc/crcs——没有 num_unpack_streams）：单 folder + 6 个数据
        // substream 以 unpack_sizes.len() == 6 证明
        let reader =
            sevenz_rust::SevenZReader::open(&path, sevenz_rust::Password::empty()).unwrap();
        assert_eq!(reader.archive().folders.len(), 1);
        let sizes = reader
            .archive()
            .sub_streams_info
            .as_ref()
            .map(|s| &s.unpack_sizes)
            .expect("solid folder 必有 sub_streams_info");
        assert_eq!(sizes.len(), 6); // SubStreamsInfo::unpack_sizes 直接按 substream 展开
    }

    #[test]
    fn sevenz_precheck_rejects_corrupt_start_header_without_tail_scan() {
        // 有意兼容性退化的回归：上游会 try_to_locale_end_header 尾部搜索，本模块直接拒绝。
        // 在内存中翻转固定 fixture 的 start-header CRC 字节后落盘（不改 24 个哈希清单）；
        // 同样走生产 open_checked 链路（注入计数 opener），不直接调 precheck
        let corrupted = test_support::flip_start_header_crc(&fixture_path("header-encoded-oversize.7z"));
        let harness = PrecheckHarness::with_counting_opener();
        assert!(matches!(
            harness.open_checked(&ArchiveInput::Path(corrupted)),
            Err(ArchiveAccessError::CorruptArchive(_))
        ));
        assert_eq!(harness.open_call_count(), 0);
        // 仅签名头 32 字节；计数合同＝预检总读取量，尾部扫描会使其远大于 32
        assert_eq!(harness.bytes_scanned_total(), 32);
    }

    #[test]
    fn sevenz_legal_encoded_header_variants_pass_full_chain() {
        // 四个合法 encoded 变体（COPY / LZMA / DELTA+LZMA2 / BCJ-x86+LZMA2）走
        // open_checked → catalog 完整链路：预检通过、open 恰一次、catalog 结果正确
        for fixture in [
            "header-copy.7z",
            "header-lzma.7z",
            "header-delta-lzma2.7z",
            "header-bcj-x86-lzma2.7z",
        ] {
            let harness = PrecheckHarness::with_counting_opener();
            assert!(
                harness.open_checked(&fixture_input(fixture)).is_ok(),
                "{fixture} 预检应放行"
            );
            assert_eq!(harness.open_call_count(), 1, "{fixture}");
            let catalog = crate::source::archive::sevenz_backend::SevenZBackend
                .catalog(&fixture_input(fixture), "", None)
                .unwrap();
            assert_eq!(catalog.entries.len(), 1, "{fixture}");
            assert_eq!(catalog.entries[0].name, "page.png", "{fixture}");
        }
    }

    #[test]
    fn sevenz_precheck_rejects_oversized_kdf_cycles_before_derivation() {
        // 合法加密对照：SevenZWriter 实际产出的 AES properties 高位非零（默认带 IV），
        // 经 & 0x3F 提取后放行——显式传密码打开，验证自研 header derive_key 被真实调用
        //（快照比较；entry 路径的库内 KDF 不在本计数范围，见 harness 合同）
        let (_guard_ok, ok) =
            crate::source::archive::sevenz_backend::tests::create_7z(true, Some("test-pass-中文"));
        let probe_harness = PrecheckHarness::with_counting_opener();
        let kdf_before = probe_harness.header_kdf_invocations();
        assert!(probe_harness
            .open_checked_with_password(&ArchiveInput::Path(ok), "test-pass-中文")
            .is_ok());
        assert!(probe_harness.header_kdf_invocations() > kdf_before); // 合法包确实走了派生
        // 恶意 fixture：用全新 harness（计数从零），断言本次调用没有增加派生计数
        let harness = PrecheckHarness::with_counting_opener();
        assert!(matches!(
            harness.open_checked_with_password(&fixture_input("header-kdf-over.7z"), "any"),
            Err(ArchiveAccessError::ResourceLimitExceeded(_))
        ));
        assert_eq!(harness.header_kdf_invocations(), 0); // 自研 header 派生从未启动
    }

    #[test]
    fn sevenz_folder_kdf_guard_rejects_before_entry_derivation() {
        // folder 级路径（raw kHeader、header 可见）：数据 folder 的 AES cycles 超限，
        // probe 阶段即拒——断言语义是"拒绝发生在本模块调用条目解码入口之前"，
        // 不直接观测 sevenz-rust 库内 KDF（无注入点）
        let harness = PrecheckHarness::with_counting_opener();
        assert!(matches!(
            harness.probe_with_password(&fixture_input("content-kdf-over.7z"), "", "any"),
            Err(ArchiveAccessError::ResourceLimitExceeded(_))
        ));
        assert_eq!(harness.entry_decoder_calls(), 0);
    }

    // ---- 定位与 blob 上限的纯预检级测试 ----

    fn run_precheck(path: &std::path::Path) -> Result<(), ArchiveAccessError> {
        precheck(path, None, &PrecheckHooks::default())
    }

    #[test]
    fn sevenz_precheck_rejects_oversized_next_header_declaration() {
        // start header 声明 next_header_size > 1 MiB（手写畸形签名头）
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("oversize-nh.7z");
        let nh_offset = 0u64;
        let nh_size: u64 = MAX_NEXT_HEADER_BYTES + 1;
        let nh_crc = 0u32;
        let mut start = Vec::new();
        start.extend_from_slice(&nh_offset.to_le_bytes());
        start.extend_from_slice(&nh_size.to_le_bytes());
        start.extend_from_slice(&nh_crc.to_le_bytes());
        let mut file = Vec::new();
        file.extend_from_slice(&SEVEN_Z_SIGNATURE);
        file.extend_from_slice(&[0, 4]);
        file.extend_from_slice(&crc32(&start).to_le_bytes());
        file.extend_from_slice(&start);
        std::fs::write(&path, file).unwrap();
        assert!(matches!(
            run_precheck(&path),
            Err(ArchiveAccessError::ResourceLimitExceeded(_))
        ));
    }

    #[test]
    fn sevenz_precheck_rejects_empty_next_header_instead_of_panicking() {
        // nh_size == 0 且 nh_crc == 0（空数据 CRC32 恰为 0）可同时通过 start CRC 与
        // blob CRC 校验——修复前 blob[0] 直接越界 panic。空 NextHeader 按损坏拒绝。
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty-nh.7z");
        let start = {
            let mut s = Vec::new();
            s.extend_from_slice(&0u64.to_le_bytes()); // offset
            s.extend_from_slice(&0u64.to_le_bytes()); // size == 0
            s.extend_from_slice(&0u32.to_le_bytes()); // crc32(&[]) == 0
            s
        };
        let mut file = Vec::new();
        file.extend_from_slice(&SEVEN_Z_SIGNATURE);
        file.extend_from_slice(&[0, 4]);
        file.extend_from_slice(&crc32(&start).to_le_bytes());
        file.extend_from_slice(&start);
        std::fs::write(&path, file).unwrap();
        assert!(matches!(
            run_precheck(&path),
            Err(ArchiveAccessError::CorruptArchive(_))
        ));
    }

    #[test]
    fn sevenz_precheck_classifies_truncated_signature_as_corrupt_not_io() {
        // 不足 32 字节的本地文件 = 截断/损坏（非 IO 故障）——修复前 read_exact 的
        // UnexpectedEof 被映射为 Io，前端会提示 IO 问题而非坏包
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("truncated.7z");
        std::fs::write(&path, b"7z\xbc\xaf\x27\x1c\x00\x04\x12").unwrap(); // 9 字节
        match run_precheck(&path) {
            Err(ArchiveAccessError::CorruptArchive(_)) => {}
            other => panic!("截断文件应为 CorruptArchive，实际 {other:?}"),
        }
    }

    #[test]
    fn sevenz_precheck_rejects_next_header_range_beyond_file() {
        // next_header_offset + size 越出文件长度（checked_add 定位检查）
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("range.7z");
        let start = {
            let mut s = Vec::new();
            s.extend_from_slice(&100u64.to_le_bytes()); // offset
            s.extend_from_slice(&16u64.to_le_bytes()); // size
            s.extend_from_slice(&0u32.to_le_bytes());
            s
        };
        let mut file = Vec::new();
        file.extend_from_slice(&SEVEN_Z_SIGNATURE);
        file.extend_from_slice(&[0, 4]);
        file.extend_from_slice(&crc32(&start).to_le_bytes());
        file.extend_from_slice(&start);
        std::fs::write(&path, file).unwrap(); // 文件仅 52 字节，区间 132..148 越界
        assert!(matches!(
            run_precheck(&path),
            Err(ArchiveAccessError::CorruptArchive(_))
        ));
    }

    #[test]
    fn sevenz_precheck_classifies_misaligned_aes_ciphertext_as_corrupt_not_wrong_password() {
        // 负例：带 AES 的 encoded header 声明 pack_size=17（非 16 字节对齐——截断/损坏形态）。
        // 字节级构造（镜像 gen_declared_dict.py 的 encoded_header / write_streams_info 布局），
        // 本 fixture 所有 number 均小于 0x80，7z 变长 number 恒单字节。
        const M_AES: [u8; 4] = [0x06, 0xF1, 0x07, 0x01];
        let pack = [0xABu8; 17];
        let mut nh = vec![K_ENCODED_HEADER];
        // PackInfo：kPackInfo pack_pos=0 num=1 kSize sizes=[17] kEnd
        nh.extend_from_slice(&[
            K_PACK_INFO,
            0,
            1,
            K_SIZE,
            pack.len() as u8,
            K_END,
        ]);
        // UnpackInfo：kUnpackInfo kFolder num=1 external=0
        nh.extend_from_slice(&[K_UNPACK_INFO, K_FOLDER, 1, 0]);
        //   folder：num_coders=1；flags=|id|=4|0x20；id=AES256SHA256；props_len=1；
        //   props=[0x01]（cycles=1 ≤ 24 且高位 0 → 恰 1 字节，KDF 防线放行）；无 bind pair
        nh.push(1);
        nh.push(0x04 | 0x20);
        nh.extend_from_slice(&M_AES);
        nh.extend_from_slice(&[1, 0x01]);
        //   kCodersUnpackSize sizes=[128] kEnd
        nh.extend_from_slice(&[K_CODERS_UNPACK_SIZE, 128, K_END]);
        // SubStreamsInfo 缺省形态（每 folder 1 stream、无 CRC）+ streams info 终止
        nh.extend_from_slice(&[K_SUB_STREAMS_INFO, K_END, K_END]);

        let mut start = Vec::new();
        start.extend_from_slice(&(pack.len() as u64).to_le_bytes());
        start.extend_from_slice(&(nh.len() as u64).to_le_bytes());
        start.extend_from_slice(&crc32(&nh).to_le_bytes());
        let mut file = Vec::new();
        file.extend_from_slice(&SEVEN_Z_SIGNATURE);
        file.extend_from_slice(&[0, 4]);
        file.extend_from_slice(&crc32(&start).to_le_bytes());
        file.extend_from_slice(&start);
        file.extend_from_slice(&pack);
        file.extend_from_slice(&nh);

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("misaligned-aes.7z");
        std::fs::write(&path, file).unwrap();
        // 供了密码且链上有 AES 的旧分类会归 WrongPassword；非对齐必须归 CorruptArchive
        let err = precheck(&path, Some(b"any"), &PrecheckHooks::default()).unwrap_err();
        assert!(
            matches!(err, ArchiveAccessError::CorruptArchive(_)),
            "非对齐密文应归 CorruptArchive，实际 {err:?}"
        );
        assert_ne!(err, ArchiveAccessError::WrongPassword);
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use crate::source::archive::backend::{ArchiveAccessError, ArchiveInput, ArchiveProbe};
    use crate::source::archive::sevenz_backend::{LimitedSevenZBackend, SevenZBackend, SevenzHooks};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
    use std::sync::Arc;

    /// 预检测试 harness——计数器只统计**本模块可观测的边界**，不声称能统计依赖库
    /// （sevenz-rust）内部的 KDF：
    /// - open_checked / open_checked_with_password：SevenZBackend 唯一 open 入口——内部先跑
    ///   两阶段预检（密码经参数或 harness 默认传入），通过后调用注入的 opener。
    /// - probe_with_password：folder 级 KDF 防线的 probe 入口。
    /// - with_counting_opener：注入计数 opener；open_call_count 返回 opener 被调用次数。
    /// - header_kdf_invocations：自研 header decoder 的 derive_key 被注入计数实现替换后的
    ///   **真实调用次数**（自研路径有注入点）。
    /// - entry_decoder_calls：本模块调用 sevenz-rust 条目解码入口（for_each_entries）的次数
    ///   ——folder 级防线的断言语义是"超限拒绝发生在该调用**之前**"。
    /// - bytes_scanned_total：预检的总读取字节数（断言"未做尾部扫描"）。
    pub(crate) struct PrecheckHarness {
        backend: LimitedSevenZBackend,
        opens: Arc<AtomicUsize>,
        kdf: Arc<AtomicUsize>,
        entry_decodes: Arc<AtomicUsize>,
        scanned: Arc<AtomicU64>,
    }

    impl PrecheckHarness {
        pub fn with_counting_opener() -> Self {
            let opens = Arc::new(AtomicUsize::new(0));
            let kdf = Arc::new(AtomicUsize::new(0));
            let entry_decodes = Arc::new(AtomicUsize::new(0));
            let scanned = Arc::new(AtomicU64::new(0));
            let mut hooks = SevenzHooks::default();
            hooks.precheck.bytes_scanned = Arc::clone(&scanned);
            let kdf_for_hook = Arc::clone(&kdf);
            hooks.precheck.derive_key = Arc::new(move |salt, pw, cycles| {
                kdf_for_hook.fetch_add(1, Ordering::SeqCst);
                super::derive_key(salt, pw, cycles)
            });
            let opens_for_hook = Arc::clone(&opens);
            hooks.opener = Arc::new(move |path, password| {
                opens_for_hook.fetch_add(1, Ordering::SeqCst);
                crate::source::archive::sevenz_backend::open_sevenz_reader(path, password)
            });
            hooks.entry_decoder_calls = Arc::clone(&entry_decodes);
            Self {
                backend: SevenZBackend::with_hooks(hooks),
                opens,
                kdf,
                entry_decodes,
                scanned,
            }
        }

        pub fn open_checked(&self, input: &ArchiveInput) -> Result<(), ArchiveAccessError> {
            self.backend.open_checked(input, None).map(|_| ())
        }

        pub fn open_checked_with_password(
            &self,
            input: &ArchiveInput,
            pw: &str,
        ) -> Result<(), ArchiveAccessError> {
            self.backend
                .open_checked(input, Some(pw.as_bytes()))
                .map(|_| ())
        }

        pub fn probe_with_password(
            &self,
            input: &ArchiveInput,
            prefix: &str,
            pw: &str,
        ) -> Result<ArchiveProbe, ArchiveAccessError> {
            use crate::source::archive::backend::ArchiveBackend as _;
            self.backend.probe(input, prefix, Some(pw.as_bytes()))
        }

        pub fn open_call_count(&self) -> usize {
            self.opens.load(Ordering::SeqCst)
        }

        pub fn header_kdf_invocations(&self) -> usize {
            self.kdf.load(Ordering::SeqCst)
        }

        pub fn entry_decoder_calls(&self) -> usize {
            self.entry_decodes.load(Ordering::SeqCst)
        }

        pub fn bytes_scanned_total(&self) -> u64 {
            self.scanned.load(Ordering::SeqCst)
        }
    }

    /// 读入文件、翻转签名头 start-header CRC 的一个字节后写临时文件返回路径。
    pub(crate) fn flip_start_header_crc(path: &std::path::Path) -> PathBuf {
        let mut bytes = std::fs::read(path).unwrap();
        bytes[10] ^= 0xFF; // start-header CRC 字段（偏移 8..12）内的一字节
        let out = std::env::temp_dir().join(format!(
            "mirapage-7z-corrupt-crc-{}.7z",
            std::process::id()
        ));
        std::fs::write(&out, &bytes).unwrap();
        out
    }
}

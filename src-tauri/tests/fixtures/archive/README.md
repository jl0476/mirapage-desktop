# 归档读取器测试 fixture（RAR/7z 密码 + 远程 ZIP 流式读取模块）

本目录 24 个归档 fixture 是「RAR/7z 密码 + 远程 ZIP 流式读取」模块（任务 3-14）的
确定性测试基线。全部输入（PNG/padding/note.txt）由脚本生成，不含第三方版权内容。

**可复现承诺为「内容锁定」**：下表 SHA-256 清单为真值；不承诺跨机器字节级再生成
（归档头内时间戳、deflate 输出可能随工具/zlib 版本漂移）。重生成输出与清单不一致时
丢弃重生成物，以已提交产物为准，不覆盖清单。首次生成环境 `python --version` 仅供诊断。

## 首次生成环境记录（2026-08-25）

| 项 | 值 |
|---|---|
| `python --version` | Python 3.11.4（双机器环境另一台为 3.12，均可执行；承诺内容锁定，不承诺字节级再生成） |
| `pip show pyzipper` | Name: pyzipper / Version: 0.4.0 / Summary: AES encryption for zipfile. |
| `7z i`（首行版本） | 7-Zip 24.09 (x64) : Copyright (c) 1999-2024 Igor Pavlov : 2024-11-29 |
| `rar.exe`（绝对版本输出） | RAR 7.11 x64   Copyright (c) 1993-2025 Alexander Roshal   20 Mar 2025 |
| RAR4 回退工具（见「工具链偏离」①） | RAR 6.24 x64   Copyright (c) 1993-2023 Alexander Roshal   3 Oct 2023 |
| generate.py SHA-256 | `adfa0d9890a04680a66f90b30cb2c41e66769bfed25fbdb3727130640c638c0e`（2026-08-25 终审修复版：RAR_COMMANDS 帮助文本删两条不可行的 empty-rar5「先加后删」命令） |
| gen_declared_dict.py SHA-256 | `c4968d98b68843fc1eba23b29b4c78be2ac4bb8f58b4ba60f7d97b2dfe210aab`（2026-08-25 任务 6 对齐版：合法 encoded 变体 payload 改 Python `lzma` FORMAT_RAW 真实压缩，重生成环境 Python 3.11.4） |
| requirements.in SHA-256 | `b03a883ff2d38595950cce563d3e572aadfb82c892cc8d0d9af506d4f84f12b8` |

## 二十四 fixture 清单（SHA-256 为真值）

统一密码（凡「密码」列非空）：`test-pass-中文`。密码字节语义：ZIP 族产物一律按
UTF-8 编码派生密钥（与 AE-1/AE-2 的 pyzipper 默认及上层应用 `String::as_bytes()`
一致）；RAR 族由 WinRAR 内部按其格式语义（RAR5 存 UTF-8）处理。

| # | 文件 | 格式 | 密码 | 内容 | 生成工具 |
|---|---|---|---|---|---|
| 1 | plain-rar4.rar | RAR4 单卷 | 无 | page1.png, page2.png | WinRAR 6.24（偏离①） |
| 2 | password-rar4.rar | RAR4 单卷 | 有 | page1.png | WinRAR 6.24（偏离①） |
| 3 | plain-rar5.rar | RAR5 单卷 | 无 | page1.png, page2.png | WinRAR 7.11 |
| 4 | password-rar5.rar | RAR5 单卷 | 有 | page1.png | WinRAR 7.11 |
| 5 | encrypted-headers-rar5.rar | RAR5 单卷 `-hp`（文件头+数据同加密） | 有 | page1.png（catalog 加密 header 集成测试唯一载体） | WinRAR 7.11 |
| 6 | password-nonimage-rar4.rar | RAR4 单卷 | 有 | 仅 note.txt（非图片；probe 加密非图片兜底载体） | WinRAR 6.24（偏离①） |
| 7 | empty-rar5.rar | RAR5 单卷 | 无 | 零条目（EmptyArchive 合同载体；偏离③拼接生成） | WinRAR 7.11 头字节拼接 |
| 8 | mixed-dirs-rar5.rar | RAR5 单卷 | 无 | a/note.txt, b/page.png（probe prefix 视图统计载体） | WinRAR 7.11 |
| 9 | multipart.part1.rar | RAR5 分卷 `-v1k` | 无 | part1 头内 page1.png；padding.bin 头在后续卷（见「multipart 附属卷流程」） | WinRAR 7.11 |
| 10 | password-zipcrypto.zip | ZIP ZipCrypto（stored） | 有（UTF-8 字节） | page1.png | 纯 Python ZipCrypto（偏离②） |
| 11 | password-ae1.zip | ZIP WinZip AES AE-1（256-bit） | 有（UTF-8 字节） | page1.png | pyzipper 0.4.0 |
| 12 | password-ae2.zip | ZIP WinZip AES AE-2（256-bit） | 有（UTF-8 字节） | page1.png | pyzipper 0.4.0 |
| 13 | multidisk.zip | ZIP 手写 EOCD/ZIP64 盘字段非零 | 无 | page1.png（stored；不包含相邻分盘文件） | generate.py 手写 |
| 14 | dict-oversize-lzma.7z | 构造性 7z | 无 | LZMA 声明 dict=0xFFFFFFFF | gen_declared_dict.py |
| 15 | dict-oversize-lzma2.7z | 构造性 7z | 无 | LZMA2 props=0x28（4 GiB） | gen_declared_dict.py |
| 16 | dict-budget-oversum.7z | 构造性 7z | 无 | LZMA2 dict=4 MiB + page.png 真实 3 MiB 可解码 payload | gen_declared_dict.py |
| 17 | header-encoded-oversize.7z | 构造性 7z | 无 | encoded header 外层 LZMA2 声明 unpack 16 MiB > 8 MiB 上限 | gen_declared_dict.py |
| 18 | header-numfiles-over.7z | 构造性 7z | 无 | encoded header 内层（解码后）numFiles=100,001 | gen_declared_dict.py |
| 19 | header-copy.7z | 构造性 7z | 无 | encoded header 外层 COPY（对照，预检应放行） | gen_declared_dict.py |
| 20 | header-lzma.7z | 构造性 7z | 无 | encoded header 外层 LZMA（FILTER_LZMA1 压缩，对照） | gen_declared_dict.py |
| 21 | header-delta-lzma2.7z | 构造性 7z | 无 | encoded header 外层 [LZMA2, Delta] 链（对照） | gen_declared_dict.py |
| 22 | header-bcj-x86-lzma2.7z | 构造性 7z | 无 | encoded header 外层 [LZMA2, BCJ-x86] 链（对照） | gen_declared_dict.py |
| 23 | header-kdf-over.7z | 构造性 7z | 无 | encoded header AES props=[0x20]（cycles=32>24） | gen_declared_dict.py |
| 24 | content-kdf-over.7z | 构造性 7z | 无 | 主 streams AES props=[0x20]（folder 级 KDF 防线） | gen_declared_dict.py |

`kat_vectors.json` 为 11 个构造性 7z 的已知答案（KAT）元数据，不计入 24 计数。

### SHA-256 清单（`Get-FileHash -Algorithm SHA256`，2026-08-25）

```
cde00a713418813cb37459d613c939c2a1117272325023678715b143c9df74be  plain-rar4.rar
360885922dd5f23eccf47ae20cc470512988f9712cf6352e935443ddd4de9abc  password-rar4.rar
a33b109ad8be5337413cee9c143b48e109f1fba8716f5e1e39b7cd387c64f353  plain-rar5.rar
d06b98e179f5dcf69939c8567a77a54f4bdf20e9e98fbdd495d5cb20586fd5ba  password-rar5.rar
e335b6adb602f895f653933e4284956c0c4828bad27a5c9dc7268ea44ff2e54f  encrypted-headers-rar5.rar
3600dc9b63ce74a705406a9829d8995fbcf864c71370b7bdbb243d8b54976f42  password-nonimage-rar4.rar
fb495f16e8aa826c0759beb7435c5d7becc724d3db5b33e11fa27e04e053d4a2  empty-rar5.rar
c9a634edfa34431fcc1a47bbc589fa752821c93d57d7d664ac9764b4d1aa094f  mixed-dirs-rar5.rar
ab28f93ad26bed4a9cc5ab88e6e6a36a26a26eb4618992fc684cd00e6d87874f  multipart.part1.rar
ad9737ca23a25f158597bcd2f50626626f4fe73d3ac20c487951320814712300  password-zipcrypto.zip
f379ccd99e4a064b24fe9e22a7075122be9e48cbc6d0dd28a6923355603daa59  password-ae1.zip
c988620a1c285112a527354efe6a479f3738b50f79de9bacd118fbca14abb4b1  password-ae2.zip
16978c8b4774ea3683521b6f4412148b2c019eab18696837a9c94e074b04812e  multidisk.zip
18634d27828357179f62b60407c194a74e0397af53ff0716051a7c4eafdddbcd  dict-oversize-lzma.7z
55cb56fb532a3a1c6bc343452a721a630341bedc73272e540d3b94df9813cd59  dict-oversize-lzma2.7z
c65ac1fad04f59615f794db6139b574d8133f64b1a660abf3552e403edf58e6e  dict-budget-oversum.7z
592c52a5d6b20b0bc3e19cf9ab6896dd6da7b723106c67953d41e62224b87ff4  header-encoded-oversize.7z
830cb1cf25f0548fff5e98cc6d956d07479eceb2bdbe648860e191f50dd26d73  header-numfiles-over.7z
0438a19bbfbf7e16e61198773411f1c4dd87122dc3aaf4a5607b7a602478066b  header-copy.7z
847146dc3e5aa4e31bfe56e9091ee7474de248f7abe8600a21af6dafdfd19df3  header-lzma.7z
118c2ea9803ff1d115e72a87628e80a739f71045ab51c066f36da6bc3b4b1a04  header-delta-lzma2.7z
0fb1e0a9922bbd0ac79e8e129990b2bcee9058cc0a3c1340e5f55b0a772b05ab  header-bcj-x86-lzma2.7z
ee1b7454138dafd7fbacc32ce5a5dbce8118508e8588d03904e6f66c15ca84df  header-kdf-over.7z
af13459de13641821d86a8717be6323fdfd19c2b10c25a7c35cd40ddc801c8e1  content-kdf-over.7z
```

## 生成流程（完整命令，自上而下）

前置：`rar.exe`（WinRAR 7.11，`C:\Program Files\WinRAR\rar.exe`）、7-Zip 24.09
（`C:\Program Files\7-Zip\7z.exe`）、Python ≥ 3.11。以下命令在**仓库根**执行
（PowerShell；`rar.exe` 命令在本目录 `.work/` 内执行，输入由 generate.py 就绪）。

```powershell
python --version   # 环境记录（诊断信息）：内容锁定承诺，不承诺字节级再生成
python -m pip install pip-tools==7.4.1
python -m piptools compile --generate-hashes --resolver=backtracking --output-file src-tauri/tests/fixtures/archive/requirements.txt src-tauri/tests/fixtures/archive/requirements.in
python -m pip install --require-hashes -r src-tauri/tests/fixtures/archive/requirements.txt
python src-tauri/tests/fixtures/archive/generate.py
```

注：pip ≥ 25 与 pip-tools 7.4.1 不兼容（`PackageFinder.allow_all_prereleases` 移除）；
首次生成在独立 venv 内以 `pip==24.3.1 + pip-tools==7.4.1` 执行 compile，锁文件内容不受影响。

generate.py 生成 `.work/` 确定性输入 + password-ae1/ae2/zipcrypto/multidisk 四个 ZIP 产物
（含 local/central AES extra field 断言：vendor version 1/2、AE-2 CRC=0、AE-1 CRC=真实 CRC32）。
随后在 `.work/` 执行 RAR 命令（RAR5 用 WinRAR 7.11；RAR4 因偏离①用 WinRAR 6.24）：

```powershell
rar.exe a -idq -ma4 plain-rar4.rar page1.png page2.png                          # WinRAR 6.24
rar.exe a -idq -ma4 -ptest-pass-中文 password-rar4.rar page1.png                # WinRAR 6.24
rar.exe a -idq -ma4 -ptest-pass-中文 password-nonimage-rar4.rar note.txt        # WinRAR 6.24
rar.exe a -idq -ma5 plain-rar5.rar page1.png page2.png                          # WinRAR 7.11
rar.exe a -idq -ma5 -ptest-pass-中文 password-rar5.rar page1.png                # WinRAR 7.11
rar.exe a -idq -ma5 -hptest-pass-中文 encrypted-headers-rar5.rar page1.png      # WinRAR 7.11
rar.exe a -idq -ma5 mixed-dirs-rar5.rar a\note.txt b\page.png                   # WinRAR 7.11
rar.exe a -idq -ma5 -m0 -v1k multipart.rar page1.png padding.bin                # WinRAR 7.11
# empty-rar5（偏离③，rar 7.x 删空即删档，无法「先加后删」）：
python src-tauri/tests/fixtures/archive/generate.py --build-empty-rar5
```

把 8 个产物 + multipart 全部卷复制到本目录后校验：

```powershell
python src-tauri/tests/fixtures/archive/generate.py --verify
# 构造性 fixture 与 KAT（默认生成 11 个 7z + kat_vectors.json；--verify-kat 独立复算逐字段比对）
python src-tauri/tests/fixtures/archive/gen_declared_dict.py
python src-tauri/tests/fixtures/archive/gen_declared_dict.py --verify-kat
if ($LASTEXITCODE -ne 0) { throw "KAT verification failed" }
if (-not (Test-Path 'src-tauri/tests/fixtures/archive/kat_vectors.json')) { throw "kat_vectors.json missing" }
# multipart 附属卷（part2 起）仅 --verify 运行期使用；哈希前删除，不入仓（见下节）
Get-ChildItem 'src-tauri/tests/fixtures/archive/multipart.part*.rar' |
  Where-Object { $_.Name -ne 'multipart.part1.rar' } | Remove-Item
$fixtures = @('plain-rar4.rar','password-rar4.rar','plain-rar5.rar','password-rar5.rar','encrypted-headers-rar5.rar','password-nonimage-rar4.rar','empty-rar5.rar','mixed-dirs-rar5.rar','multipart.part1.rar','password-zipcrypto.zip','password-ae1.zip','password-ae2.zip','multidisk.zip','dict-oversize-lzma.7z','dict-oversize-lzma2.7z','dict-budget-oversum.7z','header-encoded-oversize.7z','header-numfiles-over.7z','header-copy.7z','header-lzma.7z','header-delta-lzma2.7z','header-bcj-x86-lzma2.7z','header-kdf-over.7z','content-kdf-over.7z')
$hashes = $fixtures | ForEach-Object { Get-FileHash -LiteralPath (Join-Path 'src-tauri/tests/fixtures/archive' $_) -Algorithm SHA256 }
if ($hashes.Count -ne 24) { throw "expected exactly 24 fixture hashes" }
$hashes
```

### multipart 附属卷流程（避免「目录内恰好 N 个 archive 文件」自相矛盾）

`-v1k` 分卷在首次生成时产出 part1..part7（附属卷 part2..part7 共 **6 个**，与计划的
「约 5-6 个」一致；page1.png ≈1.2 KB + padding.bin 4 KB + 归档头 ≈ 6 KB）。附属卷只在
`generate.py --verify` 运行期存在供**全卷解压校验**（page1.png + padding.bin 逐字节比对）；
校验通过后、取哈希前**必须删除 part2 起的全部附属卷**（上方 `Remove-Item` 段），只保留
`multipart.part1.rar` 入仓。运行时测试只用 part1 的 header 判多卷（MAIN 头 MHD_VOLUME
标志），不读取其余卷。附属卷删除后再次运行 `--verify` 会走降级路径：仅校验 part1 的
RAR5 签名 + 主头分卷标志并打印 `[降级]` 提示——属预期行为。

## 工具链偏离记录（上游硬限制，均已实测取证）

1. **RAR4 产物改用 WinRAR 6.24 生成**：WinRAR 7.00 起移除 RAR 4.x 格式**创建**能力
   （官方 changelog "drops support for creating RAR 4.x format archives"）；rar.exe 7.11
   对 `-ma4` 直接报 `Unknown option: ma4`（本机实测）。三个 RAR4 fixture（#1/2/6）由
   WinRAR 6.24 x64（2023-10-03，rarlab 官方安装包）生成，其余 RAR 产物仍由 7.11 生成。
2. **password-zipcrypto.zip 由纯 Python ZipCrypto 实现生成**：7-Zip ≥ 4.43（含 24.09）
   对「创建 zip + 非 ASCII 密码」无条件返回 `E_INVALIDARG`（源码 ZipHandlerOut.cpp
   `IsSimpleAsciiString(password)` 检查，注释原文 "7-Zip >= 4.43 creates ZIP archives
   only with ASCII characters in password"；rar.exe 亦无 zip 写能力）。generate.py 仍先按
   原命令调用 7-Zip 并验证工具版本，被上游拒绝后回退内置实现（APPNOTE 6.1.x 算法，
   密码字节 UTF-8，与 AE-1/AE-2 一致）；正确性由 stdlib zipfile 独立实现解密回读交叉验证。
   注意 7-Zip **读取** zip 密码走本机 ANSI 代码页（CP_ACP，中文机器为 GBK），故本产物
   与 7-Zip 互操作性预期不一致——这是 fixture 的 UTF-8 契约与 7-Zip 历史行为之别，
   上层应用按 UTF-8 传密码即可解开本产物。
3. **empty-rar5.rar 由真实 MAIN+ENDARC 头拼接生成**：rar.exe 7.x 在删除最后一个文件时
   会顺带删除整个归档（实测输出 `Erasing empty archive empty-rar5.rar`），「先加后删」
   无法留下零条目产物。`generate.py --build-empty-rar5` 用 rar 7.11 生成含 note.txt 的
   最小归档后，按 RAR5 header 边界截取真实 MAIN 头与 ENDARC 头拼接（31 bytes，头字节
   均来自 rar 本体），`rar lb` 零条目自检通过。
4. **pip-compile 在独立 venv 执行**：本机 pip 26.1.1 与 pip-tools 7.4.1 不兼容
   （`PackageFinder.allow_all_prereleases` 已移除）；以 `pip==24.3.1 + pip-tools==7.4.1`
   的 venv 执行 compile，锁文件内容（版本+哈希）与直接执行一致。

## 构造性 7z fixture 合同（11 个，逐个）

Python 手写 7z 字节（签名头 + StartHeader/NextHeader CRC + sevenz-rust 0.6.1 reader
语义的变长 number / folder / coder 序列化）。恶意防线 fixture 的 pack 为确定性合成字节
（`(i*31+7)&0xFF`，不代表可解压内容——解码前即拒）；**合法对照变体（#16、#19-22）的
payload 经 Python 标准库 `lzma` FORMAT_RAW 真实压缩、可完整解码**（任务 6 预检受限
decoder 的 COPY / LZMA1 / LZMA2 / Delta+LZMA2 / BCJ-x86+LZMA2 链路真值载体，已用
7-Zip 24.09 `7z l`/`7z t` 参考实现验证）；运行时 SevenZWriter fixture 由任务 6 测试用
dev-dependency `compress` feature 另行生成。KAT（kat_vectors.json）由**产物解析**
（非构造常量回填）生成——encoded 变体经脚本内置受限解码（与任务 6 Rust 实现同构的
Python lzma 镜像）递归进内层声明；`--verify-kat` 独立复算逐字段比对
（size/sha256/next_header/num_folders/num_files/coders/total_declared_dict/outer），
任何漂移非零退出。

| 文件 | 合同（coder properties / header 声明） | 预检预期 |
|---|---|---|
| dict-oversize-lzma.7z | plain header；LZMA（id 030101）props `5d ff ff ff ff`，声明 dict=0xFFFFFFFF（4 GiB-1）；第 0 字节 lc/lp/pb 非零，把"前 5 字节"当 dict 的错误实现会算错尺寸被用例抓出 | folder 级拒绝（单 coder 超限） |
| dict-oversize-lzma2.7z | plain header；LZMA2（id 21）props `28`（d=40 → (2|0)<<(40/2+11) = 4 GiB） | folder 级拒绝（单 coder 超限） |
| dict-budget-oversum.7z | plain header；LZMA2 props `14`（4 MiB）+ page.png 真实 3 MiB 重复字节数据（声明大小=实际 payload，substream CRC 正确） | 放行；预算内用例真实解码成功 |
| header-encoded-oversize.7z | encoded header（0x17）；外层 LZMA2 dict 2 MiB 合法，声明 unpack 16 MiB > MAX_ENCODED_HEADER_BYTES（8 MiB），pack 为占位字节 | 阶段一拒绝（外层声明 unpack 累加超限） |
| header-numfiles-over.7z | encoded header；外层 LZMA2 全法（FILTER_LZMA2 压缩），内层（解码后）kFilesInfo numFiles=100,001 > MAX_CATALOG_ENTRIES | 阶段二拒绝（numFiles 计数超限） |
| header-copy.7z | encoded header；外层 COPY（id 00，无 props），内层属性流原样存放 | 放行（对照；open+catalog 完整链路） |
| header-lzma.7z | encoded header；外层 LZMA props `5d 00 00 10 00`（dict 1 MiB），payload FILTER_LZMA1 压缩 | 放行（对照） |
| header-delta-lzma2.7z | encoded header；外层链 [LZMA2 props `12`（2 MiB）→ Delta props `00`（dist=1）]（2 out stream，kCodersUnpackSize ×2，delta 保长） | 放行（对照） |
| header-bcj-x86-lzma2.7z | encoded header；外层链 [LZMA2 props `12` → BCJ-x86（id 03030103，无 props）]（x86 保长） | 放行（对照） |
| header-kdf-over.7z | encoded header；外层 AES256SHA256（id 06f10701）props=`20` 单字节（cycles=32>24、b0&0xC0==0 恰 1 字节——不得直接比较 properties[0]） | 阶段一拒绝（KDF 派生前；header_kdf_invocations==0） |
| content-kdf-over.7z | plain header 主 streams；数据 folder AES props=`20` 同上 | folder 级拒绝（probe 阶段，条目解码前） |

对照值：真实归档 LZMA2 dict 字节典型 0x16-0x1a；AES numCyclesPower 典型 19（0x13）、
SevenZWriter 默认 8。LZMA2 dict 映射：`(2 | (d & 1)) << (d / 2 + 11)`。AES properties
解码公式（7-Zip 7zAes.cpp）：`cycles = b0 & 0x3F`；`b0 & 0xC0 == 0` → 恰 1 字节；否则
`salt_len = ((b0>>7)&1) + (b1>>4)`、`iv_len = ((b0>>6)&1) + (b1&0x0F)`（高位 **+1** 而非
×16），总长 `2 + salt_len + iv_len`。**2026-08-25 任务 6 对齐说明**：首版生成器的 kdf
fixture（cycles=24、iv=16 以"高位=16"错误公式编码）与 7zAes.cpp 公式自相矛盾（正确
解码下 salt/iv 长度与 props 实长不符），且 dict-budget/合法 encoded 变体为纯合成形态、
无法承载任务 6 简报的测试合同（真实解码成功、encoded 链路对照）；本版按任务 6 简报
合同重生成上述 9 个产物（dict-oversize×2 字节不变），README/哈希/KAT 同步更新。

## 文件职责

- `generate.py` — 输入 + ZIP 族产物生成/校验（AE-1/AE-2/ZipCrypto/multidisk）+ RAR 产物
  `--verify`（存在性/签名/条目/逐字节/加密 header 行为）+ `--build-empty-rar5`。
- `gen_declared_dict.py` — 11 个构造性 7z 生成 + KAT 写入/复算（`--verify-kat` 非零退出
  即漂移；`--print-kat` 只打印）。
- `requirements.in` / `requirements.txt` — pip 锁定输入 / `--generate-hashes` 锁文件
  （pyzipper==0.4.0 + pycryptodomex==3.23.0，43 哈希）。
- `kat_vectors.json` — 构造性 7z 的 KAT 元数据（格式 1；fixtures 数组逐字段）。
- `.work/` — 生成期临时目录（generate/verify 自动重建，verify 成功后自动清理），不入仓。

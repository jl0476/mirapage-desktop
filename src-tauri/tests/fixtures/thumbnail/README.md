# 缩略图生成测试 Fixture 约定

本目录**不存放静态图片样本**。所有测试图片在 `tests/thumbnail_generator.rs` 运行时
用 `image` crate 程序化生成，保证确定性、跨机器一致、不依赖外部资源。

## 3×2 四角颜色网格（方向测试基准）

用于 EXIF Orientation 1–8 的像素角落校正。图片尺寸 300×200，每格 100×100：

```
┌─────────┬─────────┬─────────┐
│   Red   │  Green  │  Blue   │   ← 行 0（上）
│  (A)    │         │  (B)    │
├─────────┼─────────┼─────────┤
│ Yellow  │ Magenta │  Cyan   │   ← 行 1（下）
│  (C)    │         │  (D)    │
└─────────┴─────────┴─────────┘
```

四角颜色（RGBA）：

| 角 | 颜色 | RGB |
|---|---|---|
| TL (左上) = A | Red | (255, 0, 0) |
| TR (右上) = B | Blue | (0, 0, 255) |
| BL (左下) = C | Yellow | (255, 255, 0) |
| BR (右下) = D | Cyan | (0, 255, 255) |

四个角颜色在 RGB 空间两两差异 > 100，便于在 WebP 有损编码（质量 82）下用 ±50 容差
稳定区分。Green / Magenta 为中间格，不参与角断言。

## EXIF Orientation 期望角映射

`apply_orientation` 把方向烘焙进像素。给定原图四角 (TL=A, TR=B, BL=C, BR=D)，
各 Orientation 归一化后输出四角的期望值（由 EXIF 几何语义推导，独立于 image crate
的 rotate/flip 命名，用于校正 5/7 组合）：

| Orientation | TL | TR | BL | BR | 宽高交换 |
|---:|---|---|---|---|---|
| 1 | A | B | C | D | 否 |
| 2 | B | A | D | C | 否 |
| 3 | D | C | B | A | 否 |
| 4 | C | D | A | B | 否 |
| 5 | A | C | B | D | 是 |
| 6 | C | A | D | B | 是 |
| 7 | D | B | C | A | 是 |
| 8 | B | D | A | C | 是 |

Orientation 5–8 交换宽高（输出由 300×200 变 200×300）。

## EXIF 注入

测试用 `make_jpeg_with_orientation(jpeg_bytes, orientation)` 在 JPEG SOI (`FF D8`)
后注入最小 EXIF APP1 段（仅 Orientation tag，小端 TIFF），再用 lib 的
`read_orientation` 回读校验，避免引入 EXIF 写入库依赖。

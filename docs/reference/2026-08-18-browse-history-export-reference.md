# 浏览记录导出 JSON 参考文档

> **范围**:本文档面向二次开发者和高级用户,说明 MiraPage 导出的阅读记录 JSON **长什么样**、**字段语义是什么**、**怎么用脚本/工具链处理**。它**不是设计文档**——设计决策、权衡、备选方案见内部 spec;当前导出 schemaVersion = 2。

---

## 1. 概述

MiraPage 提供「将本地所有阅读记录导出为单个 JSON」的能力。导出文件是**明文 JSON**,无密码、无加密、无签名。

- **schemaVersion 当前值:2**(v1 = 29 字段,2026-07-29 加入 `liked` 后升到 v2 = 30 字段)
- 当前**仅支持导出,不支持从该 JSON 导入回应用**
- 文件名格式:`browse_history_yyyyMMdd_HHmmss.json`,例 `browse_history_20260818_143052.json`

---

## 2. JSON 长这样

### 2.1 简化示例

```json
{
  "schemaVersion": 2,
  "totalCount": 3,
  "warnings": [],
  "items": [
    {
      "id": 17,
      "relPath": "folderA/photo.jpg",
      "displayName": "photo.jpg",
      "sourceType": "local",
      "local_rootUri": "content://com.android.externalstorage.documents/tree/primary%3AMiraPage",
      "smb_host": null,
      "smb_initialPath": null,
      "smb_path": null,
      "smb_accountId": null,
      "smb_port": null,
      "webdav_baseUrl": null,
      "webdav_path": null,
      "webdav_accountId": null,
      "archive_fileUri": null,
      "archive_format": null,
      "archive_originType": null,
      "archive_origin_rootUri": null,
      "archive_origin_host": null,
      "archive_origin_initialPath": null,
      "archive_origin_path": null,
      "archive_origin_accountId": null,
      "archive_origin_port": null,
      "archive_originEntryPath": null,
      "archive_archiveRelPath": null,
      "pageIndex": 12,
      "finished": false,
      "readerMode": "vertical_webtoon",
      "scaleMode": "fit_width",
      "readDirection": "ltr",
      "liked": true
    }
  ]
}
```

### 2.2 顶层结构

| 字段 | 类型 | 含义 |
|---|---|---|
| `schemaVersion` | `Int` | 当前 = **2** |
| `totalCount` | `Int` | `items.size`(成功导出的条目数,损坏条目不计入) |
| `warnings` | `Array<String>` | 损坏 / 跳过的明细,可空数组 |
| `items` | `Array<Item>` | 条目主体 |

**顶层不带**:`exportedAt` / `versionCode` / `versionName`。

### 2.3 编码细节

- UTF-8,缩进 2 空格,LF 换行
- MIME 类型 `application/json`

---

## 3. 单条 Item 字段(30 个,按类别分组)

### 3.1 通用(5 字段)

| 字段 | 类型 | nullable | 含义 |
|---|---|---|---|
| `id` | `Long` | 否 | 自增主键 |
| `relPath` | `String` | 否 | 资源相对路径 |
| `displayName` | `String` | 否 | 用户展示名 |
| `sourceType` | `String` | 否 | `local` / `smb` / `webdav` / `archive` |
| `liked` | `Boolean` | **否** | 是否被加入收藏 |

### 3.2 Local(1 字段,仅 `sourceType == "local"` 时非 null)

| 字段 | 类型 | nullable | 含义 |
|---|---|---|---|
| `local_rootUri` | `String?` | 是 | SAF 根目录 URI |

### 3.3 Smb(5 字段,仅 `sourceType == "smb"` 时非 null)

| 字段 | 类型 | nullable | 含义 |
|---|---|---|---|
| `smb_host` | `String?` | 是 | 主机 |
| `smb_initialPath` | `String?` | 是 | 登录初始路径 |
| `smb_path` | `String?` | 是 | 当前共享路径 |
| `smb_accountId` | `Long?` | 是 | 账号 FK(不导出密码) |
| `smb_port` | `Int?` | 是 | 端口 |

### 3.4 WebDav(3 字段,仅 `sourceType == "webdav"` 时非 null)

| 字段 | 类型 | nullable | 含义 |
|---|---|---|---|
| `webdav_baseUrl` | `String?` | 是 | 服务器 base URL |
| `webdav_path` | `String?` | 是 | 资源路径 |
| `webdav_accountId` | `Long?` | 是 | 账号 FK |

### 3.5 Archive(11 字段,仅 `sourceType == "archive"` 时非 null)

| 字段 | 类型 | nullable | 含义 |
|---|---|---|---|
| `archive_fileUri` | `String?` | 是 | 压缩包本身 URI |
| `archive_format` | `String?` | 是 | `zip` / `cbz` / `rar` / `cbr` / `7z` |
| `archive_originType` | `String?` | 是 | 包内 origin 实际形态:`local` 或 `smb` |
| `archive_origin_rootUri` | `String?` | 是 | 包内 origin Local 根 URI |
| `archive_origin_host` | `String?` | 是 | 包内 origin SMB 主机 |
| `archive_origin_initialPath` | `String?` | 是 | 包内 origin SMB 初始路径 |
| `archive_origin_path` | `String?` | 是 | 包内 origin SMB 路径 |
| `archive_origin_accountId` | `Long?` | 是 | 包内 origin SMB 账号 FK |
| `archive_origin_port` | `Int?` | 是 | 包内 origin SMB 端口 |
| `archive_originEntryPath` | `String?` | 是 | 包内 origin 资源入口路径(流式 archive 用) |
| `archive_archiveRelPath` | `String?` | 是 | 压缩包内文件相对路径 |

### 3.6 Progress(5 字段,联表命中时非 null;无进度则全 null)

| 字段 | 类型 | nullable | 含义 |
|---|---|---|---|
| `pageIndex` | `Int?` | 是 | 当前页 / 缩略图序号 |
| `finished` | `Boolean?` | 是 | 是否已读完 |
| `readerMode` | `String?` | 是 | `single` / `double` / `vertical_webtoon` / `horizontal_webtoon` |
| `scaleMode` | `String?` | 是 | `fit_width` / `fit_height` / `original` 等 |
| `readDirection` | `String?` | 是 | `ltr` / `rtl` |

---

## 4. 命名空间规则

**不适用的字段值 = `null`,但 key 始终保留**。

目的:用 `select(.smb_host != null)` 能**统一处理所有 sourceType**,不必 `has(.smb_host)` + `!= null` 双重判断。

例外:`liked` 字段强制写布尔,**`false` 不是 null**(`liked=false` 是合法状态,不能与"没记录"混淆)。

---

## 5. Archive Origin 平铺

archive 条目携带 origin(Local 或 SMB 之一),导出时把 origin 的全部字段**平铺到顶层**,用 `archive_origin_*` 前缀 + `archive_originType` 区分形态。**不嵌套 JSON 对象**,这样 jq 处理时与 Local/Smb 顶层是同一个命名空间。

例:`sourceType == "archive"` 且 origin 是 SMB,`archive_originType = "smb"`、`archive_origin_host` / `archive_origin_path` 等非 null,但顶层 `smb_*` 仍为 null。

---

## 6. 不导出的字段

| 字段 | 原因 |
|---|---|
| `lastVisitedAt` | 设计决策不持久化 |
| `totalPages` | 单条 image 语义不清,数据库不存 |
| 账号密码 | 仅持 FK `accountId`,密码永不导出 |
| 原 `sourceDescriptorJson` 字符串 | 改用展平字段,更便于脚本处理 |

---

## 7. 版本演进

| schemaVersion | 字段数 | 新增 | 日期 |
|---|---|---|---|
| 1 | 29 | — | 2026-07-28 |
| **2**(当前) | **30** | +`liked`(非 nullable `Boolean`) | 2026-07-29 |

未来升 v3 的条件:新增字段且**不能由 v2 推导**(例如新增 `exportedAt` 这类元数据)。

---

## 8. 常用 jq 查询

```bash
# 列出全部 sourceType 分布
jq -r '.items[].sourceType' file.json | sort | uniq -c

# 只看收藏
jq '.items[] | select(.liked == true)' file.json

# 找出未读完的本地书
jq '.items[] | select(.sourceType == "local" and .finished == false)' file.json

# 统计每个 sourceType 的总条目
jq -r '.items[].sourceType' file.json | sort | uniq -c | sort -rn

# 按 pageIndex 倒序
jq '.items | sort_by(.pageIndex) | reverse' file.json

# 看有哪些 warnings(损坏记录)
jq '.warnings' file.json

# 提取所有 SMB 主机
jq -r '.items[] | select(.sourceType == "smb") | .smb_host' file.json | sort -u
```

---

## 9. Python 加载示例

```python
import json
from pathlib import Path

data = json.loads(Path("browse_history_20260818_143052.json").read_text(encoding="utf-8"))

assert data["schemaVersion"] == 2, "需要升级处理脚本"

local_items = [it for it in data["items"] if it["sourceType"] == "local"]
liked_items = [it for it in data["items"] if it["liked"]]

print(f"total={data['totalCount']}, warnings={len(data['warnings'])}")
print(f"local={len(local_items)}, liked={len(liked_items)}")
```

---

## 10. 边界说明

- **凭据**:永不导出。账号密码走 Android Keystore,导出只持 FK `accountId`。
- **加密 / 签名**:均不携带。导出文件是明文 JSON,用户自行决定是否再加密存储。
- **导入**:当前不支持从该 JSON 导入回应用。
- **压缩包内图片**:archive 条目只记录压缩包 URI + 内文件相对路径,不展开图片内容。
- **损坏记录**:单条损坏不影响其他条目导出,会进顶层 `warnings` 数组。
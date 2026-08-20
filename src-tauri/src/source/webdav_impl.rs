//! `WebDavMediaSource` —— WebDAV 服务器
//!
//! Phase 8 实现。DESIGN §5 Phase 8:
//! - reqwest + 手写 PROPFIND(Depth: 1)
//! - 复用 Phase 7 账户管理框架(accounts table + commands::accounts::*)
//! - 实现 `MediaSource` trait(替换 stub,UI 无需改动)
//!
//! 协议要点:
//! - 列目录:PROPFIND + Depth: 1,响应 multi-status XML,解析 `<href>` 节点
//! - 读文件:GET with Range 字节
//! - 写文件:PUT(DESIGN Phase 4 未涉及,留作后续扩展)
//!
//! 设计取舍:每次 list/read 都创建 reqwest Client(WebDAV 通常需要 basic auth),
//! 复用 client 性能更佳但当前账户切换频率低;Phase 7+ 优化路径用 OnceCell 缓存。

use crate::source::descriptor::{MediaEntry, SourceDescriptor};
use crate::source::trait_def::{ByteRange, FileStat, MediaSource, MediaSourceError, Result};
use async_trait::async_trait;
use quick_xml::events::Event;
use quick_xml::Reader;
use reqwest::{
    header::{self, HeaderName},
    Client, StatusCode,
};
use std::time::Duration;

pub struct WebDavMediaSource {
    db: crate::db::Db,
    creds: std::sync::Arc<dyn crate::credentials::CredentialStore>,
}

impl WebDavMediaSource {
    pub fn new(
        db: crate::db::Db,
        creds: std::sync::Arc<dyn crate::credentials::CredentialStore>,
    ) -> Self {
        Self { db, creds }
    }

    /// 从 account 表 + keyring 取 (username, password)（spec §3.4 Basic Auth）
    fn credentials_for(&self, account_id: i64) -> Result<(Option<String>, Option<String>)> {
        let conn = self.db.conn();
        let username = conn
            .query_row(
                "SELECT username FROM account WHERE id = ?1 AND type = 'webdav'",
                rusqlite::params![account_id],
                |r| r.get::<_, Option<String>>(0),
            )
            .map_err(|_| MediaSourceError::NotFound(format!("webdav account {account_id}")))?;
        let password = self
            .creds
            .get_password(&crate::credentials::account_key("webdav", account_id))
            .map_err(MediaSourceError::Other)?;
        Ok((username, password))
    }

    fn extract<'a>(&self, descriptor: &'a SourceDescriptor) -> Option<(i64, &'a str, &'a str)> {
        match descriptor {
            SourceDescriptor::WebDav {
                account_id,
                base_url,
                path,
            } => Some((*account_id, base_url.as_str(), path.as_str())),
            _ => None,
        }
    }

    /// 解 PROPFIND multi-status XML,提取每个 <href> 的文件名/大小/类型
    /// module3.0.14: 标签匹配一律走 local_name（剥 `d:` 等命名空间前缀），
    /// collection 检测覆盖自闭合 `<collection/>`（Empty 事件）与展开式（Start 事件）。
    fn parse_propfind(body: &str, prefix: &str) -> Result<Vec<MediaEntry>> {
        let mut reader = Reader::from_str(body);
        reader.config_mut().trim_text(true);
        let mut entries: Vec<MediaEntry> = Vec::new();
        let mut current: Option<PartialEntry> = None;
        let mut current_field: Option<String> = None;
        let mut buf = Vec::new();

        loop {
            match reader.read_event_into(&mut buf) {
                Err(e) => return Err(MediaSourceError::Other(format!("xml: {e}"))),
                Ok(Event::Eof) => break,
                Ok(Event::Start(e)) => {
                    let name = local_name(e.name().as_ref()).to_owned();
                    match name.as_str() {
                        "response" => current = Some(PartialEntry::default()),
                        "href" | "getcontentlength" | "resourcetype" | "getlastmodified" => {
                            current_field = Some(name);
                        }
                        // 展开式 <collection></collection>：Start 事件到达
                        "collection" => {
                            if current_field.as_deref() == Some("resourcetype") {
                                if let Some(cur) = current.as_mut() {
                                    cur.is_collection = true;
                                }
                            }
                        }
                        _ => {}
                    }
                }
                Ok(Event::End(e)) => {
                    let qname = e.name();
                    let name = local_name(qname.as_ref());
                    if name == "response" {
                        if let Some(p) = current.take() {
                            if let Some(entry) = p.finalize(prefix) {
                                entries.push(entry);
                            }
                        }
                    }
                }
                Ok(Event::Empty(e)) => {
                    // 自闭合 <d:collection/>：quick-xml 以 Empty 事件到达（不拆成 Start+End）
                    if local_name(e.name().as_ref()) == "collection"
                        && current_field.as_deref() == Some("resourcetype")
                    {
                        if let Some(cur) = current.as_mut() {
                            cur.is_collection = true;
                        }
                    }
                }
                Ok(Event::Text(e)) => {
                    if let (Some(field), Some(cur)) = (current_field.as_ref(), current.as_mut()) {
                        let txt = e.unescape().map(|c| c.into_owned()).unwrap_or_default();
                        cur.apply(field, txt);
                    }
                }
                _ => {}
            }
            buf.clear();
        }

        // 自然排序
        entries.sort_by(|a, b| crate::algorithm::natural_compare(&a.name, &b.name));
        Ok(entries)
    }
}

/// 取标签 local name（剥命名空间前缀，`d:response` → `response`；无前缀原样返回）。
fn local_name(name: &[u8]) -> &str {
    let s = std::str::from_utf8(name).unwrap_or("");
    match s.split_once(':') {
        Some((_, local)) => local,
        None => s,
    }
}

/// Range 响应校验（强契约，spec rev3 §3.1）：请求 range 时返回字节必须恰好等于请求区间。
/// 206 必须有匹配请求 offset 的 Content-Range；200 仅当 body 长度恰等（个别服务器忽略 Range 却刚好截断）；其余一律报错，
/// 防止 M3 分块下载把整包/短读拼进 .part。
fn verify_range_response(
    status: u16,
    content_range: Option<&str>,
    expected_offset: u64,
    body_len: usize,
    expected_len: u64,
) -> Result<()> {
    let valid = match status {
        206 => content_range_start(content_range) == Some(expected_offset)
            && body_len as u64 == expected_len,
        200 => body_len as u64 == expected_len,
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(MediaSourceError::Network(format!(
            "invalid range response: status {status}, content-range {:?}, body {body_len} != expected offset {expected_offset}, length {expected_len}",
            content_range,
        )))
    }
}

/// 仅提取 RFC 7233 `Content-Range: bytes <start>-<end>/<total>` 的起始偏移。
fn content_range_start(value: Option<&str>) -> Option<u64> {
    let value = value?;
    let (unit, range_and_total) = value.split_once(' ')?;
    if !unit.eq_ignore_ascii_case("bytes") {
        return None;
    }
    let (range, _) = range_and_total.split_once('/')?;
    let (start, _) = range.split_once('-')?;
    start.parse().ok()
}

/// RFC 7231 HTTP-date → Unix 秒（"Sun, 06 Nov 1994 08:49:37 GMT" → 784111777）。
/// 手写解析避免引入 httpdate 依赖；失败返回 None（mtime 对缓存失效判定是辅助信息）。
///
/// 闰年 2 月末 ±1 天误差对缓存失效判定无实际影响——失效主判据是 size。
fn parse_http_date_secs(s: &str) -> Option<i64> {
    let rest = s.split_once(", ")?.1;
    let (d, rest) = rest.split_once(' ')?;
    let (mon, rest) = rest.split_once(' ')?;
    let (y, rest) = rest.split_once(' ')?;
    let (hms, _) = rest.split_once(' ').unwrap_or((rest, ""));
    let months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    let mon_idx = months.iter().position(|m| *m == mon)?;
    let day: i64 = d.parse().ok()?;
    let year: i64 = y.parse().ok()?;
    let mut parts = hms.split(':');
    let hh: i64 = parts.next()?.parse().ok()?;
    let mm: i64 = parts.next()?.parse().ok()?;
    let ss: i64 = parts.next()?.parse().ok()?;
    // 简化儒略日（民用历足够；1970+ 有效）
    let days = 365 * (year - 1970) + (year - 1969) / 4 - (year - 1901) / 100 + (year - 1601) / 400
        + [0i64, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334][mon_idx] + day - 1;
    Some((days * 86400 + hh * 3600 + mm * 60 + ss).min(i64::MAX))
}

#[derive(Default)]
struct PartialEntry {
    href: Option<String>,
    size: Option<u64>,
    is_collection: bool,
}

impl PartialEntry {
    fn apply(&mut self, field: &str, value: String) {
        match field {
            "href" => self.href = Some(value),
            "getcontentlength" => {
                self.size = value.parse().ok();
            }
            "resourcetype" => {
                self.is_collection = value.contains("collection");
            }
            _ => {}
        }
    }

    fn finalize(self, prefix: &str) -> Option<MediaEntry> {
        let href = self.href?;
        // href 是 URL-encoded 的相对路径;strip prefix 与目录
        let stripped = if let Some(idx) = href.find(prefix) {
            &href[idx + prefix.len()..]
        } else {
            &href
        };
        let name = urlencoding_decode(stripped.trim_end_matches('/'));
        if name.is_empty() {
            return None;
        }
        let is_archive = !self.is_collection && crate::source::descriptor::ArchiveFormat::from_extension(
            std::path::Path::new(&name)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or(""),
        )
        .is_some();
        Some(MediaEntry {
            name: name.clone(),
            path: name,
            is_directory: self.is_collection,
            is_archive,
            size: self.size.unwrap_or(0),
            modified_at: None,
        })
    }
}

/// 简易 URL percent-decode(只处理 %XX 与 +)
fn urlencoding_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(a), Some(b)) = (
                (bytes[i + 1] as char).to_digit(16),
                (bytes[i + 2] as char).to_digit(16),
            ) {
                out.push((a * 16 + b) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[async_trait]
impl MediaSource for WebDavMediaSource {
    fn descriptor_type(&self) -> &'static str {
        "webdav"
    }

    async fn list_directory(
        &self,
        descriptor: &SourceDescriptor,
        path: &str,
    ) -> Result<Vec<MediaEntry>> {
        let (account_id, base_url, _) = self.extract(descriptor).ok_or_else(|| {
            MediaSourceError::NotImplemented("WebDavMediaSource 仅处理 WebDav descriptor".into())
        })?;
        let (user, pass) = self.credentials_for(account_id)?;
        let url = format!("{}/{}", base_url.trim_end_matches('/'), path.trim_start_matches('/'));
        let url = url.trim_end_matches('/');
        let client = Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|e| MediaSourceError::Other(format!("reqwest: {e}")))?;
        let mut req = client
            .request(reqwest::Method::from_bytes(b"PROPFIND").unwrap(), url)
            .header(HeaderName::from_static("depth"), "1")
            .header(header::CONTENT_TYPE, "application/xml")
            .body("<?xml version=\"1.0\" encoding=\"utf-8\" ?><propfind xmlns=\"DAV:\"><allprop/></propfind>");
        if let (Some(u), Some(p)) = (&user, &pass) {
            req = req.basic_auth(u, Some(p));
        }
        let resp = req
            .send()
            .await
            .map_err(|e| MediaSourceError::Network(format!("propfind: {e}")))?;
        if !resp.status().is_success() {
            return Err(MediaSourceError::Network(format!(
                "PROPFIND status {}",
                resp.status()
            )));
        }
        let body = resp
            .text()
            .await
            .map_err(|e| MediaSourceError::Network(format!("body: {e}")))?;
        Self::parse_propfind(&body, path)
    }

    async fn read_file(
        &self,
        descriptor: &SourceDescriptor,
        path: &str,
        range: Option<ByteRange>,
    ) -> Result<Vec<u8>> {
        let (account_id, base_url, _) = self.extract(descriptor).ok_or_else(|| {
            MediaSourceError::NotImplemented("WebDavMediaSource 仅处理 WebDav descriptor".into())
        })?;
        let (user, pass) = self.credentials_for(account_id)?;
        let url = format!("{}/{}", base_url.trim_end_matches('/'), path.trim_start_matches('/'));
        let client = Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| MediaSourceError::Other(format!("reqwest: {e}")))?;
        let mut req = client.get(&url);
        if let Some(r) = range {
            req = req.header(header::RANGE, format!("bytes={}-{}", r.offset, r.offset + r.length - 1));
        }
        if let (Some(u), Some(p)) = (&user, &pass) {
            req = req.basic_auth(u, Some(p));
        }
        let resp = req
            .send()
            .await
            .map_err(|e| MediaSourceError::Network(format!("get: {e}")))?;
        if resp.status() == StatusCode::NOT_FOUND {
            return Err(MediaSourceError::NotFound(path.to_string()));
        }
        if !resp.status().is_success() {
            return Err(MediaSourceError::Network(format!("GET status {}", resp.status())));
        }
        let status = resp.status().as_u16();
        let content_range = resp
            .headers()
            .get(header::CONTENT_RANGE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| MediaSourceError::Network(format!("read: {e}")))?;
        // Range 强契约（spec rev3 §3.1）：请求区间时返回字节必须恰好等长
        if let Some(r) = range {
            verify_range_response(status, content_range.as_deref(), r.offset, bytes.len(), r.length)?;
        }
        Ok(bytes.to_vec())
    }

    async fn file_count(
        &self,
        descriptor: &SourceDescriptor,
        path: &str,
    ) -> Result<u64> {
        let entries = self.list_directory(descriptor, path).await?;
        Ok(entries
            .iter()
            .filter(|e| !e.is_directory && !e.is_archive)
            .count() as u64)
    }

    async fn test(&self, descriptor: &SourceDescriptor) -> Result<()> {
        match descriptor {
            SourceDescriptor::WebDav { account_id, base_url, path } => {
                let (user, pass) = self.credentials_for(*account_id)?;
                let client = Client::builder()
                    .timeout(Duration::from_secs(10))
                    .build()
                    .map_err(|e| MediaSourceError::Other(format!("reqwest: {e}")))?;
                let url = format!("{}/{}", base_url.trim_end_matches('/'), path);
                let mut req = client.head(&url);
                if let (Some(u), Some(p)) = (&user, &pass) {
                    req = req.basic_auth(u, Some(p));
                }
                let resp = req
                    .send()
                    .await
                    .map_err(|e| MediaSourceError::Network(format!("head: {e}")))?;
                if resp.status() == StatusCode::NOT_FOUND {
                    return Err(MediaSourceError::NotFound(url));
                }
                if !resp.status().is_success() {
                    return Err(MediaSourceError::Network(format!(
                        "HEAD status {}",
                        resp.status()
                    )));
                }
                Ok(())
            }
            _ => Err(MediaSourceError::NotImplemented(
                "WebDavMediaSource::test 仅处理 WebDav descriptor".into(),
            )),
        }
    }

    async fn stat(&self, descriptor: &SourceDescriptor, path: &str) -> Result<FileStat> {
        let (account_id, base_url, _) = self.extract(descriptor).ok_or_else(|| {
            MediaSourceError::NotImplemented("WebDavMediaSource 仅处理 WebDav descriptor".into())
        })?;
        let (user, pass) = self.credentials_for(account_id)?;
        let url = format!("{}/{}", base_url.trim_end_matches('/'), path.trim_start_matches('/'));
        let client = Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|e| MediaSourceError::Other(format!("reqwest: {e}")))?;
        let mut req = client.head(&url);
        if let (Some(u), Some(p)) = (&user, &pass) {
            req = req.basic_auth(u, Some(p));
        }
        let resp = req
            .send()
            .await
            .map_err(|e| MediaSourceError::Network(format!("head: {e}")))?;
        match resp.status() {
            StatusCode::NOT_FOUND => return Err(MediaSourceError::NotFound(url)),
            s if !s.is_success() => return Err(MediaSourceError::Network(format!("HEAD status {s}"))),
            _ => {}
        }
        let size = resp
            .headers()
            .get(header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .ok_or_else(|| MediaSourceError::Other("HEAD 无 Content-Length".into()))?;
        // Last-Modified: HTTP-date → Unix 秒（失败容忍为 None）
        let modified_at = resp
            .headers()
            .get(header::LAST_MODIFIED)
            .and_then(|v| v.to_str().ok())
            .and_then(parse_http_date_secs);
        Ok(FileStat { size, modified_at })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_decoding_handles_pct_and_plain() {
        assert_eq!(urlencoding_decode("hello%20world"), "hello world");
        assert_eq!(urlencoding_decode("plain"), "plain");
        assert_eq!(urlencoding_decode("%E4%B8%AD%E6%96%87"), "中文");
    }

    #[test]
    fn range_response_must_be_206_or_exact_length() {
        // spec rev3 §3.1 Range 强契约
        assert!(verify_range_response(206, Some("bytes 100-199/1000"), 100, 100, 100).is_ok());
        assert!(verify_range_response(206, None, 100, 100, 100).is_err()); // 206 缺 Content-Range（RFC 7233 违规）
        assert!(verify_range_response(206, Some("bytes 300-399/1000"), 100, 100, 100).is_err());
        assert!(verify_range_response(206, Some("bytes 100-149/1000"), 100, 50, 100).is_err());
        assert!(verify_range_response(200, None, 100, 100, 100).is_ok());
        assert!(verify_range_response(200, None, 100, 999, 100).is_err());
        assert!(verify_range_response(200, None, 100, 50, 100).is_err());
        assert!(verify_range_response(404, None, 100, 0, 100).is_err());
    }

    #[test]
    fn content_range_start_parses_and_rejects_malformed() {
        assert_eq!(content_range_start(Some("bytes 100-199/1000")), Some(100));
        assert_eq!(content_range_start(Some("bytes 0-99/100")), Some(0)); // offset 0 是有效 Some(0)
        assert_eq!(content_range_start(Some("Bytes 5-9/*")), Some(5)); // unit 大小写不敏感 + total 通配
        assert_eq!(content_range_start(None), None);
        assert_eq!(content_range_start(Some("chunks 5-9/100")), None); // 非 bytes 单位
        assert_eq!(content_range_start(Some("bytes */1000")), None);   // 416 形态（无区间）
        assert_eq!(content_range_start(Some("garbage")), None);
    }

    #[test]
    fn parse_http_date_secs_handles_rfc7231() {
        assert_eq!(parse_http_date_secs("Sun, 06 Nov 1994 08:49:37 GMT"), Some(784111777));
        assert_eq!(parse_http_date_secs("garbage"), None);
        assert!(parse_http_date_secs("Wed, 01 Jan 2025 00:00:00 GMT").is_some());
    }

    #[test]
    fn parse_propfind_extracts_collection_and_files() {
        let body = r#"<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/dav/sub1/</d:href>
    <d:propstat><d:prop>
      <d:resourcetype><d:collection/></d:resourcetype>
    </d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>/dav/file.txt</d:href>
    <d:propstat><d:prop>
      <d:getcontentlength>12345</d:getcontentlength>
    </d:prop></d:propstat>
  </d:response>
</d:multistatus>"#;
        let entries = WebDavMediaSource::parse_propfind(body, "/dav/").unwrap();
        assert_eq!(entries.len(), 2);
        // collection first (sort alphabetically? actually natural: 'file.txt' < 'sub1/' due to '/')
        // 自然排序:'file.txt' < 'sub1/' 因 f < s
        assert_eq!(entries[0].name, "file.txt");
        assert!(!entries[0].is_directory);
        assert_eq!(entries[0].size, 12345);
        assert_eq!(entries[1].name, "sub1");
        assert!(entries[1].is_directory);
    }

    #[test]
    fn parse_propfind_handles_unprefixed_and_expanded_collection() {
        // module3.0.14 spec B：无命名空间前缀 + 展开式 <collection></collection>
        // （与既有前缀 + 自闭合用例分别覆盖两条 collection 解析路径）
        let body = r#"<?xml version="1.0"?>
<multistatus xmlns="DAV:">
  <response>
    <href>/dav/sub1/</href>
    <propstat><prop>
      <resourcetype><collection></collection></resourcetype>
    </prop></propstat>
  </response>
  <response>
    <href>/dav/pic.zip</href>
    <propstat><prop>
      <getcontentlength>999</getcontentlength>
    </prop></propstat>
  </response>
</multistatus>"#;
        let entries = WebDavMediaSource::parse_propfind(body, "/dav/").unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "pic.zip");
        assert_eq!(entries[0].size, 999);
        assert!(!entries[0].is_directory);
        assert_eq!(entries[1].name, "sub1");
        assert!(entries[1].is_directory);
    }

    #[test]
    fn parse_propfind_marks_archive_entries_by_extension() {
        let body = r#"<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <d:response><d:href>/dav/book.cbz</d:href>
    <d:propstat><d:prop><d:getcontentlength>999</d:getcontentlength></d:prop></d:propstat></d:response>
  <d:response><d:href>/dav/img.jpg</d:href>
    <d:propstat><d:prop><d:getcontentlength>1</d:getcontentlength></d:prop></d:propstat></d:response>
</d:multistatus>"#;
        let entries = WebDavMediaSource::parse_propfind(body, "/dav/").unwrap();
        assert!(entries[0].is_archive, ".cbz 按扩展名标记");
        assert!(!entries[1].is_archive, "普通文件不标记");
    }
}

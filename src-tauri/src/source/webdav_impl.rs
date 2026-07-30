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
use crate::source::trait_def::{ByteRange, MediaSource, MediaSourceError, Result};
use async_trait::async_trait;
use quick_xml::events::Event;
use quick_xml::Reader;
use reqwest::{
    header::{self, HeaderName},
    Client, StatusCode,
};
use std::time::Duration;

pub struct WebDavMediaSource {
    _private: (),
}

impl WebDavMediaSource {
    pub fn new() -> Self {
        Self { _private: () }
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
                    let name = String::from_utf8_lossy(e.name().as_ref()).into_owned();
                    match name.as_str() {
                        "response" => current = Some(PartialEntry::default()),
                        "href" | "getcontentlength" | "resourcetype" | "getlastmodified" => {
                            current_field = Some(name);
                        }
                        _ => {}
                    }
                }
                Ok(Event::End(e)) => {
                    let name = String::from_utf8_lossy(e.name().as_ref()).into_owned();
                    if name == "response" {
                        if let Some(p) = current.take() {
                            if let Some(entry) = p.finalize(prefix) {
                                entries.push(entry);
                            }
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

impl Default for WebDavMediaSource {
    fn default() -> Self {
        Self::new()
    }
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
        Some(MediaEntry {
            name: name.clone(),
            path: name,
            is_directory: self.is_collection,
            is_archive: false,
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
        let (_, base_url, _) = self.extract(descriptor).ok_or_else(|| {
            MediaSourceError::NotImplemented("WebDavMediaSource 仅处理 WebDav descriptor".into())
        })?;
        let url = format!("{}/{}", base_url.trim_end_matches('/'), path.trim_start_matches('/'));
        let url = url.trim_end_matches('/');
        let client = Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|e| MediaSourceError::Other(format!("reqwest: {e}")))?;
        let resp = client
            .request(reqwest::Method::from_bytes(b"PROPFIND").unwrap(), url)
            .header(HeaderName::from_static("depth"), "1")
            .header(header::CONTENT_TYPE, "application/xml")
            .body("<?xml version=\"1.0\" encoding=\"utf-8\" ?><propfind xmlns=\"DAV:\"><allprop/></propfind>")
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
        let (_, base_url, _) = self.extract(descriptor).ok_or_else(|| {
            MediaSourceError::NotImplemented("WebDavMediaSource 仅处理 WebDav descriptor".into())
        })?;
        let url = format!("{}/{}", base_url.trim_end_matches('/'), path.trim_start_matches('/'));
        let client = Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| MediaSourceError::Other(format!("reqwest: {e}")))?;
        let mut req = client.get(&url);
        if let Some(r) = range {
            req = req.header(header::RANGE, format!("bytes={}-{}", r.offset, r.offset + r.length - 1));
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
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| MediaSourceError::Network(format!("read: {e}")))?;
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
                let client = Client::builder()
                    .timeout(Duration::from_secs(10))
                    .build()
                    .map_err(|e| MediaSourceError::Other(format!("reqwest: {e}")))?;
                let url = format!("{}/{}", base_url.trim_end_matches('/'), path);
                let resp = client
                    .head(&url)
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
                let _ = account_id; // reserved for auth lookup
                Ok(())
            }
            _ => Err(MediaSourceError::NotImplemented(
                "WebDavMediaSource::test 仅处理 WebDav descriptor".into(),
            )),
        }
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
}
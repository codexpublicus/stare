//! A loopback HTTP server over a directory, with Range requests, the way R2 behind
//! Cloudflare serves idx.stare.pub and data.stare.pub. It records every request so a
//! test can say what was fetched.

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// One request: its path, and its Range header if it had one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub path: String,
    pub range: Option<String>,
}

pub struct Server {
    pub url: String,
    pub requests: Arc<Mutex<Vec<Request>>>,
}

impl Server {
    /// Serve `root` on a free port until the test process ends.
    pub fn start(root: &Path) -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests: Arc<Mutex<Vec<Request>>> = Arc::default();
        let root = root.to_path_buf();
        let log = requests.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let root = root.clone();
                let log = log.clone();
                std::thread::spawn(move || {
                    let _ = serve(stream, &root, &log);
                });
            }
        });
        Server { url, requests }
    }

    /// The requests so far, and clear them.
    pub fn take(&self) -> Vec<Request> {
        std::mem::take(&mut self.requests.lock().unwrap())
    }
}

fn serve(stream: TcpStream, root: &Path, log: &Mutex<Vec<Request>>) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut writer = stream;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Ok(());
        }
        let path = line.split_whitespace().nth(1).unwrap_or("/").to_string();
        let mut range = None;
        loop {
            let mut header = String::new();
            reader.read_line(&mut header)?;
            let header = header.trim_end();
            if header.is_empty() {
                break;
            }
            if let Some((name, value)) = header.split_once(':') {
                if name.eq_ignore_ascii_case("range") {
                    range = Some(value.trim().to_string());
                }
            }
        }
        log.lock().unwrap().push(Request {
            path: path.clone(),
            range: range.clone(),
        });
        let file: PathBuf = root.join(path.trim_start_matches('/'));
        let body = match std::fs::read(&file) {
            Ok(body) if !path.contains("..") => body,
            _ => {
                write!(
                    writer,
                    "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n"
                )?;
                continue;
            }
        };
        let len = body.len() as u64;
        match range.as_deref().and_then(|r| parse_range(r, len)) {
            Some((start, end)) => {
                let part = &body[start as usize..=end as usize];
                write!(
                    writer,
                    "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\n\
                     Content-Range: bytes {start}-{end}/{len}\r\nAccept-Ranges: bytes\r\n\r\n",
                    part.len()
                )?;
                writer.write_all(part)?;
            }
            None => {
                write!(
                    writer,
                    "HTTP/1.1 200 OK\r\nContent-Length: {len}\r\nAccept-Ranges: bytes\r\n\r\n"
                )?;
                writer.write_all(&body)?;
            }
        }
        writer.flush()?;
    }
}

/// `bytes=a-b`, `bytes=a-` or `bytes=-n` as an inclusive range within `len`.
fn parse_range(header: &str, len: u64) -> Option<(u64, u64)> {
    let spec = header.strip_prefix("bytes=")?;
    let (a, b) = spec.split_once('-')?;
    let (start, end) = match (a.is_empty(), b.is_empty()) {
        (true, false) => (len.saturating_sub(b.parse().ok()?), len - 1),
        (false, true) => (a.parse().ok()?, len - 1),
        (false, false) => (a.parse().ok()?, b.parse::<u64>().ok()?.min(len - 1)),
        (true, true) => return None,
    };
    (start <= end && end < len).then_some((start, end))
}

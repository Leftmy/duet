//! Large CLI envelopes spill to a private temporary file, not a growing RAM buffer.
use super::wire_json;
use serde_json::Value;
use std::{
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};
const MEMORY: usize = 4 * 1024 * 1024;
const MAX_FRAME: usize = 512 * 1024 * 1024;
pub struct Frame {
    bytes: Vec<u8>,
    file: Option<File>,
    path: Option<PathBuf>,
}
impl Drop for Frame {
    fn drop(&mut self) {
        drop(self.file.take());
        if let Some(path) = self.path.take() {
            let _ = fs::remove_file(path);
        }
    }
}
impl Frame {
    pub fn read(reader: &mut impl BufRead) -> Result<Option<Self>, String> {
        Self::read_at(reader, MEMORY, MAX_FRAME, &std::env::temp_dir())
    }
    fn read_at(
        reader: &mut impl BufRead,
        memory: usize,
        cap: usize,
        dir: &Path,
    ) -> Result<Option<Self>, String> {
        let mut frame = Self {
            bytes: Vec::new(),
            file: None,
            path: None,
        };
        let mut size = 0usize;
        loop {
            let buf = reader.fill_buf().map_err(|e| e.to_string())?;
            if buf.is_empty() {
                return Ok((size > 0).then_some(frame));
            }
            let n = buf
                .iter()
                .position(|b| *b == b'\n')
                .map_or(buf.len(), |i| i + 1);
            size = size.checked_add(n).ok_or("CLI frame size overflow")?;
            if size > cap {
                return Err(format!("CLI frame exceeds {cap} bytes"));
            }
            if frame.file.is_none() && size > memory {
                let path = dir.join(format!("duet-cli-frame-{}.json", uuid::Uuid::new_v4()));
                let mut options = OpenOptions::new();
                options.read(true).write(true).create_new(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                let file = options
                    .open(&path)
                    .map_err(|e| format!("Cannot spool CLI frame: {e}"))?;
                frame.path = Some(path);
                frame.file = Some(file);
                frame
                    .file
                    .as_mut()
                    .unwrap()
                    .write_all(&frame.bytes)
                    .map_err(|e| e.to_string())?;
                frame.bytes = Vec::new();
            }
            if let Some(file) = &mut frame.file {
                file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            } else {
                frame.bytes.extend_from_slice(&buf[..n]);
            }
            let done = buf[n - 1] == b'\n';
            reader.consume(n);
            if done {
                return Ok(Some(frame));
            }
        }
    }
    pub fn parse(&mut self) -> Result<Value, String> {
        if let Some(file) = &mut self.file {
            file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
            wire_json::parse_cli_reader(BufReader::new(file))
        } else {
            wire_json::parse_cli(&self.bytes)
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Read};
    #[test]
    fn oversized_history_spills_projects_and_leaves_the_next_frame_readable() {
        let dir = tempfile::tempdir().unwrap();
        let input=Cursor::new(b"{\"result\":{\"thread\":{\"turns\":[{\"text\":\"").chain(std::io::repeat(b'x').take(40*1024*1024)).chain(Cursor::new(b"\"}],\"id\":\"resumed\"},\"model\":\"same\"},\"id\":9}\n{\"method\":\"turn/completed\",\"params\":{\"threadId\":\"other\"}}\n"));
        let mut reader = BufReader::with_capacity(8192, input);
        let mut frame = Frame::read_at(&mut reader, MEMORY, MAX_FRAME, dir.path())
            .unwrap()
            .unwrap();
        let path = frame.path.clone().unwrap();
        assert!(frame.bytes.is_empty());
        assert!(path.exists());
        let value = frame.parse().unwrap();
        assert_eq!(value["id"], 9);
        assert_eq!(value["result"]["thread"]["id"], "resumed");
        assert_eq!(value["result"]["thread"]["turns"], serde_json::json!([]));
        drop(frame);
        assert!(!path.exists());
        let next = Frame::read_at(&mut reader, MEMORY, MAX_FRAME, dir.path())
            .unwrap()
            .unwrap()
            .parse()
            .unwrap();
        assert_eq!(next["params"]["threadId"], "other");
        assert!(Frame::read_at(&mut reader, MEMORY, MAX_FRAME, dir.path())
            .unwrap()
            .is_none());
    }
    #[test]
    fn limits_and_invalid_json_clean_up_spools() {
        let dir = tempfile::tempdir().unwrap();
        let mut input = BufReader::with_capacity(4, Cursor::new(b"abcdefghijk\n"));
        assert!(Frame::read_at(&mut input, 3, 8, dir.path()).is_err());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
        let mut input = Cursor::new(b"{\"id\":9,broken}\n{\"id\":10}\n");
        let mut frame = Frame::read_at(&mut input, 3, 100, dir.path())
            .unwrap()
            .unwrap();
        assert!(frame.parse().is_err());
        drop(frame);
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
        assert_eq!(
            Frame::read_at(&mut input, 3, 100, dir.path())
                .unwrap()
                .unwrap()
                .parse()
                .unwrap()["id"],
            10
        );
    }
}

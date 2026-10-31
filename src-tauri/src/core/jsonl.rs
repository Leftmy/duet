use std::io::BufRead;

pub const MAX_RECORD: usize = 32 * 1024 * 1024;

#[derive(Default, Debug)]
pub struct Scan {
    pub offset: u64,
    pub skipped: u64,
    pub lines: u64,
}

/// Only commits complete lines. A writer's partial tail is re-read on the next refresh.
/// Oversized lines are consumed without ever buffering more than `limit` bytes.
pub fn scan<R: BufRead>(
    reader: R,
    limit: usize,
    mut record: impl FnMut(&[u8]) -> Result<(), String>,
) -> Result<Scan, String> {
    scan_at(reader, limit, move |bytes, _| record(bytes))
}
pub fn scan_at<R: BufRead>(
    mut reader: R,
    limit: usize,
    mut record: impl FnMut(&[u8], u64) -> Result<(), String>,
) -> Result<Scan, String> {
    let mut result = Scan::default();
    let mut buffer = Vec::new();
    let mut pending = 0u64;
    let mut oversized = false;
    loop {
        let chunk = reader.fill_buf().map_err(|e| e.to_string())?;
        if chunk.is_empty() {
            break;
        }
        let newline = chunk.iter().position(|b| *b == b'\n');
        let take = newline.map_or(chunk.len(), |n| n + 1);
        let content = if newline.is_some() { take - 1 } else { take };
        pending += take as u64;
        if !oversized {
            if content > limit.saturating_sub(buffer.len()) {
                oversized = true;
                buffer.clear();
            } else {
                buffer.extend_from_slice(&chunk[..content]);
            }
        }
        reader.consume(take);
        if newline.is_some() {
            result.lines += 1;
            if oversized {
                result.skipped += 1;
            } else {
                record(&buffer, result.offset)?;
            }
            result.offset += pending;
            pending = 0;
            oversized = false;
            buffer.clear();
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;
    #[test]
    fn skips_giant_record_and_does_not_commit_incomplete_tail() {
        let input = b"ok\nthis-is-too-long\nnext\npartial";
        let mut lines = Vec::new();
        let result = scan(io::BufReader::with_capacity(3, &input[..]), 4, |s| {
            lines.push(s.to_vec());
            Ok(())
        })
        .unwrap();
        assert_eq!(lines, vec![b"ok".to_vec(), b"next".to_vec()]);
        assert_eq!(result.skipped, 1);
        assert_eq!(result.offset, (input.len() - 7) as u64);
    }
}

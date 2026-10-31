use super::{jsonl, CoreResult, Emit};
use chrono::DateTime;
use rusqlite::{functions::FunctionFlags, params, params_from_iter, Connection, OptionalExtension};
use serde::{
    de::{SeqAccess, Visitor},
    Deserialize, Deserializer,
};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::{BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{Instant, SystemTime, UNIX_EPOCH},
};

pub const CACHE_KIB: usize = 8192;
pub const MAX_RESULTS: usize = 500;
const MAX_TEXT: usize = 2000;
const MAX_TERMS: usize = 32;
const SKIP: &[&str] = &[
    "<local-command",
    "<system-reminder>",
    "Caveat:",
    "<command-",
    "<task-notification>",
    "This session is being continued",
    "[Request interrupted",
];
type Result<T> = std::result::Result<T, String>;
fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}
fn millis(time: SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}
fn modified_stamp(metadata: &fs::Metadata) -> i64 {
    metadata
        .modified()
        .unwrap_or(UNIX_EPOCH)
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .min(i64::MAX as u128) as i64
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Record {
    #[serde(rename = "type")]
    kind: String,
    uuid: String,
    cwd: String,
    timestamp: String,
    #[serde(rename = "isSidechain")]
    sidechain: bool,
    #[serde(rename = "isMeta")]
    meta: bool,
    #[serde(rename = "isCompactSummary")]
    compact: bool,
    #[serde(rename = "customTitle")]
    custom_title: String,
    #[serde(rename = "aiTitle")]
    ai_title: String,
    message: Option<Message>,
}
#[derive(Deserialize, Default)]
#[serde(default)]
struct Message {
    content: Option<Content>,
}
enum Content {
    Text(String),
    Blocks { text: String, tool_result: bool },
}
impl<'de> Deserialize<'de> for Content {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        struct ContentVisitor;
        impl<'de> Visitor<'de> for ContentVisitor {
            type Value = Content;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("text or message blocks")
            }
            fn visit_str<E: serde::de::Error>(
                self,
                value: &str,
            ) -> std::result::Result<Content, E> {
                Ok(Content::Text(value.chars().take(MAX_TEXT).collect()))
            }
            fn visit_seq<A: SeqAccess<'de>>(
                self,
                mut sequence: A,
            ) -> std::result::Result<Content, A::Error> {
                let mut text = String::new();
                let mut left = MAX_TEXT;
                let mut tool_result = false;
                while let Some(block) = sequence.next_element::<Block>()? {
                    tool_result |= block.kind == "tool_result";
                    if block.kind != "text" || left == 0 {
                        continue;
                    }
                    if !text.is_empty() {
                        text.push('\n');
                        left = left.saturating_sub(1);
                    }
                    for character in block.text.chars().take(left) {
                        text.push(character);
                        left -= 1;
                    }
                }
                Ok(Content::Blocks { text, tool_result })
            }
        }
        deserializer.deserialize_any(ContentVisitor)
    }
}
#[derive(Deserialize, Default)]
#[serde(default)]
struct Block {
    #[serde(rename = "type")]
    kind: String,
    text: String,
}

fn message_text(record: &Record) -> Option<String> {
    if record.sidechain || record.meta || record.compact || record.uuid.is_empty() {
        return None;
    }
    let mut out = String::new();
    match record.message.as_ref()?.content.as_ref()? {
        Content::Text(text) if record.kind == "user" => out.extend(text.chars().take(MAX_TEXT)),
        Content::Blocks { text, tool_result } => {
            // Tool responses are not user search hits, even if they contain text blocks.
            if record.kind == "user" && *tool_result {
                return None;
            }
            out.push_str(text);
        }
        _ => return None,
    }
    let out = out.trim();
    if out.is_empty()
        || (record.kind == "user" && SKIP.iter().any(|prefix| out.starts_with(prefix)))
    {
        return None;
    }
    Some(out.to_owned())
}
#[derive(Default)]
struct Session {
    cwd: String,
    custom: String,
    ai: String,
    first: String,
    last: i64,
    seq: i64,
}
struct Previous {
    size: u64,
    mtime: i64,
    offset: u64,
    prefix_len: u64,
    prefix: String,
    anchor: String,
    session: Session,
}

pub struct Search {
    database: PathBuf,
    root: PathBuf,
    connection: Mutex<Option<Connection>>,
    emit: Emit,
    indexed: AtomicU64,
    messages: AtomicU64,
    skipped: AtomicU64,
}
impl Search {
    pub fn new(database: PathBuf, root: PathBuf, emit: Emit) -> Self {
        Self {
            database,
            root,
            connection: Mutex::new(None),
            emit,
            indexed: AtomicU64::new(0),
            messages: AtomicU64::new(0),
            skipped: AtomicU64::new(0),
        }
    }
    fn open(&self) -> Result<Connection> {
        fs::create_dir_all(
            self.database
                .parent()
                .ok_or("Search database has no parent")?,
        )
        .map_err(err)?;
        let db = Connection::open(&self.database).map_err(err)?;
        db.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
            PRAGMA cache_size=-8192; PRAGMA mmap_size=0; PRAGMA temp_store=FILE; PRAGMA wal_autocheckpoint=256; PRAGMA busy_timeout=2500;
            CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,file TEXT NOT NULL,size INTEGER NOT NULL,mtime INTEGER NOT NULL,offset INTEGER NOT NULL,
              prefix_len INTEGER NOT NULL,prefix TEXT NOT NULL,anchor TEXT NOT NULL,cwd TEXT NOT NULL,custom TEXT NOT NULL,ai TEXT NOT NULL,first TEXT NOT NULL,last INTEGER NOT NULL,seq INTEGER NOT NULL,seen INTEGER NOT NULL DEFAULT 1);
            CREATE TABLE IF NOT EXISTS messages(session TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,seq INTEGER NOT NULL,uuid TEXT NOT NULL,
              role TEXT NOT NULL,text TEXT NOT NULL,lc TEXT NOT NULL,ts INTEGER NOT NULL,PRIMARY KEY(session,seq));
            CREATE INDEX IF NOT EXISTS messages_session ON messages(session);").map_err(err)?;
        Ok(db)
    }
    fn with_db<T>(&self, f: impl FnOnce(&mut Connection) -> Result<T>) -> Result<T> {
        let mut guard = self.connection.lock().map_err(err)?;
        if guard.is_none() {
            *guard = Some(self.open()?);
        }
        f(guard.as_mut().unwrap())
    }
    fn files(&self) -> Result<Vec<PathBuf>> {
        let mut out = Vec::new();
        let dirs = match fs::read_dir(&self.root) {
            Ok(d) => d,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
            Err(e) => return Err(err(e)),
        };
        for dir in dirs {
            let dir = dir.map_err(err)?;
            if !dir.file_type().map_err(err)?.is_dir() {
                continue;
            }
            let files = match fs::read_dir(dir.path()) {
                Ok(f) => f,
                Err(_) => continue,
            };
            for file in files {
                let file = file.map_err(err)?;
                if file.file_type().map_err(err)?.is_file()
                    && file.path().extension().is_some_and(|e| e == "jsonl")
                {
                    out.push(file.path());
                }
            }
        }
        out.sort();
        Ok(out)
    }
    fn refresh(&self, db: &mut Connection) -> Result<()> {
        let files = self.files()?;
        db.execute("UPDATE sessions SET seen=0", []).map_err(err)?;
        let total = files.len();
        let mut last_progress = Instant::now();
        for (n, file) in files.iter().enumerate() {
            let id = file
                .file_stem()
                .ok_or("Invalid transcript filename")?
                .to_string_lossy()
                .into_owned();
            // Mark an existing entry even when its file is temporarily unreadable.
            db.execute("UPDATE sessions SET seen=1 WHERE id=?1", [&id])
                .map_err(err)?;
            self.index_file(db, &id, file)?;
            if total > 3 && (last_progress.elapsed().as_millis() >= 120 || n + 1 == total) {
                (self.emit)("search:progress", json!({"done":n+1,"total":total}));
                last_progress = Instant::now();
            }
        }
        db.execute("DELETE FROM sessions WHERE seen=0", [])
            .map_err(err)?;
        self.indexed.store(
            db.query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get::<_, i64>(0))
                .map_err(err)? as u64,
            Ordering::Relaxed,
        );
        self.messages.store(
            db.query_row("SELECT COUNT(*) FROM messages", [], |r| r.get::<_, i64>(0))
                .map_err(err)? as u64,
            Ordering::Relaxed,
        );
        Ok(())
    }
    fn index_file(&self, db: &mut Connection, id: &str, path: &Path) -> Result<()> {
        let mut file = match File::open(path) {
            Ok(f) => f,
            Err(_) => return Ok(()),
        };
        let metadata = file.metadata().map_err(err)?;
        let size = metadata.len();
        let mtime = modified_stamp(&metadata);
        let previous=db.query_row("SELECT size,mtime,offset,prefix_len,prefix,anchor,cwd,custom,ai,first,last,seq FROM sessions WHERE id=?1 AND file=?2",params![id,path.to_string_lossy()],|r|Ok(Previous{
            size:r.get::<_,i64>(0)? as u64,mtime:r.get(1)?,offset:r.get::<_,i64>(2)? as u64,prefix_len:r.get::<_,i64>(3)? as u64,prefix:r.get(4)?,anchor:r.get(5)?,
            session:Session{cwd:r.get(6)?,custom:r.get(7)?,ai:r.get(8)?,first:r.get(9)?,last:r.get(10)?,seq:r.get(11)?}})).optional().map_err(err)?;
        if previous
            .as_ref()
            .is_some_and(|p| p.size == size && p.mtime == mtime)
        {
            return Ok(());
        }
        let append = if let Some(p) = &previous {
            size > p.size
                && size >= p.offset
                && fingerprint(&mut file, 0, p.prefix_len)? == p.prefix
                && fingerprint(&mut file, p.offset.saturating_sub(4096), p.offset.min(4096))?
                    == p.anchor
        } else {
            false
        };
        let offset = if append {
            previous.as_ref().unwrap().offset
        } else {
            0
        };
        let mut session = if append {
            previous.unwrap().session
        } else {
            Session::default()
        };
        let transaction = db.transaction().map_err(err)?;
        if !append {
            transaction
                .execute("DELETE FROM sessions WHERE id=?1", [id])
                .map_err(err)?;
        }
        transaction.execute("INSERT OR IGNORE INTO sessions(id,file,size,mtime,offset,prefix_len,prefix,anchor,cwd,custom,ai,first,last,seq,seen) VALUES(?1,?2,0,0,0,0,'','','','','','',0,0,1)",params![id,path.to_string_lossy()]).map_err(err)?;
        file.seek(SeekFrom::Start(offset)).map_err(err)?;
        let scan = jsonl::scan(
            BufReader::with_capacity(64 * 1024, (&mut file).take(size - offset)),
            jsonl::MAX_RECORD,
            |line| {
                let record = match serde_json::from_slice::<Record>(line) {
                    Ok(r) => r,
                    Err(_) => return Ok(()),
                };
                if record.uuid.len() > 512
                    || record.cwd.len() > 32768
                    || record.custom_title.len() > 8192
                    || record.ai_title.len() > 8192
                {
                    return Ok(());
                }
                if session.cwd.is_empty() && !record.cwd.is_empty() {
                    session.cwd = record.cwd.clone();
                }
                match record.kind.as_str() {
                    "custom-title" => {
                        if !record.custom_title.is_empty() {
                            session.custom = record.custom_title;
                        }
                        return Ok(());
                    }
                    "ai-title" => {
                        if !record.ai_title.is_empty() {
                            session.ai = record.ai_title;
                        }
                        return Ok(());
                    }
                    "user" | "assistant" => {}
                    _ => return Ok(()),
                }
                let Some(text) = message_text(&record) else {
                    return Ok(());
                };
                let ts = DateTime::parse_from_rfc3339(&record.timestamp)
                    .map(|t| t.timestamp_millis())
                    .unwrap_or(0);
                if record.kind == "user" && session.first.is_empty() {
                    session.first = text
                        .split_whitespace()
                        .collect::<Vec<_>>()
                        .join(" ")
                        .chars()
                        .take(80)
                        .collect();
                }
                session.last = session.last.max(ts);
                session.seq += 1;
                transaction.execute("INSERT INTO messages(session,seq,uuid,role,text,lc,ts) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![id,session.seq,record.uuid,record.kind,text,text.to_lowercase(),ts]).map_err(err)?;
                Ok(())
            },
        )?;
        // Do not publish a mixed snapshot when a writer replaced the file during indexing.
        let after = fs::metadata(path).map_err(err)?;
        if after.len() != size || modified_stamp(&after) != mtime {
            return Ok(());
        }
        let offset = offset + scan.offset;
        let prefix_len = offset.min(4096);
        let prefix = fingerprint(&mut file, 0, prefix_len)?;
        let anchor = fingerprint(&mut file, offset.saturating_sub(4096), offset.min(4096))?;
        transaction.execute("UPDATE sessions SET file=?2,size=?3,mtime=?4,offset=?5,prefix_len=?6,prefix=?7,anchor=?8,cwd=?9,custom=?10,ai=?11,first=?12,last=?13,seq=?14,seen=1 WHERE id=?1",params![id,path.to_string_lossy(),size as i64,mtime,offset as i64,prefix_len as i64,prefix,anchor,session.cwd,session.custom,session.ai,session.first,session.last,session.seq]).map_err(err)?;
        transaction.commit().map_err(err)?;
        self.skipped.fetch_add(scan.skipped, Ordering::Relaxed);
        Ok(())
    }
    pub fn query(&self, opts: &Value) -> CoreResult {
        let query = opts["q"].as_str().unwrap_or("");
        if query.len() > 4096 {
            return Err("Search query exceeds 4096 bytes".into());
        }
        let mut seen = HashSet::new();
        let words: Vec<String> = query
            .to_lowercase()
            .split_whitespace()
            .filter(|s| seen.insert(s.to_string()))
            .map(str::to_owned)
            .collect();
        if words.len() > MAX_TERMS {
            return Err("Too many search terms".into());
        }
        if words.is_empty() {
            return Ok(json!([]));
        }
        let limit = opts["limit"]
            .as_u64()
            .unwrap_or(60)
            .clamp(1, MAX_RESULTS as u64) as usize;
        self.with_db(|db|{
            self.refresh(db)?;
            let scoring=words.clone();let now=millis(SystemTime::now());
            db.create_scalar_function("duet_score",2,FunctionFlags::SQLITE_UTF8|FunctionFlags::SQLITE_DETERMINISTIC,move|ctx|{
                let text=ctx.get::<String>(0)?;let ts=ctx.get::<i64>(1)?;
                let count=scoring.iter().map(|w|text.matches(w.as_str()).take(10).count()).sum::<usize>().min(12);
                let age=(now.saturating_sub(ts).max(0) as f64)/86400000.0;
                Ok(count as f64+6.0*(-age/21.0).exp())
            }).map_err(err)?;
            let filters=(1..=words.len()).map(|n|format!("instr(m.lc,?{n})>0")).collect::<Vec<_>>().join(" AND ");
            let sql=format!("WITH ranked AS (SELECT s.id,s.cwd,COALESCE(NULLIF(s.custom,''),NULLIF(s.ai,''),NULLIF(s.first,''),'Untitled') AS title,
                m.uuid,m.role,m.text,m.lc,CASE WHEN m.ts>0 THEN m.ts ELSE s.last END AS ts,
                duet_score(m.lc,m.ts)+CASE WHEN m.role='user' THEN 0.5 ELSE 0 END AS score,
                ROW_NUMBER() OVER(PARTITION BY s.id ORDER BY duet_score(m.lc,m.ts)+CASE WHEN m.role='user' THEN 0.5 ELSE 0 END DESC,m.seq) AS slot
                FROM messages m JOIN sessions s ON m.session=s.id WHERE {filters})
                SELECT id,cwd,title,uuid,role,text,lc,ts,score FROM ranked WHERE slot<=3 ORDER BY score DESC,ts DESC LIMIT ?{}",words.len()+1);
            let mut statement=db.prepare(&sql).map_err(err)?;
            let mut bindings:Vec<rusqlite::types::Value>=words.iter().map(|s|rusqlite::types::Value::Text(s.clone())).collect();bindings.push((limit as i64).into());
            let rows=statement.query_map(params_from_iter(bindings),|row|{
                let text=row.get::<_,String>(5)?;let lc=row.get::<_,String>(6)?;
                Ok(json!({"sessionId":row.get::<_,String>(0)?,"cwd":row.get::<_,String>(1)?,"title":row.get::<_,String>(2)?,"uuid":row.get::<_,String>(3)?,"role":row.get::<_,String>(4)?,
                    "snippet":snippet(&text,&lc,&words),"ts":row.get::<_,i64>(7)?,"score":(row.get::<_,f64>(8)?*100.0).round()/100.0}))
            }).map_err(err)?;
            Ok(Value::Array(rows.collect::<std::result::Result<Vec<_>,_>>().map_err(err)?))
        })
    }
    pub fn reindex(&self) -> CoreResult {
        self.with_db(|db|{db.execute("DELETE FROM sessions",[]).map_err(err)?;self.skipped.store(0,Ordering::Relaxed);self.refresh(db)?;Ok(json!({"sessions":self.indexed.load(Ordering::Relaxed),"messages":self.messages.load(Ordering::Relaxed)}))})
    }
    pub fn stats(&self) -> Value {
        json!({"storage":"sqlite","sessions":self.indexed.load(Ordering::Relaxed),"messages":self.messages.load(Ordering::Relaxed),"oversizedRecordsSkipped":self.skipped.load(Ordering::Relaxed)})
    }
}
fn fingerprint(file: &mut File, start: u64, len: u64) -> Result<String> {
    file.seek(SeekFrom::Start(start)).map_err(err)?;
    let mut bytes = vec![0; len as usize];
    file.read_exact(&mut bytes).map_err(err)?;
    let hash = bytes.iter().fold(0xcbf29ce484222325u64, |hash, b| {
        (hash ^ (*b as u64)).wrapping_mul(0x100000001b3)
    });
    Ok(format!("{hash:016x}"))
}
fn snippet(text: &str, lc: &str, words: &[String]) -> String {
    // Lowercasing can change UTF-8 lengths. Match in lowercased characters, never byte-slice original text.
    let at = words
        .iter()
        .filter_map(|w| lc.find(w))
        .min()
        .map(|n| lc[..n].chars().count())
        .unwrap_or(0);
    let chars: Vec<char> = text.chars().collect();
    let start = at.saturating_sub(80).min(chars.len());
    let end =
        (at + 80 + words.iter().map(|w| w.chars().count()).max().unwrap_or(0)).min(chars.len());
    let body = chars[start..end.max(start)]
        .iter()
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        "{}{}{}",
        if start > 0 { "…" } else { "" },
        body,
        if end < chars.len() { "…" } else { "" }
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    fn record(uuid: &str, text: &str) -> String {
        format!(
            "{}\n",
            json!({"type":"user","uuid":uuid,"cwd":"/project","timestamp":"2026-10-30T10:00:00Z","message":{"content":text}})
        )
    }
    #[test]
    fn disk_index_handles_unicode_append_partial_tail_rewrite_and_delete() {
        let root = tempfile::tempdir().unwrap();
        let projects = root.path().join("projects/p");
        fs::create_dir_all(&projects).unwrap();
        let file = projects.join("chat.jsonl");
        fs::write(&file, record("one", "Привет Rust index")).unwrap();
        let path = root.path().join("cache/search.sqlite3");
        {
            let search = Search::new(
                path.clone(),
                root.path().join("projects"),
                std::sync::Arc::new(|_, _| {}),
            );
            let hits = search.query(&json!({"q":"прив РУСТ"})).unwrap();
            assert!(hits.as_array().unwrap().is_empty());
            assert_eq!(
                search.query(&json!({"q":"ПРИВЕТ rust"})).unwrap()[0]["uuid"],
                "one"
            );
            let mut writer = fs::OpenOptions::new().append(true).open(&file).unwrap();
            let next = record("two", "another incremental hit");
            writer.write_all(next.trim_end().as_bytes()).unwrap();
            writer.flush().unwrap();
            assert!(search
                .query(&json!({"q":"incremental"}))
                .unwrap()
                .as_array()
                .unwrap()
                .is_empty());
            writer.write_all(b"\n").unwrap();
            drop(writer);
            assert_eq!(
                search.query(&json!({"q":"incremental"})).unwrap()[0]["uuid"],
                "two"
            );
            assert_eq!(
                search
                    .query(&json!({"q":"incremental"}))
                    .unwrap()
                    .as_array()
                    .unwrap()
                    .len(),
                1
            );
        }
        // Restart: reuse the on-disk index, without a retained in-memory transcript map.
        let search = Search::new(
            path,
            root.path().join("projects"),
            std::sync::Arc::new(|_, _| {}),
        );
        assert_eq!(
            search.query(&json!({"q":"incremental"})).unwrap()[0]["uuid"],
            "two"
        );
        fs::write(&file, record("new", "replacement session")).unwrap();
        assert!(search
            .query(&json!({"q":"incremental"}))
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty());
        assert_eq!(
            search.query(&json!({"q":"replacement"})).unwrap()[0]["uuid"],
            "new"
        );
        fs::remove_file(&file).unwrap();
        assert!(search
            .query(&json!({"q":"replacement"}))
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty());
    }
    #[test]
    fn titles_filters_and_per_session_limits() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("p");
        fs::create_dir(&dir).unwrap();
        let mut text = (0..8)
            .map(|n| record(&n.to_string(), "needle hit"))
            .collect::<String>();
        text += &format!(
            "{}\n",
            json!({"type":"custom-title","customTitle":"Renamed title"})
        );
        text += &format!(
            "{}\n",
            json!({"type":"user","uuid":"tool","message":{"content":[{"type":"tool_result","content":"needle"}]}})
        );
        text += &format!(
            "{}\n",
            json!({"type":"assistant","uuid":"side","isSidechain":true,"message":{"content":[{"type":"text","text":"needle"}]}})
        );
        fs::write(dir.join("id.jsonl"), text).unwrap();
        let search = Search::new(
            root.path().join("db/search.sqlite3"),
            root.path().to_owned(),
            std::sync::Arc::new(|_, _| {}),
        );
        let hits = search.query(&json!({"q":"needle"})).unwrap();
        assert_eq!(hits.as_array().unwrap().len(), 3);
        assert_eq!(hits[0]["title"], "Renamed title");
        assert_eq!(search.reindex().unwrap()["messages"], 8);
    }
}

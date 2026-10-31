use super::{
    events::{self, arr, s},
    jsonl,
    storage::{self, Storage},
    wire_json, CoreResult,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fs::{self, File},
    io::{BufReader, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::UNIX_EPOCH,
};
const PAGE_TURNS: i64 = 40;
const PAGE_BYTES: usize = 8 * 1024 * 1024;
const RESPONSE_BYTES: usize = 64 * 1024 * 1024;
fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn modified(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .unwrap_or(UNIX_EPOCH)
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .min(i64::MAX as u128) as i64
}
#[derive(Deserialize, Default)]
#[serde(default)]
struct Meta {
    #[serde(rename = "type")]
    kind: String,
    subtype: String,
    uuid: String,
    #[serde(rename = "parentUuid")]
    parent: Option<String>,
    #[serde(rename = "logicalParentUuid")]
    logical: Option<String>,
    #[serde(rename = "isSidechain")]
    sidechain: bool,
    timestamp: Option<String>,
    payload: PayloadMeta,
}
#[derive(Deserialize, Default)]
#[serde(default)]
struct PayloadMeta {
    #[serde(rename = "type")]
    kind: String,
}
pub struct History {
    storage: Arc<Storage>,
    claude_root: PathBuf,
    db: Mutex<Option<Connection>>,
}
impl History {
    pub fn new(storage: Arc<Storage>, claude_root: PathBuf) -> Self {
        Self {
            storage,
            claude_root,
            db: Mutex::new(None),
        }
    }
    fn with_db<T>(
        &self,
        f: impl FnOnce(&mut Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut guard = self.db.lock().map_err(error)?;
        if guard.is_none() {
            let path = self.storage.data.join("native/history.sqlite3");
            fs::create_dir_all(path.parent().unwrap()).map_err(error)?;
            let db = Connection::open(path).map_err(error)?;
            db.execute_batch("PRAGMA journal_mode=WAL;PRAGMA synchronous=NORMAL;PRAGMA cache_size=-8192;PRAGMA temp_store=FILE;PRAGMA mmap_size=0;PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS history_files(path TEXT PRIMARY KEY,size INTEGER,stamp INTEGER,recorded INTEGER);
        CREATE TABLE IF NOT EXISTS history_nodes(path TEXT,uuid TEXT,parent TEXT,logical TEXT,boundary INTEGER,sidechain INTEGER,kind TEXT,idx INTEGER,pos INTEGER,len INTEGER,ts TEXT,PRIMARY KEY(path,uuid));
        CREATE INDEX IF NOT EXISTS nodes_order ON history_nodes(path,idx);
        CREATE TABLE IF NOT EXISTS history_sources(source TEXT PRIMARY KEY,path TEXT,size INTEGER,stamp INTEGER,turns INTEGER);
        CREATE TABLE IF NOT EXISTS history_events(source TEXT REFERENCES history_sources(source) ON DELETE CASCADE,seq INTEGER,turn INTEGER,event TEXT,bytes INTEGER,PRIMARY KEY(source,seq));
        CREATE INDEX IF NOT EXISTS events_turn ON history_events(source,turn,seq);
        CREATE TABLE IF NOT EXISTS history_state(source TEXT,space TEXT,key TEXT,name TEXT,value TEXT,PRIMARY KEY(source,space,key));
        CREATE INDEX IF NOT EXISTS history_state_name ON history_state(source,space,name);").map_err(error)?;
            *guard = Some(db);
        }
        f(guard.as_mut().unwrap())
    }
    pub fn list(&self) -> CoreResult {
        let overrides = self.storage.read("native/session-metadata.json");
        let mut out = Vec::new();
        for provider in ["claude", "codex", "antigravity", "gemini"] {
            let mut entries = self.catalog(provider)?;
            entries.sort_by_key(|v| std::cmp::Reverse(v["lastModified"].as_u64().unwrap_or(0)));
            let limit = match provider {
                "claude" => 300,
                "codex" => 200,
                _ => usize::MAX,
            };
            for mut entry in entries.into_iter().take(limit) {
                let id = s(&entry, "sessionId").to_owned();
                if overrides[&id]["deleted"] == true {
                    continue;
                }
                if let Some(title) = overrides[&id]["title"].as_str() {
                    entry["title"] = json!(title);
                }
                out.push(entry);
            }
        }
        out.sort_by_key(|v| std::cmp::Reverse(v["lastModified"].as_u64().unwrap_or(0)));
        Ok(json!(out))
    }
    fn catalog(&self, provider: &str) -> Result<Vec<Value>, String> {
        if matches!(provider, "antigravity" | "gemini") {
            let root = self.storage.data.join(provider);
            let mut entries = Vec::new();
            if let Ok(files) = fs::read_dir(root) {
                for file in files.flatten() {
                    if file.path().extension().is_some_and(|e| e == "json") {
                        let mut meta = storage::read_json(&file.path());
                        let id = s(&meta, "sessionId");
                        if valid_id(provider, id) {
                            if let Some(map) = meta.as_object_mut() {
                                map.remove("nativeId");
                                map.remove("rewound");
                            }
                            entries.push(meta);
                        }
                    }
                }
            }
            return Ok(entries);
        }
        let files = if provider == "claude" {
            list_files(&self.claude_root, 1)
        } else {
            list_files(&self.storage.codex_home().join("sessions"), 8)
        };
        let names = if provider == "codex" {
            self.codex_names()
        } else {
            std::collections::HashMap::new()
        };
        let mut entries = Vec::new();
        for file in files {
            let stem = file.file_stem().unwrap_or_default().to_string_lossy();
            let candidate = if provider == "claude" {
                stem.as_ref()
            } else {
                stem.get(stem.len().saturating_sub(36)..).unwrap_or("")
            };
            if !valid_id(provider, candidate) {
                continue;
            }
            let metadata = match fs::metadata(&file) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let mut id = candidate.to_owned();
            let mut cwd = String::new();
            let mut title = String::new();
            let mut first = String::new();
            let mut created = metadata
                .created()
                .or_else(|_| metadata.modified())
                .ok()
                .map(|t| t.duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64)
                .unwrap_or(0);
            let mut branch = None;
            for bytes in read_edges(&file).unwrap_or_default() {
                let value = match wire_json::parse(&bytes) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if cwd.is_empty() {
                    cwd = s(&value, "cwd").to_owned();
                }
                if branch.is_none() {
                    branch = value["gitBranch"].as_str().map(str::to_owned);
                }
                if provider == "claude" {
                    match s(&value, "type") {
                        "custom-title" => title = s(&value, "customTitle").to_owned(),
                        "ai-title" if title.is_empty() => title = s(&value, "aiTitle").to_owned(),
                        "user" if first.is_empty() && value["isSidechain"] != true => {
                            if let Some(user) = events::user_text(&value["message"]["content"]) {
                                first = s(&user, "text")
                                    .lines()
                                    .next()
                                    .unwrap_or("")
                                    .chars()
                                    .take(120)
                                    .collect();
                            }
                        }
                        _ => {}
                    }
                } else {
                    let payload = &value["payload"];
                    if s(&value, "type") == "session_meta" {
                        if valid_id("codex", s(payload, "id")) {
                            id = s(payload, "id").to_owned();
                        }
                        cwd = s(payload, "cwd").to_owned();
                        if let Some(ts) = events::timestamp(&payload["timestamp"]) {
                            created = ts.max(0) as u64;
                        }
                        branch = payload["git"]["branch"].as_str().map(str::to_owned);
                    }
                    if s(&value, "type") == "event_msg"
                        && s(payload, "type") == "user_message"
                        && first.is_empty()
                    {
                        first = events::readable_user(s(payload, "message"))
                            .lines()
                            .next()
                            .unwrap_or("")
                            .chars()
                            .take(120)
                            .collect();
                    }
                }
            }
            if title.is_empty() {
                title = names.get(&id).cloned().unwrap_or(first);
            }
            if title.is_empty() {
                title = if provider == "claude" {
                    "Claude".into()
                } else {
                    "Codex".into()
                };
            }
            entries.push(json!({"sessionId":id,"provider":provider,"title":title,"cwd":cwd,"gitBranch":branch,"createdAt":created,"lastModified":metadata.modified().unwrap_or(UNIX_EPOCH).duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64,"nativeFile":file}));
        }
        Ok(entries)
    }
    fn codex_names(&self) -> std::collections::HashMap<String, String> {
        let mut names = std::collections::HashMap::new();
        let path = self.storage.codex_home().join("session_index.jsonl");
        if let Ok(file) = File::open(path) {
            let _ = jsonl::scan(BufReader::new(file), 1024 * 1024, |line| {
                if let Ok(value) = wire_json::parse(line) {
                    let id = s(&value, "id");
                    if !id.is_empty() {
                        names.insert(id.to_owned(), s(&value, "thread_name").to_owned());
                    }
                }
                Ok(())
            });
        }
        names
    }
    pub fn find(&self, provider: &str, id: &str, cwd: Option<&str>) -> Result<PathBuf, String> {
        if !valid_id(provider, id) {
            return Err("Invalid session id".into());
        }
        if matches!(provider, "antigravity" | "gemini") {
            let path = self.storage.data.join(provider).join(format!("{id}.jsonl"));
            if path.exists() {
                return Ok(path);
            }
            if self
                .storage
                .data
                .join(provider)
                .join(format!("{id}.json"))
                .exists()
            {
                return Ok(path);
            }
            return Err("Session was not found".into());
        }
        if provider == "claude" {
            if let Some(cwd) = cwd {
                let folder = cwd
                    .chars()
                    .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
                    .collect::<String>();
                let path = self.claude_root.join(folder).join(format!("{id}.jsonl"));
                if path.is_file() {
                    return Ok(path);
                }
            }
            for path in list_files(&self.claude_root, 1) {
                if path.file_stem().is_some_and(|s| s == id) {
                    return Ok(path);
                }
            }
        } else if provider == "codex" {
            for path in list_files(&self.storage.codex_home().join("sessions"), 8) {
                if path
                    .file_stem()
                    .is_some_and(|s| s.to_string_lossy().ends_with(id))
                {
                    return Ok(path);
                }
            }
        }
        Err("Session was not found".into())
    }
    fn node_index(&self, db: &mut Connection, path: &Path) -> Result<bool, String> {
        let metadata = fs::metadata(path).map_err(error)?;
        let stamp = modified(&metadata);
        let name = path.to_string_lossy();
        let previous = db
            .query_row(
                "SELECT size,stamp,recorded FROM history_files WHERE path=?1",
                [name.as_ref()],
                |row| {
                    Ok((
                        row.get::<_, u64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, bool>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(error)?;
        if let Some((size, time, recorded)) = previous {
            if size == metadata.len() && time == stamp {
                return Ok(recorded);
            }
        }
        let tx = db.transaction().map_err(error)?;
        tx.execute("DELETE FROM history_nodes WHERE path=?1", [name.as_ref()])
            .map_err(error)?;
        let mut index = 0i64;
        let mut recorded = false;
        let file = File::open(path).map_err(error)?;
        jsonl::scan_at(
            BufReader::with_capacity(64 * 1024, file.take(metadata.len())),
            jsonl::MAX_RECORD,
            |line, pos| {
                index += 1;
                let header: Meta = match serde_json::from_slice(line) {
                    Ok(m) => m,
                    Err(_) => return Ok(()),
                };
                if header.kind == "event_msg" && header.payload.kind == "item_completed" {
                    recorded = true;
                }
                if header.uuid.is_empty() {
                    return Ok(());
                }
                if header.uuid.len() > 512 {
                    return Err("Invalid transcript anchor length".into());
                }
                tx.execute("INSERT OR REPLACE INTO history_nodes(path,uuid,parent,logical,boundary,sidechain,kind,idx,pos,len,ts)VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",params![name.as_ref(),header.uuid,header.parent,header.logical,header.kind=="system"&&header.subtype=="compact_boundary",header.sidechain,header.kind,index,pos as i64,line.len() as i64,header.timestamp]).map_err(error)?;
                Ok(())
            },
        )?;
        tx.execute("INSERT INTO history_files(path,size,stamp,recorded)VALUES(?1,?2,?3,?4)ON CONFLICT(path)DO UPDATE SET size=excluded.size,stamp=excluded.stamp,recorded=excluded.recorded",params![name.as_ref(),metadata.len(),stamp,recorded]).map_err(error)?;
        tx.commit().map_err(error)?;
        Ok(recorded)
    }
    fn ensure(
        &self,
        db: &mut Connection,
        provider: &str,
        id: &str,
        cwd: Option<&str>,
        segment: Option<i64>,
        agent: Option<&str>,
        explicit: Option<&Path>,
    ) -> Result<String, String> {
        let path = explicit
            .map(Path::to_owned)
            .map(Ok)
            .unwrap_or_else(|| self.find(provider, id, cwd))?;
        let metadata = fs::metadata(&path).map_err(error)?;
        let stamp = modified(&metadata);
        let source = format!(
            "{provider}:{id}:{}:{}",
            segment
                .map(|s| s.to_string())
                .unwrap_or_else(|| "current".into()),
            agent.unwrap_or("main")
        );
        let previous = db
            .query_row(
                "SELECT size,stamp FROM history_sources WHERE source=?1",
                [&source],
                |row| Ok((row.get::<_, u64>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()
            .map_err(error)?;
        if previous == Some((metadata.len(), stamp)) {
            return Ok(source);
        }
        let recorded = self.node_index(db, &path)?;
        let tx = db.transaction().map_err(error)?;
        tx.execute("DELETE FROM history_sources WHERE source=?1", [&source])
            .map_err(error)?;
        tx.execute("DELETE FROM history_state WHERE source=?1", [&source])
            .map_err(error)?;
        tx.execute(
            "INSERT INTO history_sources(source,path,size,stamp,turns)VALUES(?1,?2,?3,?4,0)",
            params![source, path.to_string_lossy(), metadata.len(), stamp],
        )
        .map_err(error)?;
        let seq = std::cell::Cell::new(0i64);
        let turn = std::cell::Cell::new(0i64);
        let insert = |events: Vec<Value>| -> Result<(), String> {
            for event in events {
                if s(&event, "type") == "user"
                    || (agent.is_some() && s(&event, "type") == "agent.msg" && event["dir"] == "to")
                {
                    turn.set(turn.get() + 1);
                } else if turn.get() == 0 {
                    turn.set(1);
                }
                seq.set(seq.get() + 1);
                let text = serde_json::to_string(&event).map_err(error)?;
                tx.execute(
                    "INSERT INTO history_events(source,seq,turn,event,bytes)VALUES(?1,?2,?3,?4,?5)",
                    params![source, seq.get(), turn.get(), text, text.len()],
                )
                .map_err(error)?;
            }
            Ok(())
        };
        let state = events::HistoryState {
            db: &tx,
            source: &source,
        };
        if provider == "claude" && agent.is_none() {
            let path_name = path.to_string_lossy();
            let leaf = if let Some(segment) = segment {
                tx.query_row("SELECT logical FROM history_nodes WHERE path=?1 AND boundary=1 AND sidechain=0 ORDER BY idx LIMIT 1 OFFSET ?2",params![path_name.as_ref(),segment],|r|r.get::<_,Option<String>>(0)).optional().map_err(error)?.flatten()
            } else {
                tx.query_row("SELECT uuid FROM history_nodes WHERE path=?1 AND sidechain=0 AND kind IN('user','assistant')ORDER BY idx DESC LIMIT 1",[path_name.as_ref()],|r|r.get::<_,String>(0)).optional().map_err(error)?
            };
            if let Some(leaf) = leaf {
                let mut statement=tx.prepare("WITH RECURSIVE chain(uuid,parent,idx,pos,len,boundary)AS(SELECT uuid,parent,idx,pos,len,boundary FROM history_nodes WHERE path=?1 AND uuid=?2 UNION ALL SELECT n.uuid,n.parent,n.idx,n.pos,n.len,n.boundary FROM history_nodes n JOIN chain c ON n.uuid=c.parent WHERE n.path=?1 AND c.boundary=0 AND n.idx<c.idx)SELECT pos,len FROM chain WHERE boundary=0 ORDER BY idx").map_err(error)?;
                let rows = statement
                    .query_map(params![path_name.as_ref(), leaf], |r| {
                        Ok((r.get::<_, u64>(0)?, r.get::<_, usize>(1)?))
                    })
                    .map_err(error)?;
                let mut file = File::open(&path).map_err(error)?;
                for row in rows {
                    let (pos, len) = row.map_err(error)?;
                    if len > jsonl::MAX_RECORD {
                        continue;
                    }
                    file.seek(SeekFrom::Start(pos)).map_err(error)?;
                    let mut bytes = vec![0; len];
                    file.read_exact(&mut bytes).map_err(error)?;
                    let record = wire_json::parse(&bytes)?;
                    insert(events::claude_history(&record, &state, None)?)?;
                }
            }
        } else {
            let file = File::open(&path).map_err(error)?;
            let mut raw = CodexRollout::new(recorded);
            jsonl::scan(
                BufReader::with_capacity(64 * 1024, file.take(metadata.len())),
                jsonl::MAX_RECORD,
                |line| {
                    let record = match wire_json::parse(line) {
                        Ok(r) => r,
                        Err(_) => return Ok(()),
                    };
                    let events = if provider == "claude" {
                        events::claude_history(&record, &state, agent)?
                    } else if provider == "codex" {
                        if s(&record, "type") == "event_msg"
                            && s(&record["payload"], "type") == "thread_rolled_back"
                        {
                            let drop = record["payload"]["num_turns"].as_i64().unwrap_or(0).max(0);
                            turn.set(turn.get().saturating_sub(drop));
                            tx.execute(
                                "DELETE FROM history_events WHERE source=?1 AND turn>?2",
                                params![source, turn.get()],
                            )
                            .map_err(error)?;
                            return Ok(());
                        }
                        raw.push(&record)
                    } else {
                        vec![record]
                    };
                    // subagent events are tagged independently of the lead's event ids.
                    let events = if provider == "codex" {
                        if let Some(agent) = agent {
                            events.into_iter().filter_map(|mut event|{if s(&event,"type")=="user"{Some(json!({"type":"agent.msg","agent":agent,"dir":"to","label":"message","text":event["text"],"dedupe":true}))}else if matches!(s(&event,"type"),"text"|"thinking"|"tool"|"tool.result"|"tool.output"){event["agent"]=json!(agent);Some(event)}else{None}}).collect()
                        } else {
                            events
                        }
                    } else {
                        events
                    };
                    insert(events)
                },
            )?;
        }
        let after = fs::metadata(&path).map_err(error)?;
        if after.len() < metadata.len()
            || (after.len() == metadata.len() && modified(&after) != stamp)
        {
            return Err("Transcript changed while indexing; retry".into());
        }
        tx.execute(
            "UPDATE history_sources SET turns=?2 WHERE source=?1",
            params![source, turn.get()],
        )
        .map_err(error)?;
        tx.commit().map_err(error)?;
        Ok(source)
    }
    pub fn load(
        &self,
        id: &str,
        cwd: Option<&str>,
        segment: Option<i64>,
        provider: &str,
        page: Option<&Value>,
    ) -> CoreResult {
        self.with_db(|db| {
            let source = self.ensure(db, provider, id, cwd, segment, None, None)?;
            self.read_page(db, &source, page)
        })
    }
    pub fn subagent_page(
        &self,
        id: &str,
        cwd: Option<&str>,
        provider: &str,
        agent: &str,
        page: &Value,
    ) -> CoreResult {
        if agent.is_empty() || agent.len() > 256 {
            return Err("Invalid agent id".into());
        }
        let delegates = self.storage.read("native/delegates.json");
        if let Some(link) = delegates[id].get(agent) {
            let child_provider = s(link, "provider");
            let mut result =
                self.load(s(link, "sessionId"), cwd, None, child_provider, Some(page))?;
            result["events"] = json!(arr(&result["events"])
                .iter()
                .filter_map(|e| as_agent(e.clone(), agent))
                .collect::<Vec<_>>());
            result["found"] = json!(true);
            return Ok(result);
        }
        let path = self.find(provider, id, cwd)?;
        let selected = if provider == "claude" {
            let root = path.with_extension("").join("subagents");
            let mut hit = None;
            for p in list_files(&root, 5) {
                let meta = storage::read_json(&p.with_extension("meta.json"));
                let native = p
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .trim_start_matches("agent-");
                if s(&meta, "toolUseId") == agent || native == agent {
                    hit = Some(p);
                    break;
                }
            }
            hit
        } else if provider == "codex" {
            let mut child = agent.strip_prefix("agent-").map(str::to_owned);
            if child.is_none() {
                jsonl::scan(
                    BufReader::new(File::open(&path).map_err(error)?),
                    jsonl::MAX_RECORD,
                    |line| {
                        if child.is_some() {
                            return Ok(());
                        }
                        let Ok(record) = wire_json::parse(line) else {
                            return Ok(());
                        };
                        let p = &record["payload"];
                        if p["type"] == "item_completed" {
                            let item = recorded_item(&p["item"]);
                            if s(&item, "id") == agent && item["type"] == "collabAgentToolCall" {
                                child = arr(&item["receiverThreadIds"])
                                    .first()
                                    .and_then(Value::as_str)
                                    .map(str::to_owned);
                            }
                        }
                        if p["type"] == "function_call_output" && p["call_id"] == agent {
                            let output = p["output"]
                                .as_str()
                                .and_then(|s| serde_json::from_str::<Value>(s).ok())
                                .unwrap_or(Value::Null);
                            child = output["agent_id"].as_str().map(str::to_owned);
                        }
                        Ok(())
                    },
                )?;
            }
            child.and_then(|child| self.find("codex", &child, None).ok())
        } else {
            None
        };
        let Some(selected) = selected else {
            return Ok(json!({"events":[],"previous":null,"totalTurns":0,"found":false}));
        };
        self.with_db(|db| {
            let source = self.ensure(db, provider, id, cwd, None, Some(agent), Some(&selected))?;
            let mut result = self.read_page(db, &source, Some(page))?;
            result["found"] = json!(true);
            Ok(result)
        })
    }
    pub fn subagents(&self, id: &str, cwd: Option<&str>, provider: &str) -> CoreResult {
        let page = self.load(id, cwd, None, provider, Some(&json!({"limit":100})))?;
        let agents = arr(&page["events"])
            .iter()
            .filter(|e| e["type"] == "agent")
            .map(|e| s(e, "id").to_owned())
            .collect::<std::collections::HashSet<_>>();
        let mut events = Vec::new();
        let mut bytes = 0;
        for agent in agents {
            let page = self.subagent_page(id, cwd, provider, &agent, &json!({"limit":40}))?;
            for event in arr(&page["events"]) {
                bytes += event.to_string().len();
                if bytes > 8 * 1024 * 1024 {
                    return Err("Load individual agent transcripts with loadSubagentPage".into());
                }
                events.push(event.clone());
            }
        }
        Ok(json!(events))
    }
    pub fn handoff(&self, id: &str, cwd: &str, provider: &str) -> Result<String, String> {
        Ok(format!("Continue from the retained conversation below. Files keep the changes already made.\n\n{}",self.context(id,Some(cwd),None,provider,None)?))
    }
    pub fn context(
        &self,
        id: &str,
        cwd: Option<&str>,
        segment: Option<i64>,
        provider: &str,
        before: Option<i64>,
    ) -> Result<String, String> {
        self.with_db(|db|{let source=self.ensure(db,provider,id,cwd,segment,None,None)?;let mut q=db.prepare("SELECT json_extract(event,'$.type'),substr(json_extract(event,'$.text'),1,12000),json_extract(event,'$.name'),substr(json_extract(event,'$.input'),1,1500),substr(json_extract(event,'$.result'),1,1500) FROM history_events WHERE source=?1 AND (?2 IS NULL OR turn<?2) ORDER BY seq").map_err(error)?;
       let mut rows=q.query(params![source,before]).map_err(error)?;let mut prefix=String::new();let mut tail=std::collections::VecDeque::<String>::new();let mut count=0;let mut total=0;
       while let Some(row)=rows.next().map_err(error)?{let kind:String=row.get(0).map_err(error)?;let get=|i|row.get::<_,Option<String>>(i).ok().flatten().unwrap_or_default();let text=match kind.as_str(){"user"=>format!("User: {}",get(1)),"text"=>format!("Assistant: {}",get(1)),"tool"=>format!("Tool {}: {}",get(2),get(3)),"tool.result"=>format!("Result: {}",get(4)),_=>continue};let text=format!("{text}\n\n");total+=text.len();if prefix.len()<8000{prefix.extend(text.chars().take(8000-prefix.len()));}count+=text.len();tail.push_back(text);while count>112000&&tail.len()>1{count-=tail.pop_front().unwrap().len();}}
       let recent=tail.into_iter().collect::<String>();if total<=112000{Ok(recent)}else{Ok(format!("{prefix}\n[Middle of older history omitted to bound handoff size.]\n{recent}"))}
      })
    }
    pub fn fork_claude(&self, id: &str, cwd: &str, anchor: &str) -> CoreResult {
        let from = self.find("claude", id, Some(cwd))?;
        let new_id = uuid::Uuid::new_v4().to_string();
        let target = from
            .parent()
            .ok_or("Session has no project directory")?
            .join(format!("{new_id}.jsonl"));
        let temp = target.with_extension("tmp");
        let result = (|| {
            let mut output = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temp)
                .map_err(error)?;
            let mut found = anchor.is_empty();
            let mut done = false;
            jsonl::scan(
                BufReader::new(File::open(&from).map_err(error)?),
                jsonl::MAX_RECORD,
                |bytes| {
                    if done {
                        return Ok(());
                    }
                    let mut value = wire_json::parse(bytes)?;
                    if value.get("sessionId").is_some() {
                        value["sessionId"] = json!(new_id)
                    }
                    if value.get("session_id").is_some() {
                        value["session_id"] = json!(new_id)
                    }
                    writeln!(output, "{value}").map_err(error)?;
                    if !anchor.is_empty() && s(&value, "uuid") == anchor {
                        found = true;
                        done = true
                    }
                    Ok(())
                },
            )?;
            if !found {
                return Err("Fork anchor was not found".into());
            }
            output.sync_all().map_err(error)?;
            drop(output);
            let subagents = from.with_extension("");
            if subagents.is_dir() {
                copy_snapshot(&subagents, &target.with_extension(""), 8)?;
            }
            let delegates = self.storage.read("native/delegates.json")[id].clone();
            if delegates.is_object() {
                self.storage.update("native/delegates.json", |links| {
                    links[&new_id] = delegates;
                    Ok(())
                })?;
            }
            fs::rename(&temp, &target).map_err(error)?;
            Ok(json!(new_id))
        })();
        if result.is_err() {
            let _ = fs::remove_file(temp);
        }
        result
    }
    fn read_page(&self, db: &Connection, source: &str, page: Option<&Value>) -> CoreResult {
        let total = db
            .query_row(
                "SELECT turns FROM history_sources WHERE source=?1",
                [source],
                |r| r.get::<_, i64>(0),
            )
            .map_err(error)?;
        let before = page
            .and_then(|p| p["before"].as_i64())
            .unwrap_or(total + 1)
            .clamp(1, total + 1);
        let take = page
            .map(|p| p["limit"].as_i64().unwrap_or(PAGE_TURNS).clamp(1, 100))
            .unwrap_or(total.max(1));
        let mut start = (before - take).max(1);
        // Apply byte budget on whole turns, so a page never starts with a tool result without its call.
        if page.is_some() {
            let mut stmt=db.prepare("SELECT turn,SUM(bytes)FROM history_events WHERE source=?1 AND turn<?2 GROUP BY turn ORDER BY turn DESC LIMIT ?3").map_err(error)?;
            let rows = stmt
                .query_map(params![source, before, take], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, usize>(1)?))
                })
                .map_err(error)?;
            let mut bytes = 0usize;
            let mut selected = false;
            for row in rows {
                let (turn, size) = row.map_err(error)?;
                if selected && bytes.saturating_add(size) > PAGE_BYTES {
                    break;
                }
                if size > RESPONSE_BYTES {
                    return Err("A transcript turn exceeds the history response budget".into());
                }
                bytes += size;
                start = turn;
                selected = true;
            }
        }
        let mut statement=db.prepare("SELECT event,bytes FROM history_events WHERE source=?1 AND turn>=?2 AND turn<?3 ORDER BY seq").map_err(error)?;
        let rows = statement
            .query_map(params![source, start, before], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, usize>(1)?))
            })
            .map_err(error)?;
        let mut out = Vec::new();
        let mut size = 0;
        for row in rows {
            let (text, bytes) = row.map_err(error)?;
            size += bytes;
            if size > RESPONSE_BYTES {
                return Err("History response is too large; use history pages".into());
            }
            out.push(serde_json::from_str::<Value>(&text).map_err(error)?);
        }
        if page.is_some() {
            Ok(
                json!({"events":out,"previous":if start>1{Some(start)}else{None},"totalTurns":total}),
            )
        } else {
            Ok(json!(out))
        }
    }
    pub fn segments(&self, id: &str, cwd: Option<&str>, provider: &str) -> CoreResult {
        if provider != "claude" {
            return Ok(json!([]));
        }
        self.with_db(|db|{let path=self.find(provider,id,cwd)?;self.node_index(db,&path)?;let name=path.to_string_lossy();let mut stmt=db.prepare("SELECT logical,ts,idx FROM history_nodes WHERE path=?1 AND boundary=1 AND sidechain=0 ORDER BY idx").map_err(error)?;let rows=stmt.query_map([name.as_ref()],|r|Ok((r.get::<_,Option<String>>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,i64>(2)?))).map_err(error)?;let mut out=Vec::new();for(index,row)in rows.enumerate(){let(parent,ts,idx)=row.map_err(error)?;let Some(parent)=parent else{continue};let count=db.query_row("WITH RECURSIVE chain(uuid,parent,idx,boundary)AS(SELECT uuid,parent,idx,boundary FROM history_nodes WHERE path=?1 AND uuid=?2 AND idx<?3 UNION ALL SELECT n.uuid,n.parent,n.idx,n.boundary FROM history_nodes n JOIN chain c ON n.uuid=c.parent WHERE n.path=?1 AND c.boundary=0 AND n.idx<c.idx)SELECT COUNT(*)FROM chain WHERE boundary=0",params![name.as_ref(),parent,idx],|r|r.get::<_,i64>(0)).map_err(error)?;if count>0{out.push(json!({"segment":index,"count":count,"ts":ts}));}}out.reverse();Ok(json!(out))})
    }
    pub fn rename(&self, id: &str, title: &str, cwd: Option<&str>, provider: &str) -> CoreResult {
        if !valid_id(provider, id) || title.chars().count() > 500 {
            return Err("Invalid session/title".into());
        }
        self.storage.update("native/session-metadata.json", |v| {
            v[id]["title"] = json!(title);
            Ok(())
        })?;
        if provider == "claude" {
            let file = self.find(provider, id, cwd)?;
            let mut writer = fs::OpenOptions::new()
                .append(true)
                .open(file)
                .map_err(error)?;
            writeln!(
                writer,
                "{}",
                json!({"type":"custom-title","customTitle":title,"sessionId":id})
            )
            .map_err(error)?;
        } else if matches!(provider, "gemini" | "antigravity") {
            let path = self.storage.data.join(provider).join(format!("{id}.json"));
            let mut meta = storage::read_json(&path);
            meta["title"] = json!(title);
            storage::write_json(&path, &meta)?;
        }
        Ok(Value::Null)
    }
    pub fn remove(&self, id: &str, cwd: Option<&str>, provider: &str) -> CoreResult {
        let path = self.find(provider, id, cwd)?;
        let trash = self
            .storage
            .data
            .join("native/trash")
            .join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&trash).map_err(error)?;
        if path.exists() {
            let target = trash.join(path.file_name().unwrap());
            fs::rename(&path, target).map_err(error)?;
        }
        if matches!(provider, "gemini" | "antigravity") {
            let meta = path.with_extension("json");
            if meta.exists() {
                fs::rename(&meta, trash.join(meta.file_name().unwrap())).map_err(error)?;
            }
        }
        if provider == "claude" {
            let agents = path.with_extension("");
            if agents.is_dir() {
                fs::rename(&agents, trash.join("subagents")).map_err(error)?;
            }
        }
        self.storage.update("native/session-metadata.json", |v| {
            v[id]["deleted"] = json!(true);
            Ok(())
        })?;
        Ok(Value::Null)
    }
    pub fn create_journal(&self, provider: &str, cwd: &str, text: &str) -> Result<Value, String> {
        if !matches!(provider, "gemini" | "antigravity") {
            return Err("Not a journal provider".into());
        }
        let id = format!(
            "{}-{}",
            if provider == "gemini" { "gem" } else { "agy" },
            uuid::Uuid::new_v4()
        );
        let now = storage::now();
        let meta = json!({"sessionId":id,"provider":provider,"cwd":cwd,"title":text.lines().next().unwrap_or(provider).chars().take(120).collect::<String>(),"createdAt":now,"lastModified":now});
        storage::write_json(
            &self.storage.data.join(provider).join(format!("{id}.json")),
            &meta,
        )?;
        Ok(meta)
    }
    pub fn journal_meta(&self, provider: &str, id: &str) -> Result<Value, String> {
        if !valid_id(provider, id) {
            return Err("Invalid session id".into());
        }
        let meta = storage::read_json(&self.storage.data.join(provider).join(format!("{id}.json")));
        if meta["sessionId"].is_null() {
            return Err("Session not found".into());
        }
        Ok(meta)
    }
    pub fn journal_patch(&self, provider: &str, id: &str, patch: &Value) -> Result<Value, String> {
        let mut meta = self.journal_meta(provider, id)?;
        storage::merge(&mut meta, patch);
        storage::write_json(
            &self.storage.data.join(provider).join(format!("{id}.json")),
            &meta,
        )?;
        Ok(meta)
    }
    pub fn journal_append(&self, provider: &str, id: &str, event: &Value) -> Result<(), String> {
        if !valid_id(provider, id) {
            return Err("Invalid session id".into());
        }
        let dir = self.storage.data.join(provider);
        fs::create_dir_all(&dir).map_err(error)?;
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join(format!("{id}.jsonl")))
            .map_err(error)?;
        writeln!(file, "{event}").map_err(error)
    }
    pub fn journal_rollback(&self, provider: &str, id: &str, drop_turns: i64) -> CoreResult {
        self.with_db(|db|{let source=self.ensure(db,provider,id,None,None,None,None)?;let total=db.query_row("SELECT turns FROM history_sources WHERE source=?1",[&source],|r|r.get::<_,i64>(0)).map_err(error)?;let keep=total.saturating_sub(drop_turns.max(0));let path=self.find(provider,id,None)?;let temp=path.with_extension(format!("{}.tmp",uuid::Uuid::new_v4()));let mut file=File::create(&temp).map_err(error)?;{let mut stmt=db.prepare("SELECT event FROM history_events WHERE source=?1 AND turn<=?2 ORDER BY seq").map_err(error)?;let rows=stmt.query_map(params![source,keep],|r|r.get::<_,String>(0)).map_err(error)?;for row in rows{writeln!(file,"{}",row.map_err(error)?).map_err(error)?;}}file.sync_all().map_err(error)?;drop(file);fs::rename(temp,path).map_err(error)?;self.journal_patch(provider,id,&json!({"nativeId":null,"rewound":keep>0,"lastModified":storage::now()}))?;Ok(json!(true))})
    }
}
fn valid_id(provider: &str, id: &str) -> bool {
    let raw = match provider {
        "claude" | "codex" => id,
        "gemini" => id.strip_prefix("gem-").unwrap_or(""),
        "antigravity" => id.strip_prefix("agy-").unwrap_or(""),
        _ => return false,
    };
    uuid::Uuid::parse_str(raw).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, History, String, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let projects = home.join(".claude/projects/project");
        fs::create_dir_all(&projects).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let path = projects.join(format!("{id}.jsonl"));
        let storage = Arc::new(Storage::new(
            root.path().join("data"),
            home.clone(),
            root.path().into(),
        ));
        let history = History::new(storage, home.join(".claude/projects"));
        (root, history, id, path)
    }
    #[test]
    fn active_chain_compaction_and_pages_do_not_load_other_branches() {
        let (_root, history, id, path) = fixture();
        let records = vec![
            json!({"type":"user","uuid":"u0","parentUuid":null,"message":{"content":"first"}}),
            json!({"type":"assistant","uuid":"a0","parentUuid":"u0","message":{"content":[{"type":"text","text":"answer"}]}}),
            json!({"type":"system","subtype":"compact_boundary","uuid":"boundary","parentUuid":null,"logicalParentUuid":"a0","timestamp":"2026-10-30T10:00:00Z"}),
            json!({"type":"user","uuid":"u1","parentUuid":"boundary","isCompactSummary":true,"message":{"content":"summary"}}),
            json!({"type":"assistant","uuid":"a1","parentUuid":"u1","message":{"content":[{"type":"text","text":"latest"}]}}),
        ];
        fs::write(
            &path,
            records.iter().map(|v| format!("{v}\n")).collect::<String>(),
        )
        .unwrap();
        let current = history
            .load(&id, None, None, "claude", Some(&json!({"limit":40})))
            .unwrap();
        assert_eq!(current["events"][0]["text"], "summary");
        assert_eq!(current["events"][0]["summary"], true);
        assert_eq!(
            history.segments(&id, None, "claude").unwrap()[0]["count"],
            2
        );
        let old = history
            .load(&id, None, Some(0), "claude", Some(&json!({})))
            .unwrap();
        assert_eq!(old["events"][0]["text"], "first");
        assert!(old["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["text"] == "answer"));
    }
    #[test]
    fn pages_are_whole_turns_and_persist_across_restart() {
        let (root, history, id, path) = fixture();
        let mut file = File::create(&path).unwrap();
        let mut parent = Value::Null;
        for n in 0..100 {
            let user = format!("u{n}");
            let answer = format!("a{n}");
            writeln!(file,"{}",json!({"type":"user","uuid":user,"parentUuid":parent,"message":{"content":format!("question {n}")}})).unwrap();
            writeln!(file,"{}",json!({"type":"assistant","uuid":answer,"parentUuid":user,"message":{"content":[{"type":"text","text":format!("answer {n}")}]}})).unwrap();
            parent = json!(answer);
        }
        drop(file);
        let page = history
            .load(&id, None, None, "claude", Some(&json!({"limit":10})))
            .unwrap();
        assert_eq!(page["events"][0]["text"], "question 90");
        assert_eq!(page["previous"], 91);
        let previous = history
            .load(
                &id,
                None,
                None,
                "claude",
                Some(&json!({"limit":10,"before":91})),
            )
            .unwrap();
        assert_eq!(previous["events"][0]["text"], "question 80");
        assert_eq!(previous["totalTurns"], 100);
        drop(history);
        let home = root.path().join("home");
        let history = History::new(
            Arc::new(Storage::new(
                root.path().join("data"),
                home.clone(),
                root.path().into(),
            )),
            home.join(".claude/projects"),
        );
        assert_eq!(
            history
                .load(&id, None, None, "claude", Some(&json!({"limit":10})))
                .unwrap()["events"][0]["text"],
            "question 90"
        );
    }
}
fn as_agent(mut event: Value, agent: &str) -> Option<Value> {
    if event["type"] == "user" {
        Some(
            json!({"type":"agent.msg","agent":agent,"dir":"to","label":"message","text":event["text"],"dedupe":true}),
        )
    } else if matches!(
        s(&event, "type"),
        "text" | "thinking" | "tool" | "tool.result" | "tool.output"
    ) {
        event["agent"] = json!(agent);
        Some(event)
    } else {
        None
    }
}
fn copy_snapshot(source: &Path, target: &Path, depth: usize) -> Result<(), String> {
    if depth == 0 {
        return Err("Subagent directory nesting is too deep".into());
    }
    fs::create_dir_all(target).map_err(error)?;
    for entry in fs::read_dir(source).map_err(error)? {
        let entry = entry.map_err(error)?;
        let kind = entry.file_type().map_err(error)?;
        if kind.is_symlink() {
            continue;
        }
        let destination = target.join(entry.file_name());
        if kind.is_dir() {
            copy_snapshot(&entry.path(), &destination, depth - 1)?
        } else if kind.is_file() {
            let input = File::open(entry.path()).map_err(error)?;
            let len = input.metadata().map_err(error)?.len();
            let mut output = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(destination)
                .map_err(error)?;
            std::io::copy(&mut input.take(len), &mut output).map_err(error)?;
        }
    }
    Ok(())
}
fn list_files(root: &Path, depth: usize) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if entry.file_type().is_ok_and(|t| t.is_symlink()) {
                continue;
            }
            if out.len() >= 30000 {
                break;
            }
            if path.is_dir() {
                if depth > 0 {
                    out.extend(list_files(&path, depth - 1));
                }
            } else if path.extension().is_some_and(|e| e == "jsonl") {
                out.push(path);
            }
        }
    }
    out
}
fn read_edges(path: &Path) -> Result<Vec<Vec<u8>>, String> {
    let mut file = File::open(path).map_err(error)?;
    let size = file.metadata().map_err(error)?.len();
    let head = size.min(128 * 1024);
    let mut bytes = vec![0; head as usize];
    file.read_exact(&mut bytes).map_err(error)?;
    let mut out = bytes
        .split(|b| *b == b'\n')
        .filter(|s| !s.is_empty())
        .map(<[u8]>::to_vec)
        .collect::<Vec<_>>();
    if size > head {
        let tail = size.min(128 * 1024);
        file.seek(SeekFrom::End(-(tail as i64))).map_err(error)?;
        let mut bytes = vec![0; tail as usize];
        file.read_exact(&mut bytes).map_err(error)?;
        out.extend(
            bytes
                .split(|b| *b == b'\n')
                .skip(1)
                .filter(|s| !s.is_empty())
                .map(<[u8]>::to_vec),
        );
    }
    Ok(out)
}

struct CodexRollout {
    recorded: bool,
    seq: u64,
    calls: std::collections::HashMap<String, Value>,
}
impl CodexRollout {
    fn new(recorded: bool) -> Self {
        Self {
            recorded,
            seq: 0,
            calls: std::collections::HashMap::new(),
        }
    }
    fn push(&mut self, record: &Value) -> Vec<Value> {
        let p = &record["payload"];
        let mut out = Vec::new();
        if s(record, "type") == "event_msg" {
            match s(p,"type"){
    "item_completed" if self.recorded=>{let item=recorded_item(&p["item"]);if s(&item,"type")=="userMessage"{let mut user=events::codex_user(&item["content"]);user["type"]=json!("user");out.push(user);}else{out.extend(events::codex_item(&item,true,None));}},
    "user_message" if !self.recorded=>{let images=arr(&p["images"]).iter().enumerate().filter_map(|(i,v)|events::data_image(v.as_str().unwrap_or(""),&format!("image-{}-{i}",self.seq))).collect::<Vec<_>>();out.push(json!({"type":"user","text":events::readable_user(s(p,"message")).trim(),"images":images}));},
    "turn_aborted"=>out.push(json!({"type":"notice","code":"reduce.interrupted","tone":"warn","at":"if-open"})),"error"=>out.push(json!({"type":"notice","text":p["message"].as_str().unwrap_or(""),"tone":"error","at":"open"})),"context_compacted"=>out.push(json!({"type":"notice","code":"reduce.compacted","tone":"info","at":"open"})),_=>{}}
        } else if s(record, "type") == "compacted" {
            out.push(json!({"type":"notice","code":"reduce.compacted","tone":"info","at":"open"}));
        } else if s(record, "type") == "response_item" && !self.recorded {
            self.seq += 1;
            let id = format!("r{}", self.seq);
            match s(p, "type") {
                "message" if s(p, "role") == "assistant" => {
                    let text = arr(&p["content"])
                        .iter()
                        .filter(|c| s(c, "type") == "output_text")
                        .map(|c| s(c, "text"))
                        .collect::<String>();
                    if !text.trim().is_empty() {
                        out.push(json!({"type":"text","id":id,"text":text,"mode":"final"}));
                    }
                }
                "reasoning" => {
                    let text = arr(&p["summary"])
                        .iter()
                        .map(|c| s(c, "text"))
                        .collect::<Vec<_>>()
                        .join("\n\n");
                    if !text.trim().is_empty() {
                        out.push(json!({"type":"thinking","id":id,"text":text,"mode":"final"}));
                    }
                }
                "function_call" | "local_shell_call" => {
                    let input = if s(p, "type") == "local_shell_call" {
                        json!({"command":arr(&p["action"]["command"]).iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" ")})
                    } else {
                        p["arguments"]
                            .as_str()
                            .and_then(|s| wire_json::parse(s.as_bytes()).ok())
                            .unwrap_or_else(|| p["arguments"].clone())
                    };
                    let (name, input) = codex_tool(s(p, "name"), input);
                    let name = if s(p, "type") == "local_shell_call" {
                        "Bash".into()
                    } else {
                        name
                    };
                    self.calls.insert(s(p, "call_id").into(), json!(name));
                    out.push(json!({"type":"tool","id":p["call_id"],"name":name,"input":input,"final":true}));
                }
                "custom_tool_call" => {
                    if s(p, "name") == "apply_patch" {
                        let changes = parse_patch(s(p, "input"));
                        self.calls
                            .insert(s(p, "call_id").into(), json!(changes.len()));
                        for (n, input) in changes.into_iter().enumerate() {
                            out.push(json!({"type":"tool","id":events::patch_id(s(p,"call_id"),n),"name":"Patch","input":input,"final":true}));
                        }
                    } else {
                        self.calls.insert(s(p, "call_id").into(), p["name"].clone());
                        out.push(json!({"type":"tool","id":p["call_id"],"name":p["name"],"input":{"input":p["input"]},"final":true}));
                    }
                }
                "function_call_output" | "custom_tool_call_output" | "local_shell_call_output" => {
                    let kind = self.calls.remove(s(p, "call_id")).unwrap_or(Value::Null);
                    let mut text = events::result_text(&p["output"]);
                    let mut status = "done";
                    if text.starts_with("Exit code: ") {
                        if let Some(line) = text.lines().next() {
                            if line
                                .strip_prefix("Exit code: ")
                                .and_then(|s| s.parse::<i64>().ok())
                                .is_some_and(|n| n != 0)
                            {
                                status = "error";
                            }
                        }
                        if let Some((_, output)) = text.split_once("Output:\n") {
                            text = output.to_owned();
                        }
                    }
                    text = events::strip_ansi(&text).trim_end().to_owned();
                    if p["output"]["success"] == false {
                        status = "error";
                    }
                    if let Some(count) = kind.as_u64() {
                        for n in 0..count {
                            out.push(json!({"type":"tool.result","id":events::patch_id(s(p,"call_id"),n as usize),"status":status,"result":""}));
                        }
                    } else {
                        out.push(json!({"type":"tool.result","id":p["call_id"],"status":status,"result":text}));
                    }
                }
                "web_search_call" => {
                    let action = &p["action"];
                    let (name, input) = if s(action, "type") == "open_page" {
                        ("WebFetch", json!({"url":action["url"]}))
                    } else {
                        (
                            "WebSearch",
                            json!({"query":action.get("query").cloned().unwrap_or(json!(""))}),
                        )
                    };
                    let id = p["id"].as_str().unwrap_or(&id);
                    out.push(json!({"type":"tool","id":id,"name":name,"input":input,"final":true}));
                    out.push(json!({"type":"tool.result","id":id,"status":"done","result":""}));
                }
                _ => {}
            }
        }
        if let Some(ts) = events::timestamp(&record["timestamp"]) {
            for event in &mut out {
                event["timestamp"] = json!(ts);
            }
        }
        out
    }
}
pub fn codex_tool(name: &str, mut input: Value) -> (String, Value) {
    let name = match name {
        "shell" | "shell_command" | "exec_command" | "local_shell" | "unified_exec" => {
            let command = if input["command"].is_array() {
                arr(&input["command"])
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(" ")
            } else {
                input
                    .get("command")
                    .or(input.get("cmd"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned()
            };
            input = json!({"command":command});
            "Bash"
        }
        "update_plan" => {
            let todos=arr(&input["plan"]).iter().map(|s|json!({"content":s["step"],"activeForm":s["step"],"status":match events::s(s,"status"){"in_progress"|"inProgress"=>"in_progress","completed"=>"completed",_=>"pending"}})).collect::<Vec<_>>();
            input = json!({"todos":todos});
            "TodoWrite"
        }
        "view_image" => {
            input = json!({"file_path":input["path"]});
            "Read"
        }
        "spawn_agent" => {
            let prompt = input
                .get("message")
                .or(input.get("prompt"))
                .and_then(Value::as_str)
                .unwrap_or("");
            input = json!({"description":prompt.lines().next().unwrap_or("").chars().take(80).collect::<String>(),"prompt":prompt});
            "Agent"
        }
        _ => name,
    };
    (name.to_owned(), input)
}
pub fn recorded_item(raw: &Value) -> Value {
    let mut item = json!({});
    if let Some(map) = raw.as_object() {
        for (key, value) in map {
            let mut name = String::new();
            let mut upper = false;
            for c in key.chars() {
                if c == '_' {
                    upper = true;
                } else if upper {
                    name.extend(c.to_uppercase());
                    upper = false;
                } else {
                    name.push(c);
                }
            }
            item[name] = value.clone();
        }
    }
    let kind = s(&item, "type");
    let mut chars = kind.chars();
    let kind = chars
        .next()
        .map(|c| c.to_lowercase().collect::<String>())
        .unwrap_or_default()
        + chars.as_str();
    item["type"] = json!(kind);
    match kind.as_str() {
        "agentMessage" => {
            if item["text"].is_null() {
                item["text"] = json!(arr(&item["content"])
                    .iter()
                    .map(|c| s(c, "text"))
                    .collect::<String>());
            }
        }
        "reasoning" => {
            if item["summary"].is_null() {
                item["summary"] = item.get("summaryText").cloned().unwrap_or(json!([]));
            }
            if item["content"].is_null() {
                item["content"] = item.get("rawContent").cloned().unwrap_or(json!([]));
            }
        }
        "commandExecution" => {
            if item["command"].is_array() {
                item["command"] = json!(arr(&item["command"])
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(" "));
            }
            if item["commandActions"].is_null() {
                item["commandActions"] = json!(arr(&item["parsedCmd"])
                    .iter()
                    .map(|v| {
                        let mut v = v.clone();
                        v["command"] = v
                            .get("cmd")
                            .or(v.get("command"))
                            .cloned()
                            .unwrap_or(json!(""));
                        v
                    })
                    .collect::<Vec<_>>());
            }
            if item["aggregatedOutput"].is_null() {
                item["aggregatedOutput"] =
                    item.get("formattedOutput").cloned().unwrap_or_else(|| {
                        json!([s(&item, "stdout"), s(&item, "stderr")]
                            .into_iter()
                            .filter(|s| !s.is_empty())
                            .collect::<Vec<_>>()
                            .join("\n"))
                    });
            }
        }
        "fileChange" => {
            let mut changes = Vec::new();
            if let Some(list) = raw["changes"].as_array() {
                for change in list {
                    changes.push(json!({"path":change["path"],"kind":change.get("kind").cloned().unwrap_or(json!({"type":"update"})),"diff":change.get("diff").or(change.get("unified_diff")).cloned().unwrap_or(json!(""))}));
                }
            } else if let Some(map) = raw["changes"].as_object() {
                for (path, change) in map {
                    let kind = change
                        .get("type")
                        .and_then(Value::as_str)
                        .or_else(|| {
                            change
                                .as_object()
                                .and_then(|m| m.keys().next())
                                .map(String::as_str)
                        })
                        .unwrap_or("update");
                    let body = change.get(kind).unwrap_or(change);
                    changes.push(json!({"path":path,"kind":{"type":kind,"move_path":body["move_path"]},"diff":body.get("unified_diff").or(body.get("diff")).cloned().unwrap_or_else(||json!(s(body,"content").lines().map(|s|format!("+{s}")).collect::<Vec<_>>().join("\n")))}));
                }
            }
            item["changes"] = json!(changes);
        }
        "mcpToolCall" => {
            for key in ["server", "tool", "arguments"] {
                if item[key].is_null() {
                    item[key] = item["invocation"][key].clone();
                }
            }
        }
        _ => {}
    }
    item
}
pub fn parse_patch(text: &str) -> Vec<Value> {
    let mut out = Vec::new();
    let mut current: Option<(String, String, Option<String>, Vec<String>)> = None;
    let finish = |current: Option<(String, String, Option<String>, Vec<String>)>,
                  out: &mut Vec<Value>| {
        if let Some((path, kind, moved, mut lines)) = current {
            while lines.last().is_some_and(|s| s.is_empty()) {
                lines.pop();
            }
            let body = lines.join("\n");
            let diff = if kind == "add" && !body.is_empty() {
                format!("@@ -0,0 +1,{} @@\n{body}\n", lines.len())
            } else if !body.is_empty() {
                format!("{body}\n")
            } else {
                String::new()
            };
            let mut v = json!({"file_path":path,"kind":kind,"diff":diff});
            if let Some(path) = moved {
                v["move_path"] = json!(path);
            }
            out.push(v);
        }
    };
    for line in text.lines() {
        let mut header = None;
        for (label, kind) in [
            ("*** Add File: ", "add"),
            ("*** Update File: ", "update"),
            ("*** Delete File: ", "delete"),
        ] {
            if let Some(path) = line.strip_prefix(label) {
                header = Some((path.trim().to_owned(), kind.to_owned()));
                break;
            }
        }
        if let Some((path, kind)) = header {
            finish(current.take(), &mut out);
            current = Some((path, kind, None, Vec::new()));
            continue;
        }
        if let Some((_, kind, moved, lines)) = &mut current {
            if let Some(path) = line.strip_prefix("*** Move to: ") {
                *moved = Some(path.trim().to_owned());
            } else if !line.starts_with("*** ") {
                lines.push(if kind == "add" && !line.starts_with('+') {
                    format!("+{line}")
                } else {
                    line.to_owned()
                });
            }
        }
    }
    finish(current, &mut out);
    out
}

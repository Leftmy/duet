//! Family-scoped mailboxes and a disk-backed event stream. No model call or wait runs on a CLI reader.
use super::*;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::VecDeque;
#[cfg(test)]
#[path = "collaboration_tests.rs"]
mod tests;

pub(super) struct Bus {
    path: PathBuf,
    db: Mutex<Option<Connection>>,
    version: Mutex<u64>,
    changed: Condvar,
    failed: AtomicBool,
}
impl Bus {
    pub(super) fn new(path: PathBuf) -> Self {
        Self {
            path,
            db: Mutex::new(None),
            version: Mutex::new(0),
            changed: Condvar::new(),
            failed: AtomicBool::new(false),
        }
    }
    fn database<T>(&self, f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
        let mut guard = self.db.lock().unwrap();
        if guard.is_none() {
            std::fs::create_dir_all(self.path.parent().unwrap()).map_err(|e| e.to_string())?;
            let db = Connection::open(&self.path).map_err(|e| e.to_string())?;
            db.execute_batch("PRAGMA journal_mode=WAL;PRAGMA synchronous=NORMAL;PRAGMA cache_size=-2048;PRAGMA mmap_size=0;CREATE TABLE IF NOT EXISTS team_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,root TEXT NOT NULL,run_id TEXT NOT NULL,body TEXT NOT NULL);CREATE INDEX IF NOT EXISTS team_event_root ON team_events(root,seq);").map_err(|e|e.to_string())?;
            *guard = Some(db);
        }
        f(guard.as_ref().unwrap())
    }
    fn append(&self, root: &str, id: &str, event: Value) -> Result<u64, String> {
        let sequence = self.database(|db| {
            db.execute(
                "INSERT INTO team_events(root,run_id,body) VALUES(?1,?2,?3)",
                params![root, id, event.to_string()],
            )
            .map_err(|e| e.to_string())?;
            Ok(db.last_insert_rowid() as u64)
        })?;
        self.wake();
        Ok(sequence)
    }
    fn cursor(&self, root: &str) -> u64 {
        self.database(|db| {
            db.query_row(
                "SELECT COALESCE(MAX(seq),0) FROM team_events WHERE root=?1",
                [root],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())
        })
        .unwrap_or(0)
    }
    fn page(&self, root: &str, after: u64, filter: Option<&str>, limit: usize) -> CoreResult {
        self.database(|db| {
            let mut stmt=db.prepare("SELECT seq,run_id,body FROM team_events WHERE root=?1 AND seq>?2 AND (?3 IS NULL OR run_id=?3) ORDER BY seq LIMIT ?4").map_err(|e|e.to_string())?;
            let rows=stmt.query_map(params![root,after,filter,limit.clamp(1,200)+1],|r|Ok((r.get::<_,u64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?))).map_err(|e|e.to_string())?;
            let mut out=Vec::new();let mut cursor=after;let mut bytes=0;let mut more=false;
            for row in rows {
                let (seq,id,body)=row.map_err(|e|e.to_string())?;
                if out.len()>=limit.clamp(1,200)||(!out.is_empty()&&bytes+body.len().min(128*1024)>256*1024){more=true;break;}
                cursor=seq;bytes+=body.len().min(128*1024);
                let mut event=if body.len()>128*1024{json!({"run_id":id,"large_event":true,"event_bytes":body.len(),"read_with":"read_agent_event"})}else{serde_json::from_str(&body).map_err(|e|e.to_string())?};
                event["seq"]=json!(seq);out.push(event);
            }
            Ok(json!({"events":out,"cursor":cursor,"has_more":more}))
        })
    }
    fn detail(&self, root: &str, seq: u64, offset: usize, limit: usize) -> CoreResult {
        self.database(|db| {
            let body:String=db.query_row("SELECT body FROM team_events WHERE root=?1 AND seq=?2",params![root,seq],|r|r.get(0)).optional().map_err(|e|e.to_string())?.ok_or("Unknown event in this team")?;
            if offset>body.len()||!body.is_char_boundary(offset){return Err("Invalid event byte offset".into());}
            let mut end=(offset+limit.clamp(1024,128*1024)).min(body.len());while !body.is_char_boundary(end){end-=1;}
            Ok(json!({"seq":seq,"text":&body[offset..end],"next_offset":if end<body.len(){Some(end)}else{None},"total_bytes":body.len()}))
        })
    }
    pub(super) fn wake(&self) {
        let mut v = self.version.lock().unwrap();
        *v = v.wrapping_add(1);
        self.changed.notify_all();
    }
    fn version(&self) -> u64 {
        *self.version.lock().unwrap()
    }
    fn wait(&self, version: u64, remaining: Duration) {
        let v = self.version.lock().unwrap();
        if *v == version {
            drop(self.changed.wait_timeout(v, remaining).unwrap());
        }
    }
}

// Register both the transport request id and nested MCP id. Late cancellation cannot
// cancel another call that reuses an alias after the first request has completed.
pub(super) struct Request {
    run: Arc<Run>,
    ids: Vec<String>,
    pub(super) cancelled: Arc<AtomicBool>,
}
impl Request {
    pub(super) fn new(run: &Arc<Run>, ids: Vec<String>) -> Self {
        let mut pending = run.cancelled_requests.lock().unwrap();
        let already_cancelled = ids.iter().fold(false, |yes, id| pending.remove(id) || yes);
        let cancelled = Arc::new(AtomicBool::new(already_cancelled));
        {
            let mut calls = run.requests.lock().unwrap();
            for id in &ids {
                calls.insert(id.clone(), cancelled.clone());
            }
        }
        drop(pending);
        Self {
            run: run.clone(),
            ids,
            cancelled,
        }
    }
}
impl Drop for Request {
    fn drop(&mut self) {
        let mut calls = self.run.requests.lock().unwrap();
        for id in &self.ids {
            if calls
                .get(id)
                .is_some_and(|c| Arc::ptr_eq(c, &self.cancelled))
            {
                calls.remove(id);
            }
        }
        drop(calls);
        let mut pending = self.run.cancelled_requests.lock().unwrap();
        for id in &self.ids {
            pending.remove(id);
        }
    }
}

fn answer(value: Value, error: bool) -> Value {
    let mut result = toolsets::text(value.to_string(), error);
    result["structuredContent"] = value;
    result
}
fn timeout(args: &Value, default: f64) -> Duration {
    Duration::from_secs_f64(
        args["timeout_sec"]
            .as_f64()
            .unwrap_or(default)
            .clamp(0., 60.),
    )
}
fn cancelled(run: &Arc<Run>, token: &AtomicBool) -> bool {
    !Agents::current(run) || token.load(Ordering::Acquire)
}
fn state(t: &Thread) -> &'static str {
    if t.context_waiting.load(Ordering::Acquire){return "running"}
    if t.run
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|r| r.running.load(Ordering::Acquire))
    {
        return "running";
    }
    let result = t.result.lock().unwrap();
    if result["stopped"] == true {
        "stopped"
    } else if result["isError"] == true {
        "error"
    } else if result.is_null() {
        "idle"
    } else {
        "done"
    }
}

impl Agents {
    pub(super) fn family_root(&self, t: &Arc<Thread>) -> Arc<Thread> {
        let mut root = t.clone();
        for _ in 0..8 {
            let Some(sub) = &root.sub else { break };
            let Some(parent) = self.find(&sub.parent) else {
                break;
            };
            root = parent;
        }
        root
    }
    pub(super) fn family(&self, t: &Arc<Thread>) -> Vec<Arc<Thread>> {
        let root = self.family_root(t);
        let mut out = vec![root.clone()];
        let mut at = 0;
        while at < out.len() {
            out.extend(self.children(&out[at].id));
            at += 1;
        }
        out
    }
    fn teammate(&self, t: &Arc<Thread>, selector: &str) -> Result<Arc<Thread>, String> {
        let id = match selector {
            "parent" => t.sub.as_ref().map(|s| s.parent.as_str()).unwrap_or(&t.id),
            "root" => return Ok(self.family_root(t)),
            "self" => &t.id,
            _ => selector,
        };
        self.family(t)
            .into_iter()
            .find(|candidate| {
                candidate.id == id || candidate.sub.as_ref().is_some_and(|s| s.tool == id)
            })
            .ok_or("Unknown run_id in this team".into())
    }
    pub(super) fn team_record(&self, t: &Arc<Thread>, event: Value) -> Option<u64> {
        if t.hidden {
            return None;
        }
        // A root reading its own tool result would recursively journal the journal.
        // Root model output already has native history; this stream is for team work.
        let kind = s(&event, "type");
        if t.sub.is_none()
            && event["agent"].is_null()
            && !matches!(kind, "agent" | "agent.drop" | "agent.mark")
            && !kind.starts_with("message.")
            && !kind.starts_with("notification.")
            && !kind.starts_with("permission.")
        {
            return None;
        }
        let root = self.family_root(t);
        let envelope = json!({"root_id":root.id,"run_id":t.id,"parent_id":t.sub.as_ref().map(|s|&s.parent),"agent_id":t.sub.as_ref().map(|s|&s.tool),"provider":*t.provider.lock().unwrap(),"session_id":*t.session.lock().unwrap(),"timestamp":storage::now(),"event":event});
        match self.collaboration.append(&root.id, &t.id, envelope) {
            Ok(seq) => {
                self.collaboration.failed.store(false, Ordering::Release);
                Some(seq)
            }
            Err(error) => {
                if !self.collaboration.failed.swap(true, Ordering::AcqRel) {
                    (self.emit)(
                        "agent:event",
                        json!({"threadId":root.id,"ev":{"type":"notice","tone":"error","at":"feed","text":format!("Agent event journal failed: {error}")}}),
                    );
                }
                None
            }
        }
    }
    pub(super) fn route_team_event(&self, run: &Arc<Run>, t: &Arc<Thread>, event: Value) {
        let own_end = event["type"] == "turn.end" && event["agent"].is_null();
        let mut recorded = event.clone();
        if event["type"] == "tool"
            && [
                "__agent_events",
                "__read_agent_event",
                "__wait_agent",
                "__run_agent",
            ]
            .iter()
            .any(|suffix| s(&event, "name").ends_with(suffix))
        {
            let mut replays = run.journal_replays.lock().unwrap();
            if replays.len() < 256 {
                replays.insert(s(&event, "id").to_owned());
            }
        }
        if event["type"] == "tool.result"
            && run.journal_replays.lock().unwrap().remove(s(&event, "id"))
        {
            if let Ok(mut replay) = serde_json::from_str::<Value>(s(&event, "result")) {
                if replay["events"].is_array() {
                    replay["events"]=json!(arr(&replay["events"]).iter().map(|e|json!({"seq":e["seq"],"run_id":e["run_id"],"journal_reference":true})).collect::<Vec<_>>());
                }
                if replay["seq"].is_number() && replay["text"].is_string() {
                    replay["text"] = json!(
                        "[Journal chunk; recover from seq and the matching tool input offset.]"
                    );
                }
                recorded["result"] = json!(replay.to_string());
                recorded["journalReplay"] = json!(true);
            }
        }
        let cursor = self.team_record(t, recorded);
        let root = self.family_root(t);
        if let Some(sub) = &t.sub {
            if own_end && event["contextCheckpoint"]!=true {
                if let Some(parent) = self.find(&sub.parent) {
                    self.team_background(&parent, sub, false);
                }
            }
            if event["type"] == "session" {
                let root_session = root.session.lock().unwrap().clone();
                if !root_session.is_empty() {
                    let _=self.storage.update("native/delegates.json",|links|{links[&root_session][&sub.tool]=json!({"sessionId":event["sessionId"],"provider":run.provider,"parentId":sub.parent});Ok(())});
                }
            }
            let original = s(&event, "type");
            let mut ev = event.clone();
            let inner = event["agent"]
                .as_str()
                .map(|id| format!("{}::{id}", sub.tool));
            match original {
                "agent" | "agent.drop" | "agent.mark" => {
                    ev["id"] = json!(format!("{}::{}", sub.tool, s(&event, "id")));
                    ev["parentId"] = json!(sub.tool);
                }
                "turn.end" if own_end => {
                    let status = if event["stopped"] == true {
                        "stopped"
                    } else {
                        state(t)
                    };
                    ev = json!({"type":"agent","id":sub.tool,"status":status,"result":event["error"].as_str().filter(|e|!e.is_empty()).or(event["text"].as_str()).unwrap_or(""),"runId":t.id});
                }
                "session" if inner.is_none() => {
                    ev = json!({"type":"agent","id":sub.tool,"sessionId":event["sessionId"],"runId":t.id});
                }
                "user" => {
                    ev = json!({"type":"agent.msg","agent":inner.as_deref().unwrap_or(&sub.tool),"dir":"to","label":"message","text":event["text"],"dedupe":true});
                }
                "limits" => {}
                _ => {
                    ev["agent"] = json!(inner.as_deref().unwrap_or(&sub.tool));
                }
            }
            if ev["provider"].is_null() {
                ev["provider"] = json!(run.provider);
            }
            (self.emit)("agent:event", json!({"threadId":root.id,"ev":ev}));
            if original == "tool" && event["final"] == true {
                (self.emit)(
                    "agent:event",
                    json!({"threadId":root.id,"ev":{"type":"tool.sub","id":sub.tool,"name":event["name"],"input":event["input"]}}),
                );
            }
            if own_end && event["stopped"] != true && event["contextCheckpoint"]!=true {
                self.notify_completion(t, cursor);
            }
        } else if !t.hidden {
            (self.emit)("agent:event", json!({"threadId":t.id,"ev":event}));
        }
        // Queue dispatch after completion bookkeeping; the old turn cannot finish its successor.
        if own_end && !run.failing.load(Ordering::Acquire) {
            self.schedule_inbox(t);
        }
    }
    fn team_background(&self, parent: &Arc<Thread>, sub: &Sub, running: bool) {
        let local = parent
            .sub
            .as_ref()
            .and_then(|p| sub.tool.strip_prefix(&format!("{}::", p.tool)))
            .unwrap_or(&sub.tool);
        if let Some(run) = parent.run.lock().unwrap().as_ref() {
            let mut background = run.background.lock().unwrap();
            let key = format!("agent:{local}");
            if running {
                background.insert(key);
            } else {
                background.remove(&key);
            }
        }
    }
    pub(super) fn team_running(&self, t: &Arc<Thread>) {
        if let Some(sub) = &t.sub {
            if let Some(parent) = self.find(&sub.parent) {
                self.team_background(&parent, sub, true);
            }
            let root = self.family_root(t);
            let event = json!({"type":"agent","id":sub.tool,"status":"running","runId":t.id,"provider":*t.provider.lock().unwrap()});
            (self.emit)("agent:event", json!({"threadId":root.id,"ev":event}));
            self.team_record(
                t,
                json!({"type":"turn.queued","sequence":t.turn_sequence.load(Ordering::Acquire)}),
            );
        }
    }
    fn notify_completion(&self, t: &Arc<Thread>, cursor: Option<u64>) {
        let root = self.family_root(t);
        if let Some(sub) = &t.sub {
            if sub.notify.swap(false, Ordering::AcqRel) {
                let event = t.result.lock().unwrap().clone();
                let text = event["error"]
                    .as_str()
                    .filter(|e| !e.is_empty())
                    .or(event["text"].as_str())
                    .unwrap_or("");
                let notification = json!({"id":uuid::Uuid::new_v4().to_string(),"from":t.id,"kind":"agent.completed","status":state(t),"latest_cursor":cursor,"text":text.chars().take(16000).collect::<String>(),"full_events":"agent_events"});
                for recipient in [
                    Some(sub.parent.as_str()),
                    if root.id != sub.parent {
                        Some(root.id.as_str())
                    } else {
                        None
                    },
                ]
                .into_iter()
                .flatten()
                {
                    if let Some(parent) = self.find(recipient) {
                        if let Err(error) = self.enqueue_message(&parent, notification.clone()) {
                            self.team_record(t,json!({"type":"notification.failed","recipient":recipient,"error":error,"cursor":cursor}));
                        }
                    }
                }
            }
        }
    }
    pub(super) fn enqueue_message(&self, target: &Arc<Thread>, message: Value) -> Result<(), String> {
        if self.closing.load(Ordering::Acquire) {
            return Err("Application is closing".into());
        }
        if target.closed.load(Ordering::Acquire) {
            return Err("Recipient chat closed".into());
        }
        if message["kind"] == "agent.completed"
            && message["latest_cursor"]
                .as_u64()
                .is_some_and(|seq| seq > 0 && target.event_cursor.load(Ordering::Acquire) >= seq)
        {
            return Ok(());
        }
        let mut inbox = target.inbox.lock().unwrap();
        if message["kind"] == "agent.completed"
            && message["latest_cursor"]
                .as_u64()
                .is_some_and(|seq| seq > 0 && target.event_cursor.load(Ordering::Acquire) >= seq)
        {
            return Ok(());
        }
        if inbox.len() >= 128
            || inbox.iter().map(|m| m.to_string().len()).sum::<usize>() + message.to_string().len()
                > 1024 * 1024
        {
            if message["kind"] == "agent.completed" {
                // Keep a reserved compact wake-up when bursts fill the ordinary inbox.
                // Every result remains available in the canonical event journal.
                if let Some(notice) = inbox
                    .iter_mut()
                    .find(|m| m["kind"] == "agent.events_available")
                {
                    notice["latest_cursor"] = json!(notice["latest_cursor"]
                        .as_u64()
                        .unwrap_or(0)
                        .max(message["latest_cursor"].as_u64().unwrap_or(0)));
                } else {
                    inbox.push_back(json!({"id":uuid::Uuid::new_v4().to_string(),"from":"team","kind":"agent.events_available","latest_cursor":message["latest_cursor"],"text":"Your team has new completed results. Read agent_events from your last cursor; follow has_more to collect them all."}));
                }
                drop(inbox);
                self.schedule_inbox(target);
                return Ok(());
            }
            return Err("Agent mailbox is full; retry after delivery".into());
        }
        inbox.push_back(message.clone());
        drop(inbox);
        self.team_record(target, json!({"type":"message.queued","message":message}));
        self.schedule_inbox(target);
        Ok(())
    }
    pub(super) fn user_team_message(
        &self,
        parent: &Arc<Thread>,
        selector: &str,
        text: &str,
    ) -> Result<(), String> {
        let target = self.teammate(parent, selector)?;
        if target.sub.is_none() || target.id == parent.id {
            return Err("Select a delegated agent".into());
        }
        if text.trim().is_empty() || text.len() > 65536 {
            return Err("Message must contain 1 to 65536 bytes".into());
        }
        target.mailbox_paused.store(false, Ordering::Release);
        target
            .sub
            .as_ref()
            .unwrap()
            .notify
            .store(true, Ordering::Release);
        let id = uuid::Uuid::new_v4().to_string();
        self.enqueue_message(
            &target,
            json!({"id":id,"from":"user","kind":"message","text":text}),
        )?;
        (self.emit)(
            "agent:event",
            json!({"threadId":self.family_root(parent).id,"ev":{"type":"agent.msg","agent":target.sub.as_ref().unwrap().tool,"id":id,"dir":"to","text":text,"label":"message"}}),
        );
        Ok(())
    }
    pub(super) fn stop_team_from_ui(&self, parent: &str, selector: &str) -> bool {
        let Some(t) = self.find(parent) else {
            return false;
        };
        let Ok(target) = self.teammate(&t, selector) else {
            return false;
        };
        if target.sub.is_none() || target.id == t.id {
            return false;
        }
        self.stop_tree(&target);
        true
    }
    pub(super) fn schedule_inbox(&self, t: &Arc<Thread>) {
        if self.closing.load(Ordering::Acquire)
            || t.closed.load(Ordering::Acquire)
            || t.mailbox_paused.load(Ordering::Acquire)
            || t.inbox.lock().unwrap().is_empty()
            || t.run.lock().unwrap().as_ref().is_some_and(|r| {
                r.running.load(Ordering::Acquire)
                    || r.sending.load(Ordering::Acquire)
                    || r.stopping.load(Ordering::Acquire)
            })
            || t.delivering.swap(true, Ordering::AcqRel)
        {
            return;
        }
        let Some(owner) = self.weak.upgrade() else {
            t.delivering.store(false, Ordering::Release);
            return;
        };
        let target = t.clone();
        if owner.spawn(move |owner|{
            let messages:Vec<Value>={let mut queue=target.inbox.lock().unwrap();let count=queue.len().min(16);queue.drain(..count).collect()};
            if target.closed.load(Ordering::Acquire)||target.mailbox_paused.load(Ordering::Acquire){target.delivering.store(false,Ordering::Release);return;}
            let mut payload=target.config.lock().unwrap().clone();
            payload["threadId"]=json!(target.id);payload["provider"]=json!(*target.provider.lock().unwrap());payload["_idleOnly"]=json!(true);
            payload["text"]=json!(format!("<duet-agent-messages>\n{}\n</duet-agent-messages>\nMessages from your team. Use agent_events with a cursor to inspect full progress. Reply with message_agent; do not restart completed work unless the message asks for it.",json!(messages)));
            let sent=owner.send_thread(target.clone(),&payload);
            if let Err(error)=&sent{let mut inbox=target.inbox.lock().unwrap();if !target.closed.load(Ordering::Acquire)&&!target.mailbox_paused.load(Ordering::Acquire){for message in messages.into_iter().rev(){inbox.push_front(message);}}drop(inbox);owner.team_record(&target,json!({"type":"message.deferred","error":error}));}
            else{owner.team_record(&target,json!({"type":"message.delivered","message_ids":messages.iter().map(|m|&m["id"]).collect::<Vec<_>>()}));}
            target.delivering.store(false,Ordering::Release);
            if sent.is_ok()||sent.as_ref().err().is_some_and(|e|e=="Agent is still running; queue the message"){owner.schedule_inbox(&target);}
        }).is_err(){t.delivering.store(false,Ordering::Release);}
    }
    pub(super) fn stop_tree(&self, t: &Arc<Thread>) {
        self.context_cancel(t);
        t.mailbox_paused.store(true, Ordering::Release);
        for child in self.children(&t.id) {
            self.stop_tree(&child);
        }
        t.inbox.lock().unwrap().clear();
        if let Some(sub) = &t.sub {
            sub.notify.store(false, Ordering::Release);
        }
        let run = t.run.lock().unwrap().clone();
        if let Some(run) = run {
            {
                let _events = run.events.lock().unwrap();
                run.stopping.store(true, Ordering::Release);
            }
            self.emit_event(
                &run,
                json!({"type":"turn.end","text":"Stopped.","stopped":true,"isError":false}),
            );
            self.cancel(&run, None);
            // The session event precedes the turn/start reply. Let this run's
            // initial dispatch record its turn id before interrupt/unsubscribe.
            // Other agents use independent operation locks and remain live.
            let _dispatch = if run.provider == "codex" {
                Some(run.dispatch.lock().unwrap())
            } else {
                None
            };
            self.stop_run(&run);
        }
        self.collaboration.wake();
    }
    fn wait_team(
        &self,
        run: &Arc<Run>,
        targets: &[Arc<Thread>],
        duration: Duration,
        token: &AtomicBool,
    ) -> CoreResult {
        let start = Instant::now();
        let sequences: Vec<_> = targets
            .iter()
            .map(|t| t.turn_sequence.load(Ordering::Acquire))
            .collect();
        loop {
            let version = self.collaboration.version();
            if cancelled(run, token) {
                return Ok(answer(json!({"status":"cancelled"}), false));
            }
            let completed: Vec<_> = targets
                .iter()
                .zip(&sequences)
                .filter(|(t, seq)| {
                    t.result.lock().unwrap()["turnSequence"]
                        .as_u64()
                        .is_some_and(|done| done >= **seq)
                })
                .collect();
            if !completed.is_empty() || start.elapsed() >= duration {
                let rows:Vec<_>=targets.iter().zip(&sequences).map(|(target,sequence)|{
                    let result=target.result.lock().unwrap().clone();
                    let done=result["turnSequence"].as_u64().is_some_and(|done|done>=*sequence);
                    let status=if done {if result["stopped"]==true{"stopped"}else if result["isError"]==true{"error"}else{"done"}}else{state(target)};
                    let text=if done{result["error"].as_str().filter(|e|!e.is_empty()).or(result["text"].as_str()).unwrap_or("")}else{""};
                    let preview=text.chars().take(if targets.len()>1{4096}else{32000}).collect::<String>();
                    json!({"run_id":target.id,"status":status,"text_truncated":preview.len()<text.len(),"text":preview,"full_events":"agent_events","session_id":*target.session.lock().unwrap()})
                }).collect();
                let caller = run.thread.upgrade().ok_or("Chat closed")?;
                let result = if rows.len() == 1 {
                    let mut value = rows[0].clone();
                    value["cursor"] =
                        json!(self.collaboration.cursor(&self.family_root(&caller).id));
                    value
                } else {
                    json!({"agents":rows,"cursor":self.collaboration.cursor(&self.family_root(&caller).id)})
                };
                let error = rows.len() == 1 && rows[0]["status"] == "error";
                return Ok(answer(result, error));
            }
            self.collaboration
                .wait(version, duration.saturating_sub(start.elapsed()));
        }
    }
    fn with_events(
        &self,
        caller: &Arc<Thread>,
        mut result: Value,
        after: Option<u64>,
    ) -> CoreResult {
        let root = self.family_root(caller);
        let page = self.collaboration.page(
            &root.id,
            after.unwrap_or_else(|| caller.event_cursor.load(Ordering::Acquire)),
            None,
            100,
        )?;
        let cursor = page["cursor"].as_u64().unwrap_or(0);
        caller.event_cursor.fetch_max(cursor, Ordering::AcqRel);
        self.ack_team_events(caller, &page);
        let mut content = result["structuredContent"].take();
        for key in ["events", "cursor", "has_more"] {
            content[key] = page[key].clone();
        }
        content["latest_cursor"] = json!(self.collaboration.cursor(&root.id));
        Ok(answer(content, result["isError"] == true))
    }
    fn ack_team_events(&self, caller: &Arc<Thread>, page: &Value) {
        let delivered: HashSet<_> = arr(&page["events"])
            .iter()
            .filter(|entry| {
                entry["run_id"] == caller.id && entry["event"]["type"] == "message.queued"
            })
            .filter_map(|entry| entry["event"]["message"]["id"].as_str())
            .collect();
        let cursor = caller.event_cursor.load(Ordering::Acquire);
        caller.inbox.lock().unwrap().retain(|message| {
            let auto = matches!(
                s(message, "kind"),
                "agent.completed" | "agent.events_available"
            );
            !message["id"]
                .as_str()
                .is_some_and(|id| delivered.contains(id))
                && !(auto
                    && message["latest_cursor"]
                        .as_u64()
                        .is_some_and(|seq| seq > 0 && seq <= cursor))
        });
    }
    pub(super) fn team_tool(
        self: &Arc<Self>,
        run: &Arc<Run>,
        name: &str,
        args: &Value,
        tool_id: &str,
        token: &Arc<AtomicBool>,
    ) -> CoreResult {
        if cancelled(run, token) {
            return Err("Agent tool call cancelled".into());
        }
        let t = run.thread.upgrade().ok_or("Chat closed")?;
        let root = self.family_root(&t);
        match name {
            "run_agent" => {
                let depth = t.sub.as_ref().map(|s| s.depth).unwrap_or(0);
                if depth >= 3 {
                    return Err("Maximum delegation depth reached".into());
                }
                let provider = s(args, "agent");
                cli::require_enabled(provider)?;
                let task = s(args, "task");
                if task.trim().is_empty() || task.len() > 256 * 1024 {
                    return Err("Task must contain 1 to 262144 bytes".into());
                }
                let id = format!("sub-{}", uuid::Uuid::new_v4());
                let leaf = if tool_id.is_empty() || tool_id.len() > 64 {
                    id.clone()
                } else {
                    tool_id.to_owned()
                };
                let display = if let Some(sub) = &t.sub {
                    format!("{}::{leaf}", sub.tool)
                } else {
                    leaf.clone()
                };
                let mut cfg = t.config.lock().unwrap().clone();
                cfg["model"] = json!(args["model"]
                    .as_str()
                    .filter(|m| !m.is_empty())
                    .unwrap_or("default"));
                if provider != run.provider {
                    cfg["effort"] = Value::Null;
                    cfg["serviceTier"] = Value::Null;
                }
                cfg["oneshot"] = json!(false);
                cfg["instructions"]=json!(format!("You are a delegated agent in Duet. Your run_id is {id}; parent is {}; root is {}. Work on the assigned task. Use message_agent(run_id=parent|root|a teammate run_id) to send progress, questions or handoffs; busy recipients queue messages. list_agents lists your team. agent_events provides every event with replay cursors. Do not wait for an ancestor that is waiting for your answer.",t.id,root.id));
                if args["read_only"] == true {
                    cfg["permissionMode"] = json!("plan");
                }
                let child = Arc::new(Thread {
                    id: id.clone(),
                    provider: Mutex::new(provider.into()),
                    config: Mutex::new(cfg.clone()),
                    session: Mutex::new(String::new()),
                    resume_at: Mutex::new(None),
                    run: Mutex::new(None),
                    lifecycle: Mutex::new(()),
                    context_scope: Mutex::new(String::new()),
                    context_gate: Mutex::new(()),
                    context_waiting: AtomicBool::new(false),
                    sub: Some(Sub {
                        parent: t.id.clone(),
                        tool: display.clone(),
                        depth: depth + 1,
                        notify: AtomicBool::new(args["background"] == true),
                    }),
                    hidden: false,
                    result: Mutex::new(Value::Null),
                    wake: Condvar::new(),
                    inbox: Mutex::new(VecDeque::new()),
                    delivering: AtomicBool::new(false),
                    closed: AtomicBool::new(false),
                    mailbox_paused: AtomicBool::new(false),
                    turn_sequence: AtomicU64::new(0),
                    event_cursor: AtomicU64::new(0),
                });
                let admission = self.team_admission.lock().unwrap();
                let family = self.family(&t);
                if family.len() >= 256
                    || family.iter().filter(|t| state(t) == "running").count() >= 64
                {
                    return Err(
                        "This team reached its agent limit (64 running, 256 retained)".into(),
                    );
                }
                {
                    let mut threads = self.threads.lock().unwrap();
                    if threads.len() >= 2048 {
                        return Err("Too many agents".into());
                    }
                    threads.insert(id.clone(), child.clone());
                }
                drop(admission);
                self.emit_event(run,json!({"type":"agent","id":leaf,"runId":id,"parentId":t.sub.as_ref().map(|s|&s.tool),"name":task.lines().next().unwrap_or("").chars().take(80).collect::<String>(),"prompt":task,"provider":provider,"model":cfg["model"],"background":args["background"]==true}));
                cfg["threadId"] = json!(id);
                cfg["provider"] = json!(provider);
                cfg["text"] = json!(task);
                if let Err(error) = self.send(&cfg) {
                    if let Ok(child_run) = self.active(&id) {
                        self.failed(&child_run, error.clone());
                    }
                    self.close_thread(&id);
                    return Err(error);
                }
                if args["background"] == true {
                    return Ok(answer(
                        json!({"run_id":id,"status":"running","cursor":t.event_cursor.load(Ordering::Acquire),"latest_cursor":self.collaboration.cursor(&root.id)}),
                        false,
                    ));
                }
                let result = self.wait_team(run, &[child.clone()], timeout(args, 30.), token)?;
                if result["structuredContent"]["status"] == "running"
                    || result["structuredContent"]["status"] == "cancelled"
                {
                    child
                        .sub
                        .as_ref()
                        .unwrap()
                        .notify
                        .store(true, Ordering::Release);
                    if state(&child) != "running" {
                        self.notify_completion(&child, Some(self.collaboration.cursor(&root.id)));
                    }
                }
                self.with_events(&t, result, None)
            }
            "message_agent" => {
                let target = self.teammate(&t, s(args, "run_id"))?;
                if target.id == t.id {
                    return Err("Cannot send a message to yourself".into());
                }
                let text = s(args, "message");
                if text.trim().is_empty() || text.len() > 64 * 1024 {
                    return Err("Message must contain 1 to 65536 bytes".into());
                }
                let message_id = uuid::Uuid::new_v4().to_string();
                target.mailbox_paused.store(false, Ordering::Release);
                if let Some(sub) = &target.sub {
                    sub.notify.store(true, Ordering::Release);
                }
                self.enqueue_message(
                    &target,
                    json!({"id":message_id,"from":t.id,"kind":"message","text":text}),
                )?;
                self.team_record(&t,json!({"type":"message.sent","to":target.id,"message_id":message_id,"text":text}));
                (self.emit)(
                    "agent:event",
                    json!({"threadId":root.id,"ev":{"type":"agent.msg","agent":target.sub.as_ref().map(|s|s.tool.as_str()).or(t.sub.as_ref().map(|s|s.tool.as_str())).unwrap_or("root"),"dir":if target.id==root.id{"from"}else{"to"},"text":text,"label":"message","id":message_id}}),
                );
                Ok(answer(
                    json!({"run_id":target.id,"message_id":message_id,"status":"queued","cursor":t.event_cursor.load(Ordering::Acquire),"latest_cursor":self.collaboration.cursor(&root.id)}),
                    false,
                ))
            }
            "list_agents" => Ok(answer(
                json!({"self":t.id,"root":root.id,"cursor":t.event_cursor.load(Ordering::Acquire),"latest_cursor":self.collaboration.cursor(&root.id),"agents":self.family(&t).iter().map(|t|json!({"run_id":t.id,"parent_id":t.sub.as_ref().map(|s|&s.parent),"agent_id":t.sub.as_ref().map(|s|&s.tool),"provider":*t.provider.lock().unwrap(),"status":state(t),"queued_messages":t.inbox.lock().unwrap().len()})).collect::<Vec<_>>()}),
                false,
            )),
            "wait_agent" => {
                let selectors: Vec<_> = if args["run_ids"].is_array() {
                    arr(&args["run_ids"])
                        .iter()
                        .filter_map(Value::as_str)
                        .collect()
                } else {
                    vec![s(args, "run_id")]
                };
                if selectors.is_empty() || selectors.len() > 64 {
                    return Err("Provide 1 to 64 run ids".into());
                }
                let targets = selectors
                    .iter()
                    .map(|id| self.teammate(&t, id))
                    .collect::<Result<Vec<_>, _>>()?;
                if targets.iter().any(|x| x.id == t.id) {
                    return Err("Cannot wait for yourself".into());
                }
                let mut ancestor = t.clone();
                while let Some(sub) = &ancestor.sub {
                    if targets.iter().any(|x| x.id == sub.parent) {
                        return Err("Cannot wait for an ancestor; send a message or use agent_events instead".into());
                    }
                    let Some(parent) = self.find(&sub.parent) else {
                        break;
                    };
                    ancestor = parent;
                }
                let result = self.wait_team(run, &targets, timeout(args, 30.), token)?;
                self.with_events(&t, result, args["after"].as_u64())
            }
            "agent_events" => {
                let filter = if let Some(id) = args["run_id"].as_str() {
                    Some(self.teammate(&t, id)?.id.clone())
                } else {
                    None
                };
                let start = Instant::now();
                let duration = timeout(args, 0.);
                loop {
                    let version = self.collaboration.version();
                    if cancelled(run, token) {
                        return Ok(answer(json!({"status":"cancelled"}), false));
                    }
                    let page = self.collaboration.page(
                        &root.id,
                        args["after"]
                            .as_u64()
                            .unwrap_or_else(|| t.event_cursor.load(Ordering::Acquire)),
                        filter.as_deref(),
                        args["limit"].as_u64().unwrap_or(100).clamp(1, 200) as usize,
                    )?;
                    if !arr(&page["events"]).is_empty() || start.elapsed() >= duration {
                        if filter.is_none() {
                            t.event_cursor
                                .fetch_max(page["cursor"].as_u64().unwrap_or(0), Ordering::AcqRel);
                        }
                        self.ack_team_events(&t, &page);
                        return Ok(answer(page, false));
                    }
                    self.collaboration
                        .wait(version, duration.saturating_sub(start.elapsed()));
                }
            }
            "read_agent_event" => Ok(answer(
                self.collaboration.detail(
                    &root.id,
                    args["seq"].as_u64().ok_or("Missing event sequence")?,
                    args["offset"].as_u64().unwrap_or(0) as usize,
                    args["max_bytes"].as_u64().unwrap_or(65536) as usize,
                )?,
                false,
            )),
            "stop_agent" => {
                let target = self.teammate(&t, s(args, "run_id"))?;
                if target.id == t.id
                    || !self.family(&t).iter().skip(1).any(|c| c.id == target.id) && t.id == root.id
                {
                    return Err("Cannot stop this agent".into());
                }
                let mut parent = target.clone();
                let mut descendant = false;
                while let Some(sub) = &parent.sub {
                    if sub.parent == t.id {
                        descendant = true;
                        break;
                    }
                    let Some(next) = self.find(&sub.parent) else {
                        break;
                    };
                    parent = next;
                }
                if !descendant {
                    return Err("Only a parent or root can stop this agent".into());
                }
                self.stop_tree(&target);
                Ok(answer(
                    json!({"run_id":target.id,"status":"stopped"}),
                    false,
                ))
            }
            _ => Err("Unknown delegation tool".into()),
        }
    }
}

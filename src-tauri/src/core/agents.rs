//! Provider-neutral runs, generations, permissions, delegation and native CLI clients.
#[path = "collaboration.rs"]
mod collaboration;
use super::{
    cli, codex,
    events::{self, arr, s, HistoryState},
    history::History,
    live, process,
    rpc::Client,
    storage::{self, Storage},
    toolsets, CoreResult, Emit,
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        mpsc, Arc, Condvar, Mutex, Weak,
    },
    time::{Duration, Instant},
};
pub type Host = Arc<dyn Fn(&str, Value) -> CoreResult + Send + Sync>;
struct Sub {
    parent: String,
    tool: String,
    depth: usize,
    notify: AtomicBool,
}
struct Thread {
    id: String,
    provider: Mutex<String>,
    config: Mutex<Value>,
    session: Mutex<String>,
    resume_at: Mutex<Option<String>>,
    run: Mutex<Option<Arc<Run>>>,
    lifecycle: Mutex<()>,
    sub: Option<Sub>,
    hidden: bool,
    result: Mutex<Value>,
    wake: Condvar,
    inbox: Mutex<std::collections::VecDeque<Value>>,
    delivering: AtomicBool,
    closed: AtomicBool,
    mailbox_paused: AtomicBool,
    turn_sequence: AtomicU64,
    event_cursor: AtomicU64,
}
struct Run {
    thread: Weak<Thread>,
    provider: String,
    client: Mutex<Option<Arc<Client>>>,
    operation: Mutex<()>,
    dispatch: Mutex<()>,
    events: Mutex<()>,
    stopping: AtomicBool,
    sends: Mutex<std::collections::VecDeque<Value>>,
    sending: AtomicBool,
    alive: AtomicBool,
    running: AtomicBool,
    manual_compact: AtomicBool,
    last: AtomicU64,
    started: AtomicU64,
    background: Mutex<HashSet<String>>,
    claude: Mutex<live::Claude>,
    codex: Mutex<events::CodexTranslator>,
    google: Mutex<Option<live::Google>>,
    patch_approvals: Mutex<HashMap<String, Value>>,
    source: String,
    requests: Mutex<HashMap<String, Arc<AtomicBool>>>,
    failing: AtomicBool,
    journal_replays: Mutex<HashSet<String>>,
    cancelled_requests: Mutex<HashSet<String>>,
}
struct Approval {
    thread: String,
    run: Weak<Run>,
    source: String,
    tx: mpsc::SyncSender<Value>,
}
pub struct Agents {
    weak: Weak<Self>,
    collaboration: collaboration::Bus,
    team_admission: Mutex<()>,
    storage: Arc<Storage>,
    history: Arc<History>,
    emit: Emit,
    pub host: Mutex<Option<Host>>,
    threads: Mutex<HashMap<String, Arc<Thread>>>,
    server: Mutex<Option<Arc<Client>>>,
    routes: Mutex<HashMap<String, Weak<Run>>>,
    approvals: Mutex<HashMap<String, Approval>>,
    state: Mutex<Option<rusqlite::Connection>>,
    probe: Mutex<Option<(u64, Value)>>,
    jobs: AtomicUsize,
    closing: AtomicBool,
    task_files: Mutex<HashSet<PathBuf>>,
}
impl Agents {
    pub fn new(storage: Arc<Storage>, history: Arc<History>, emit: Emit) -> Arc<Self> {
        Arc::new_cyclic(|weak| Self {
            weak: weak.clone(),
            collaboration: collaboration::Bus::new(
                storage.data.join("native/collaboration.sqlite3"),
            ),
            team_admission: Mutex::new(()),
            storage,
            history,
            emit,
            host: Mutex::new(None),
            threads: Mutex::new(HashMap::new()),
            server: Mutex::new(None),
            routes: Mutex::new(HashMap::new()),
            approvals: Mutex::new(HashMap::new()),
            state: Mutex::new(None),
            probe: Mutex::new(None),
            jobs: AtomicUsize::new(0),
            closing: AtomicBool::new(false),
            task_files: Mutex::new(HashSet::new()),
        })
    }
    pub fn set_host(&self, host: Host) {
        *self.host.lock().unwrap() = Some(host)
    }
    pub fn host(&self, method: &str, p: Value) -> CoreResult {
        // Native evaluations may wait on a page. Never hold the host registry
        // mutex while executing one: other tabs and UI services must progress.
        let host = self.host.lock().unwrap().clone();
        host.ok_or("Native desktop is unavailable")?(method, p)
    }
    fn thread(&self, id: &str, provider: &str) -> Result<Arc<Thread>, String> {
        if id.is_empty() || id.len() > 256 {
            return Err("Invalid chat id".into());
        }
        let mut threads = self.threads.lock().unwrap();
        if let Some(t) = threads.get(id) {
            return Ok(t.clone());
        }
        if threads.len() >= 2048 {
            return Err("Too many open chats".into());
        }
        if !cli::IDS.contains(&provider) {
            return Err("Unknown provider".into());
        }
        let t = Arc::new(Thread {
            id: id.into(),
            provider: Mutex::new(provider.into()),
            config: Mutex::new(json!({})),
            session: Mutex::new(String::new()),
            resume_at: Mutex::new(None),
            run: Mutex::new(None),
            lifecycle: Mutex::new(()),
            sub: None,
            hidden: false,
            result: Mutex::new(Value::Null),
            wake: Condvar::new(),
            inbox: Mutex::new(Default::default()),
            delivering: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            mailbox_paused: AtomicBool::new(false),
            turn_sequence: AtomicU64::new(0),
            event_cursor: AtomicU64::new(0),
        });
        threads.insert(id.into(), t.clone());
        Ok(t)
    }
    fn find(&self, id: &str) -> Option<Arc<Thread>> {
        self.threads.lock().unwrap().get(id).cloned()
    }
    fn active(&self, id: &str) -> Result<Arc<Run>, String> {
        self.find(id)
            .and_then(|t| t.run.lock().unwrap().clone())
            .filter(|r| r.alive.load(Ordering::Acquire))
            .ok_or("Session is inactive".into())
    }
    fn current(run: &Arc<Run>) -> bool {
        run.alive.load(Ordering::Acquire)
            && run.thread.upgrade().is_some_and(|t| {
                !t.closed.load(Ordering::Acquire)
                    && t.run
                        .lock()
                        .unwrap()
                        .as_ref()
                        .is_some_and(|r| Arc::ptr_eq(r, run))
            })
    }
    fn start(&self, t: &Arc<Thread>) -> Arc<Run> {
        let _lifecycle = t.lifecycle.lock().unwrap();
        let mut current = t.run.lock().unwrap();
        if let Some(run) = current.as_ref().filter(|r| r.alive.load(Ordering::Acquire)) {
            return run.clone();
        }
        let run = Arc::new(Run {
            thread: Arc::downgrade(t),
            provider: t.provider.lock().unwrap().clone(),
            client: Mutex::new(None),
            operation: Mutex::new(()),
            dispatch: Mutex::new(()),
            events: Mutex::new(()),
            stopping: AtomicBool::new(false),
            sends: Mutex::new(Default::default()),
            sending: AtomicBool::new(false),
            alive: AtomicBool::new(true),
            running: AtomicBool::new(false),
            manual_compact: AtomicBool::new(false),
            last: AtomicU64::new(storage::now()),
            started: AtomicU64::new(storage::now()),
            background: Mutex::new(HashSet::new()),
            claude: Mutex::new(live::Claude::default()),
            codex: Mutex::new(events::CodexTranslator::default()),
            google: Mutex::new(None),
            patch_approvals: Mutex::new(HashMap::new()),
            source: uuid::Uuid::new_v4().to_string(),
            requests: Mutex::new(HashMap::new()),
            failing: AtomicBool::new(false),
            journal_replays: Mutex::new(HashSet::new()),
            cancelled_requests: Mutex::new(HashSet::new()),
        });
        *current = Some(run.clone());
        run
    }
    fn state<T>(
        &self,
        source: &str,
        f: impl FnOnce(&HistoryState) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut g = self.state.lock().unwrap();
        if g.is_none() {
            let p = self.storage.data.join("native/live.sqlite3");
            std::fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
            let db = rusqlite::Connection::open(p).map_err(|e| e.to_string())?;
            db.execute_batch("PRAGMA journal_mode=WAL;PRAGMA cache_size=-2048;PRAGMA temp_store=FILE;PRAGMA mmap_size=0;CREATE TABLE IF NOT EXISTS history_state(source TEXT,space TEXT,key TEXT,name TEXT,value TEXT,PRIMARY KEY(source,space,key));DELETE FROM history_state;").map_err(|e|e.to_string())?;
            *g = Some(db);
        }
        f(&HistoryState {
            db: g.as_ref().unwrap(),
            source,
        })
    }
    fn emit_event(&self, run: &Arc<Run>, mut ev: Value) {
        // Serialize callbacks with the stop barrier. A callback that passed an
        // earlier liveness check must not publish progress after a terminal stop.
        let event_guard = run.events.lock().unwrap();
        if !Self::current(run) || (run.stopping.load(Ordering::Acquire) && ev["stopped"] != true) {
            return;
        }
        let Some(t) = run.thread.upgrade() else {
            return;
        };
        run.last.store(storage::now(), Ordering::Relaxed);
        if ev["timestamp"].is_null() {
            ev["timestamp"] = json!(storage::now())
        }
        match s(&ev, "type") {
            "step" if ev["agent"].is_null() => {
                run.running.store(true, Ordering::Release);
            }
            "session" => {
                if let Some(id) = ev["sessionId"].as_str() {
                    *t.session.lock().unwrap() = id.into();
                    if let Some(sub) = &t.sub {
                        if let Some(parent) = self.find(&sub.parent) {
                            let parent_id = parent.session.lock().unwrap().clone();
                            if !parent_id.is_empty() {
                                let _ = self.storage.update("native/delegates.json", |links| {
                                    links[&parent_id][&sub.tool] =
                                        json!({"sessionId":id,"provider":run.provider});
                                    Ok(())
                                });
                            }
                        }
                    }
                }
            }
            "turn.end" if ev["agent"].is_null() => {
                if t.hidden || t.sub.is_some() {
                    let mut result = ev.clone();
                    result["turnSequence"] = json!(t.turn_sequence.load(Ordering::Acquire));
                    for key in ["text", "error"] {
                        if let Some(text) =
                            result[key].as_str().filter(|text| text.len() > 1024 * 1024)
                        {
                            let mut end = 1024 * 1024;
                            while !text.is_char_boundary(end) {
                                end -= 1
                            }
                            result[key]=json!(format!("{}\n[Answer truncated here; the complete transcript is saved in this chat.]",&text[..end]));
                        }
                    }
                    *t.result.lock().unwrap() = result;
                }
                run.running.store(false, Ordering::Release);
                t.wake.notify_all();
            }
            "limits" => {
                ev["provider"] = json!(run.provider);
            }
            "agent" => {
                let id = format!("agent:{}", s(&ev, "id"));
                let mut bg = run.background.lock().unwrap();
                if !s(&ev, "status").is_empty() && ev["status"] != "running" {
                    bg.remove(&id);
                } else {
                    bg.insert(id);
                }
            }
            "agent.drop" | "agent.mark" => {
                run.background
                    .lock()
                    .unwrap()
                    .remove(&format!("agent:{}", s(&ev, "id")));
            }
            "task" => {
                let mut bg = run.background.lock().unwrap();
                let id = format!("task:{}", s(&ev, "id"));
                match s(&ev, "op") {
                    "start" => {
                        bg.insert(id);
                    }
                    "end" => {
                        bg.remove(&id);
                        if let Some(tool) = ev["toolUseId"].as_str() {
                            bg.remove(&format!("agent:{tool}"));
                        }
                        if let Some(file) = ev["outputFile"].as_str() {
                            self.task_files.lock().unwrap().insert(PathBuf::from(file));
                        }
                    }
                    "background" => {
                        bg.retain(|x| !x.starts_with("task:"));
                        for task in arr(&ev["tasks"]) {
                            bg.insert(format!("task:{}", s(task, "id")));
                        }
                    }
                    "update"
                        if matches!(
                            s(&ev, "status"),
                            "completed" | "failed" | "killed" | "stopped"
                        ) =>
                    {
                        bg.remove(&id);
                    }
                    _ => {}
                }
            }
            _ => {}
        }
        let skip_journal = ev["_skipJournal"] == true;
        if let Some(map) = ev.as_object_mut() {
            map.remove("_skipJournal");
        }
        if !skip_journal
            && matches!(run.provider.as_str(), "antigravity" | "gemini")
            && ev["type"] != "session"
        {
            let sid = t.session.lock().unwrap().clone();
            if !sid.is_empty() {
                if let Err(e) = self.history.journal_append(&run.provider, &sid, &ev) {
                    drop(event_guard);
                    self.failed(run, e);
                    return;
                }
            }
        }
        self.route_team_event(run, &t, ev);
    }
    fn failed(&self, run: &Arc<Run>, error: String) {
        if !Self::current(run) {
            return;
        }
        run.failing.store(true, Ordering::Release);
        self.emit_event(
            run,
            json!({"type":"turn.end","isError":true,"error":error,"text":"","_skipJournal":true}),
        );
        let Some(t) = run.thread.upgrade() else {
            return;
        };
        self.stop_run(run);
        self.schedule_inbox(&t);
        if t.sub.is_none() && !t.hidden {
            (self.emit)("agent:closed", json!({"threadId":t.id,"error":error}));
        }
    }
    fn stop_run(&self, run: &Arc<Run>) {
        let thread = run.thread.upgrade();
        // Serialize cleanup with acquisition of the next run of this same chat.
        // Event readers only take run, so initialization responses can still be consumed.
        let _lifecycle = thread.as_ref().map(|t| t.lifecycle.lock().unwrap());
        {
            let _events = run.events.lock().unwrap();
            run.stopping.store(true, Ordering::Release);
            if !run.alive.swap(false, Ordering::AcqRel) {
                return;
            }
            run.running.store(false, Ordering::Release);
        }
        self.cancel(run, None);
        self.collaboration.wake();
        if let Some(c) = run.client.lock().unwrap().take() {
            if run.provider != "codex" {
                c.close()
            } else if let Some(t) = run.thread.upgrade() {
                let sid = t.session.lock().unwrap().clone();
                if !sid.is_empty() {
                    if let Some(turn) = run.codex.lock().unwrap().turn.clone() {
                        let _ =
                            c.send_request("turn/interrupt", json!({"threadId":sid,"turnId":turn}));
                    }
                    // Queue unsubscribe before a successor can issue thread/resume.
                    let _ = c.send_request("thread/unsubscribe", json!({"threadId":sid}));
                }
            }
        }
        self.routes
            .lock()
            .unwrap()
            .retain(|_, r| r.upgrade().is_some_and(|r| !Arc::ptr_eq(&r, run)));
        if let Some(t) = thread.as_ref() {
            let mut r = t.run.lock().unwrap();
            if r.as_ref().is_some_and(|r| Arc::ptr_eq(r, run)) {
                *r = None
            }
            t.wake.notify_all();
        }
        let _ = self.state(&run.source, |state| {
            state
                .db
                .execute("DELETE FROM history_state WHERE source=?1", [&run.source])
                .map_err(|e| e.to_string())?;
            Ok(())
        });
    }
    fn spawn(self: &Arc<Self>, job: impl FnOnce(Arc<Self>) + Send + 'static) -> Result<(), String> {
        if self.closing.load(Ordering::Acquire) {
            return Err("Application is closing".into());
        }
        if self.jobs.fetch_add(1, Ordering::AcqRel) >= 128 {
            self.jobs.fetch_sub(1, Ordering::Release);
            return Err("Too many concurrent agent operations".into());
        }
        let owner = self.clone();
        std::thread::spawn(move || {
            struct Count(Arc<Agents>);
            impl Drop for Count {
                fn drop(&mut self) {
                    self.0.jobs.fetch_sub(1, Ordering::Release);
                }
            }
            let _count = Count(owner.clone());
            job(owner);
        });
        Ok(())
    }
    pub fn send(self: &Arc<Self>, payload: &Value) -> CoreResult {
        let id = s(payload, "threadId");
        if let Some(target) = payload["delegate"].as_str() {
            let parent = self.find(id).ok_or("Chat is inactive")?;
            self.user_team_message(&parent, target, s(payload, "text"))?;
            return Ok(json!(true));
        }
        let provider = payload["provider"].as_str().unwrap_or("claude");
        let t = self.thread(id, provider)?;
        self.send_thread(t, payload)
    }
    fn send_thread(self: &Arc<Self>, t: Arc<Thread>, payload: &Value) -> CoreResult {
        cli::require_enabled(payload["provider"].as_str().unwrap_or("claude"))?;
        if t.closed.load(Ordering::Acquire) {
            return Err("Chat closed".into());
        }
        if payload["_idleOnly"] != true {
            t.mailbox_paused.store(false, Ordering::Release);
        }
        let provider = payload["provider"].as_str().unwrap_or("claude");
        let changed = { *t.provider.lock().unwrap() != provider };
        if changed {
            let previous = { t.run.lock().unwrap().clone() };
            if let Some(run) = previous {
                self.stop_run(&run)
            }
            *t.provider.lock().unwrap() = provider.into();
            *t.session.lock().unwrap() = payload["resume"].as_str().unwrap_or("").into();
        }
        {
            let mut cfg = t.config.lock().unwrap();
            for k in [
                "cwd",
                "dirs",
                "model",
                "effort",
                "permissionMode",
                "chrome",
                "instructions",
                "oneshot",
                "serviceTier",
            ] {
                if let Some(v) = payload.get(k) {
                    cfg[k] = v.clone()
                }
            }
        }
        if let Some(resume) = payload["resume"].as_str().filter(|s| !s.is_empty()) {
            let empty = { t.session.lock().unwrap().is_empty() };
            if empty {
                *t.session.lock().unwrap() = resume.into();
            }
        }
        let run = self.start(&t);
        if run.stopping.load(Ordering::Acquire) {
            return Err("Agent is stopping; retry after it stops".into());
        }
        let was_running = run.running.swap(true, Ordering::AcqRel);
        if was_running
            && (matches!(provider, "antigravity" | "gemini") || payload["_idleOnly"] == true)
        {
            return Err("Agent is still running; queue the message".into());
        }
        if !was_running {
            t.turn_sequence.fetch_add(1, Ordering::AcqRel);
            self.team_running(&t);
        }
        run.started.store(storage::now(), Ordering::Relaxed);
        if t.sub.is_none() {
            *t.result.lock().unwrap() = Value::Null;
        }
        let mut p = payload.clone();
        p["_wasRunning"] = json!(was_running);
        let mut sends = run.sends.lock().unwrap();
        if sends.len() >= 128 {
            run.running.store(was_running, Ordering::Release);
            return Err("Too many pending messages; retry after delivery".into());
        }
        sends.push_back(p);
        if run.sending.swap(true, Ordering::AcqRel) {
            return Ok(json!(true));
        }
        let r = run.clone();
        if let Err(e) = self.spawn(move |owner| loop {
            let p = {
                let mut sends = r.sends.lock().unwrap();
                let next = sends.pop_front();
                if next.is_none() {
                    r.sending.store(false, Ordering::Release);
                }
                next
            };
            let Some(p) = p else {
                if let Some(t) = r.thread.upgrade() {
                    owner.schedule_inbox(&t);
                }
                return;
            };
            // Once initialized, input must not wait behind a settings/review control RPC.
            let ready = p["priority"] == "next"
                && r.client
                    .lock()
                    .unwrap()
                    .as_ref()
                    .is_some_and(|client| !client.closed.load(Ordering::Acquire));
            let _lock = if ready {
                None
            } else {
                Some(r.operation.lock().unwrap())
            };
            let _dispatch = r.dispatch.lock().unwrap();
            if !Self::current(&r) || r.stopping.load(Ordering::Acquire) {
                r.sends.lock().unwrap().clear();
                r.sending.store(false, Ordering::Release);
                return;
            }
            match owner.send_now(&r, &p) {
                Ok(()) => owner.message_receipt(&r, &p, "accepted", None),
                Err(error) if p["priority"] == "next" => {
                    owner.message_receipt(&r, &p, "failed", Some(&error))
                }
                Err(error) => {
                    owner.failed(&r, error);
                    r.sends.lock().unwrap().clear();
                    r.sending.store(false, Ordering::Release);
                    return;
                }
            }
        }) {
            sends.clear();
            run.sending.store(false, Ordering::Release);
            run.running.store(was_running, Ordering::Release);
            return Err(e);
        }
        Ok(json!(true))
    }
    fn message_receipt(&self, run: &Arc<Run>, message: &Value, status: &str, error: Option<&str>) {
        if let Some(id) = message["uuid"].as_str() {
            self.emit_event(
                run,
                json!({"type":"message.receipt","id":id,"status":status,"error":error}),
            );
        }
    }
    fn ensure(self: &Arc<Self>, run: &Arc<Run>) -> Result<Arc<Client>, String> {
        if let Some(c) = run
            .client
            .lock()
            .unwrap()
            .clone()
            .filter(|c| !c.closed.load(Ordering::Acquire))
        {
            return Ok(c);
        }
        if !Self::current(run) {
            return Err("Run superseded".into());
        }
        let t = run.thread.upgrade().ok_or("Chat closed")?;
        let cfg = t.config.lock().unwrap().clone();
        let cwd = cfg["cwd"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .unwrap_or(self.storage.home.clone());
        let resume = t.session.lock().unwrap().clone();
        if run.provider == "codex" {
            let c = self.codex_server()?;
            let pol = policy(s(&cfg, "permissionMode"), &cfg);
            let mut params =
                json!({"cwd":cwd,"approvalPolicy":pol["approvalPolicy"],"sandbox":pol["sandbox"]});
            params["approvalsReviewer"] = json!(if cfg["permissionMode"] == "auto" {
                "auto_review"
            } else {
                "user"
            });
            if let Some(tier) = cfg["serviceTier"].as_str() {
                params["serviceTier"] = json!(tier);
            }
            let model = self.codex_model(&c, s(&cfg, "model"));
            if let Some(model) = model {
                params["model"] = json!(model)
            }
            if !s(&cfg, "instructions").is_empty() {
                params["developerInstructions"] = cfg["instructions"].clone()
            }
            let result = if resume.is_empty() {
                let tools=toolsets::all(t.sub.as_ref().map(|s|s.depth).unwrap_or(0)).into_iter().flat_map(|set|arr(&set["tools"]).iter().map(|tool|json!({"namespace":set["name"],"name":tool["name"],"description":tool["description"],"inputSchema":tool["inputSchema"]})).collect::<Vec<_>>()).collect::<Vec<_>>();
                params["dynamicTools"] = json!(tools);
                c.request("thread/start", params)?
            } else {
                params["threadId"] = json!(resume);
                c.request("thread/resume", params)?
            };
            let sid = result["thread"]["id"]
                .as_str()
                .ok_or("Codex returned no thread id")?
                .to_owned();
            self.routes
                .lock()
                .unwrap()
                .insert(sid.clone(), Arc::downgrade(run));
            if !resume.is_empty() && !s(&cfg, "instructions").is_empty() {
                c.request("thread/inject_items",json!({"threadId":sid,"items":[{"type":"message","role":"developer","content":[{"type":"input_text","text":cfg["instructions"]}]}]}))?;
            }
            *run.client.lock().unwrap() = Some(c.clone());
            self.emit_event(
                run,
                json!({"type":"session","sessionId":sid,"model":result["model"]}),
            );
            t.config.lock().unwrap()["instructions"] = Value::Null;
            return Ok(c);
        }
        if run.provider != "claude" {
            return self.google_launch(run, &cfg, &cwd, &resume);
        }
        let mut program =
            cli::subscription(&self.storage, "claude", cli::find(&self.storage, "claude")?)?;
        program.env.extend([
            ("CLAUDE_CODE_ENTRYPOINT".into(), "sdk-ts".into()),
            (
                "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING".into(),
                "true".into(),
            ),
            ("CLAUDE_CODE_SDK_READS_SESSION_STATE".into(), "1".into()),
        ]);
        program
            .unset
            .extend(["NODE_OPTIONS".into(), "CLAUDECODE".into()]);
        let mut args = vec![
            "--output-format".into(),
            "stream-json".into(),
            "--verbose".into(),
            "--input-format".into(),
            "stream-json".into(),
            "--permission-prompt-tool".into(),
            "stdio".into(),
            "--include-partial-messages".into(),
            "--allow-dangerously-skip-permissions".into(),
            "--permission-mode".into(),
            cfg["permissionMode"].as_str().unwrap_or("default").into(),
        ];
        for (key, flag) in [("model", "--model"), ("effort", "--effort")] {
            let v = s(&cfg, key);
            if !v.is_empty() && v != "default" {
                args.extend([flag.into(), v.into()])
            }
        }
        if !s(&cfg, "model").to_lowercase().contains("haiku") {
            args.extend([
                "--thinking".into(),
                "adaptive".into(),
                "--thinking-display".into(),
                "summarized".into(),
            ])
        }
        for dir in arr(&cfg["dirs"]).iter().filter_map(Value::as_str) {
            args.extend(["--add-dir".into(), dir.into()])
        }
        if !resume.is_empty() {
            args.push(format!("--resume={resume}"));
            if let Some(at) = t.resume_at.lock().unwrap().take() {
                args.push(format!("--resume-session-at={at}"))
            }
        }
        if let Some(chrome) = cfg["chrome"].as_bool() {
            args.push(if chrome { "--chrome" } else { "--no-chrome" }.into())
        }
        let oneshot = cfg["oneshot"] == true;
        if oneshot {
            args.extend([
                "--no-session-persistence".into(),
                "--strict-mcp-config".into(),
                "--setting-sources=".into(),
                "--tools".into(),
                "".into(),
                "--max-turns".into(),
                "1".into(),
            ]);
        }
        let weak = Arc::downgrade(self);
        let wr = Arc::downgrade(run);
        let exit_owner = weak.clone();
        let exit_run = wr.clone();
        let c = Client::spawn(
            &program,
            &args,
            &cwd,
            Arc::new(move |c, msg| {
                if let (Some(owner), Some(run)) = (weak.upgrade(), wr.upgrade()) {
                    owner.claude_wire(&run, c, msg)
                }
            }),
            Arc::new(move |error| {
                if let (Some(owner), Some(run)) = (exit_owner.upgrade(), exit_run.upgrade()) {
                    owner.failed(&run, error)
                }
            }),
        )?;
        *run.client.lock().unwrap() = Some(c.clone());
        let sets = if oneshot {
            vec![]
        } else {
            toolsets::all(t.sub.as_ref().map(|s| s.depth).unwrap_or(0))
        };
        let mut init = json!({"subtype":"initialize","sdkMcpServers":sets.iter().map(|v|s(v,"name")).collect::<Vec<_>>(),"agentProgressSummaries":true,"forwardSubagentText":true,"perTaskStopAffordance":true});
        if !s(&cfg, "instructions").is_empty() {
            init["appendSystemPrompt"] = cfg["instructions"].clone();
        }
        let result = c.control(init)?;
        validate_claude_account(&result["account"])?;
        if !result["account"]["apiKeySource"].is_null()
            && result["account"]["apiKeySource"] != "none"
            && result["account"]["apiKeySource"] != ""
        {
            c.close();
            return Err("Claude must use a subscription login, not an API key".into());
        }
        Ok(c)
    }
    fn send_now(self: &Arc<Self>, run: &Arc<Run>, msg: &Value) -> Result<(), String> {
        let c = self.ensure(run)?;
        if !Self::current(run) {
            return Ok(());
        }
        let t = run.thread.upgrade().ok_or("Chat closed")?;
        let (instructions, cfg) = {
            let mut cfg = t.config.lock().unwrap();
            let instructions = cfg["instructions"].take();
            (instructions, cfg.clone())
        };
        let sid = t.session.lock().unwrap().clone();
        match run.provider.as_str() {
            "claude" => {
                let mut content = vec![];
                if !sid.is_empty() {
                    if let Some(i) = instructions.as_str().filter(|s| !s.is_empty()) {
                        content.push(json!({"type":"text","text":format!("<system-reminder>\n{i}\n</system-reminder>")}))
                    }
                }
                for img in arr(&msg["images"]) {
                    content.push(json!({"type":"image","source":{"type":"base64","media_type":img["mediaType"],"data":img["data"]}}))
                }
                if let Some(text) = msg["text"].as_str().filter(|s| !s.is_empty()) {
                    content.push(json!({"type":"text","text":text}))
                }
                let mut user = json!({"type":"user","message":{"role":"user","content":content},"parent_tool_use_id":null});
                for k in ["uuid", "priority"] {
                    if let Some(v) = msg.get(k) {
                        user[k] = v.clone();
                    }
                }
                c.write(&user)
            }
            "codex" => {
                let mut input = vec![];
                if !s(msg, "text").is_empty() {
                    input.push(json!({"type":"text","text":msg["text"],"text_elements":[]}));
                }
                for img in arr(&msg["images"]) {
                    input.push(json!({"type":"image","url":format!("data:{};base64,{}",s(img,"mediaType"),s(img,"data"))}));
                }
                if s(msg, "text").contains('$') {
                    let names = regex::Regex::new(r"(?:^|\s)\$([\w-]+)")
                        .unwrap()
                        .captures_iter(s(msg, "text"))
                        .map(|c| c[1].to_owned())
                        .collect::<HashSet<_>>();
                    if !names.is_empty() {
                        let catalog = c.request("skills/list", json!({"cwds":[cfg["cwd"]]}))?;
                        for root in arr(&catalog["data"]) {
                            for skill in arr(&root["skills"]) {
                                if skill["enabled"] != false && names.contains(s(skill, "name")) {
                                    input.push(json!({"type":"skill","name":skill["name"],"path":skill["path"]}));
                                }
                            }
                        }
                    }
                }
                if msg["priority"] == "next" {
                    for attempt in 0..2 {
                        let Some(turn) = run.codex.lock().unwrap().turn.clone() else {
                            break;
                        };
                        match c.request("turn/steer",json!({"threadId":sid,"input":input,"expectedTurnId":turn,"clientUserMessageId":msg["uuid"]})){
                            Ok(_)=>return Ok(()),
                            Err(error)=>{
                                let mut state=run.codex.lock().unwrap();
                                if state.turn.as_ref().is_some_and(|current|current!=&turn){if attempt==0{continue;}return Err("The active turn changed while sending; retry this message".into());}
                                if codex::no_active_turn(&error){state.retire_turn(&turn);state.turn=None;break;}
                                return Err(error);
                            }
                        }
                    }
                }
                let pol = policy(s(&cfg, "permissionMode"), &cfg);
                let model = self.codex_model(&c, s(&cfg, "model"));
                let effort = match s(&cfg, "effort") {
                    "max" => "xhigh",
                    e => e,
                };
                let mut p = json!({"threadId":sid,"input":input,"summary":"auto","approvalPolicy":pol["approvalPolicy"],"sandboxPolicy":pol["sandboxPolicy"],"collaborationMode":{"mode":if cfg["permissionMode"]=="plan"{"plan"}else{"default"},"settings":{"model":model.as_deref().unwrap_or(""),"reasoning_effort":if effort.is_empty(){Value::Null}else{json!(effort)},"developer_instructions":null}}});
                p["approvalsReviewer"] = json!(if cfg["permissionMode"] == "auto" {
                    "auto_review"
                } else {
                    "user"
                });
                if let Some(tier) = cfg["serviceTier"].as_str() {
                    p["serviceTier"] = json!(tier);
                }
                if let Some(model) = model {
                    p["model"] = json!(model)
                }
                if !effort.is_empty() {
                    p["effort"] = json!(effort)
                }
                if !arr(&cfg["dirs"]).is_empty() {
                    let mut roots = vec![cfg["cwd"].clone()];
                    roots.extend_from_slice(arr(&cfg["dirs"]));
                    p["runtimeWorkspaceRoots"] = json!(roots)
                }
                if let Some(id) = msg["uuid"].as_str() {
                    p["clientUserMessageId"] = json!(id);
                }
                let result = c.request("turn/start", p)?;
                let seeded = {
                    let mut state = run.codex.lock().unwrap();
                    let id = s(&result["turn"], "id");
                    if !id.is_empty() && !state.is_finished(id) && state.turn.is_none() {
                        state.turn = Some(id.into());
                        true
                    } else {
                        false
                    }
                };
                if msg["priority"] == "next" && msg["_wasRunning"] == true {
                    t.turn_sequence.fetch_add(1, Ordering::AcqRel);
                }
                if seeded {
                    self.emit_event(run, json!({"type":"step"}));
                }
                Ok(())
            }
            _ => {
                if !arr(&msg["images"]).is_empty() {
                    return Err("This CLI accepts text only; remove images".into());
                }
                let mut meta = if sid.is_empty() {
                    self.history
                        .create_journal(&run.provider, s(&cfg, "cwd"), s(msg, "text"))?
                } else {
                    self.history.journal_meta(&run.provider, &sid)?
                };
                let id = s(&meta, "sessionId").to_owned();
                self.emit_event(
                    run,
                    json!({"type":"session","sessionId":id,"model":cfg["model"]}),
                );

                let mut context = instructions.as_str().unwrap_or("").to_owned();
                if meta["rewound"] == true && s(&meta, "nativeId").is_empty() {
                    let own = self.history.handoff(&id, s(&cfg, "cwd"), &run.provider)?;
                    context = format!("{own}\n\n{context}");
                    meta = self.history.journal_patch(
                        &run.provider,
                        &id,
                        &json!({"rewound":false}),
                    )?;
                }
                let _ = meta;
                self.history.journal_append(&run.provider,&id,&json!({"type":"user","uuid":msg["uuid"].as_str().map(str::to_owned).unwrap_or(uuid::Uuid::new_v4().to_string()),"text":msg["text"],"timestamp":storage::now()}))?;
                *run.google.lock().unwrap() =
                    Some(live::Google::new(uuid::Uuid::new_v4().to_string()));
                let content = if context.is_empty() {
                    s(msg, "text").to_owned()
                } else {
                    format!("{context}\n\n{}", s(msg, "text"))
                };
                if run.provider == "antigravity" {
                    c.write(&json!({"event":"user","message":{"content":content}}))
                } else {
                    c.finish_input(format!("{content}\n").as_bytes())
                }
            }
        }
    }
    fn codex_model(&self, c: &Client, model: &str) -> Option<String> {
        if !model.is_empty() && model != "default" {
            return Some(model.into());
        }
        let config = c
            .request("config/read", json!({"includeLayers":false}))
            .unwrap_or(Value::Null);
        let configured = s(&config["config"], "model");
        if !configured.is_empty() {
            return Some(configured.into());
        }
        let list = c.request("model/list", json!({})).unwrap_or(Value::Null);
        arr(&list["data"])
            .iter()
            .find(|v| v["isDefault"] == true)
            .or(arr(&list["data"]).first())
            .map(|v| s(v, "id").into())
    }
    fn codex_server(self: &Arc<Self>) -> Result<Arc<Client>, String> {
        let mut guard = self.server.lock().unwrap();
        if let Some(c) = guard.as_ref().filter(|c| !c.closed.load(Ordering::Acquire)) {
            return Ok(c.clone());
        }
        let p = cli::subscription(&self.storage, "codex", cli::find(&self.storage, "codex")?)?;
        let weak = Arc::downgrade(self);
        let exit = weak.clone();
        let c = Client::spawn(
            &p,
            &[
                "app-server".into(),
                "-c".into(),
                "model_provider=\"openai\"".into(),
            ],
            &self.storage.home,
            Arc::new(move |c, msg| {
                if let Some(owner) = weak.upgrade() {
                    owner.codex_wire(c, msg)
                }
            }),
            Arc::new(move |error| {
                if let Some(owner) = exit.upgrade() {
                    let runs = owner
                        .routes
                        .lock()
                        .unwrap()
                        .values()
                        .filter_map(Weak::upgrade)
                        .collect::<Vec<_>>();
                    for run in runs {
                        owner.failed(&run, error.clone())
                    }
                }
            }),
        )?;
        c.request("initialize",json!({"clientInfo":{"name":"duet","title":"Duet","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true,"requestAttestation":false}}))?;
        c.write(&json!({"method":"initialized"}))?;
        let a = c.request("account/read", json!({"refreshToken":false}))?;
        if a["account"]["type"] != "chatgpt" {
            c.close();
            return Err("Sign in to Codex with your ChatGPT subscription".into());
        }
        *guard = Some(c.clone());
        Ok(c)
    }
    fn codex_wire(self: &Arc<Self>, c: Arc<Client>, msg: Value) {
        let method = s(&msg, "method");
        let p = &msg["params"];
        if matches!(
            method,
            "skills/changed"
                | "mcpServerStatus/updated"
                | "mcpServer/oauthLogin/completed"
                | "windowsSandbox/setupCompleted"
        ) {
            (self.emit)(
                "desk:codex-updated",
                json!({"kind":method,"success":p["success"],"error":p["error"]}),
            );
        }
        let sid = p["threadId"]
            .as_str()
            .or(p["thread"]["id"].as_str())
            .or(p["conversationId"].as_str())
            .unwrap_or("");
        let run = self.routes.lock().unwrap().get(sid).and_then(Weak::upgrade);
        if !msg["id"].is_null() {
            let weak = Arc::downgrade(self);
            let id = msg["id"].clone();
            let method = method.to_owned();
            let p = p.clone();
            let err_client = c.clone();
            let err_id = id.clone();
            if let Err(error) = self.spawn(move |_| {
                if let Some(owner) = weak.upgrade() {
                    let result = run
                        .ok_or("No active chat for this Codex thread".into())
                        .and_then(|run| owner.codex_request(&run, &method, &p, &id));
                    c.respond(id, result)
                }
            }) {
                err_client.respond(err_id, Err(error))
            }
            return;
        }
        if method == "account/rateLimits/updated" {
            if let Some(ev) = events::codex_limits(&p["rateLimits"]) {
                let runs = self
                    .routes
                    .lock()
                    .unwrap()
                    .values()
                    .filter_map(Weak::upgrade)
                    .collect::<Vec<_>>();
                let mut seen = HashSet::new();
                for run in runs {
                    if seen.insert(run.source.clone()) {
                        self.emit_event(&run, ev.clone())
                    }
                }
            }
            return;
        }
        if let Some(run) = run {
            if method == "item/started" && p["item"]["type"] == "fileChange"
                || method == "item/fileChange/patchUpdated"
            {
                let item = if method == "item/started" {
                    &p["item"]
                } else {
                    p
                };
                let id = if method == "item/started" {
                    s(item, "id")
                } else {
                    s(p, "itemId")
                };
                let changes = arr(&item["changes"]);
                if let Some(first) = changes.first() {
                    let input = json!({"file_path":first["path"],"kind":first["kind"]["type"].as_str().unwrap_or("update"),"diff":s(first,"diff").chars().take(65536).collect::<String>()});
                    let paths = changes
                        .iter()
                        .take(100)
                        .map(|c| s(c, "path"))
                        .collect::<Vec<_>>()
                        .join("\n");
                    let mut pending = run.patch_approvals.lock().unwrap();
                    if pending.len() >= 128 {
                        if let Some(key) = pending.keys().next().cloned() {
                            pending.remove(&key);
                        }
                    }
                    pending.insert(id.into(), json!({"input":input,"paths":paths}));
                }
            }
            if method == "item/completed" {
                run.patch_approvals
                    .lock()
                    .unwrap()
                    .remove(s(&p["item"], "id"));
            }
            if method == "turn/completed" {
                run.patch_approvals.lock().unwrap().clear();
            }
            if method == "serverRequest/resolved" {
                self.cancel(&run, Some(&format!("codex:{}", p["requestId"])));
                return;
            }
            let own = run
                .thread
                .upgrade()
                .map(|t| t.session.lock().unwrap().clone())
                .unwrap_or_default();
            let events = {
                let mut translator = run.codex.lock().unwrap();
                let events = translator.push(method, p, &own);
                let mut routes = self.routes.lock().unwrap();
                for child in translator.children.keys() {
                    routes
                        .entry(child.clone())
                        .or_insert_with(|| Arc::downgrade(&run));
                }
                events
            };
            let ended = events.iter().any(|ev| ev["type"] == "turn.end");
            for ev in events {
                self.emit_event(&run, ev)
            }
            if ended {
                run.manual_compact.store(false, Ordering::Release);
            }
            if (method == "thread/compacted"
                || (method == "item/completed" && p["item"]["type"] == "contextCompaction"))
                && run.codex.lock().unwrap().turn.is_none()
                && run.manual_compact.swap(false, Ordering::AcqRel)
            {
                self.emit_event(&run, json!({"type":"turn.end","text":"","isError":false}));
            }
        }
    }
    fn claude_wire(self: &Arc<Self>, run: &Arc<Run>, c: Arc<Client>, msg: Value) {
        if !Self::current(run) {
            return;
        }
        if msg["type"] == "control_request" {
            let owner = self.clone();
            let r = run.clone();
            let id = msg["request_id"].clone();
            let req = msg["request"].clone();
            let ec = c.clone();
            let ei = id.clone();
            if let Err(e) = self.spawn(move |_| {
                let result = owner.claude_request(&r, &req, &id);
                c.control_response(id, result)
            }) {
                ec.control_response(ei, Err(e))
            }
            return;
        }
        if msg["type"] == "control_cancel_request" {
            self.cancel(run, Some(&format!("claude:{}", msg["request_id"])));
            return;
        }
        if msg["type"] == "result" && msg["parent_tool_use_id"].is_null() {
            let _ = self.record_turn(run, &msg);
        }
        match self.state(&run.source, |state| {
            run.claude.lock().unwrap().push(&msg, state)
        }) {
            Ok(events) => {
                for ev in events {
                    self.emit_event(run, ev)
                }
            }
            Err(e) => self.failed(run, e),
        }
    }
    fn ask(&self, run: &Arc<Run>, source: String, mut req: Value) -> Value {
        if !Self::current(run) {
            return json!({"decision":"deny","message":"Run closed"});
        }
        let Some(t) = run.thread.upgrade() else {
            return json!({"decision":"deny"});
        };
        if t.hidden {
            return json!({"decision":"deny","message":"No user is available to approve this background operation"});
        }
        let thread = self.family_root(&t).id.clone();
        if let Some(sub) = &t.sub {
            req["agentID"] = json!(sub.tool)
        }
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = mpsc::sync_channel(1);
        {
            let mut pending = self.approvals.lock().unwrap();
            if !Self::current(run) {
                return json!({"decision":"deny","message":"Run closed"});
            }
            if pending.len() >= 128 {
                return json!({"decision":"deny","message":"Too many pending permission requests"});
            }
            pending.insert(
                id.clone(),
                Approval {
                    thread: thread.clone(),
                    run: Arc::downgrade(run),
                    source: source.clone(),
                    tx,
                },
            );
        }
        req["threadId"] = json!(thread);
        req["reqId"] = json!(id);
        req["provider"] = json!(run.provider);
        self.team_record(&t, json!({"type":"permission.requested","request":req}));
        (self.emit)("agent:permission", req);
        let already_cancelled = run
            .requests
            .lock()
            .unwrap()
            .get(&source)
            .is_some_and(|token| token.load(Ordering::Acquire));
        if already_cancelled {
            self.cancel(run, Some(&source));
        }
        let result = rx
            .recv_timeout(Duration::from_secs(24 * 3600))
            .unwrap_or(json!({"decision":"deny","message":"Permission request expired"}));
        self.approvals.lock().unwrap().remove(&id);
        self.team_record(
            &t,
            json!({"type":"permission.resolved","reqId":id,"decision":result["decision"]}),
        );
        (self.emit)(
            "agent:permission-cancel",
            json!({"threadId":thread,"reqId":id}),
        );
        result
    }
    fn cancel(&self, run: &Arc<Run>, source: Option<&str>) {
        if let Some(source) = source {
            let mut cancelled = run.cancelled_requests.lock().unwrap();
            if cancelled.len() < 256 && source.len() < 512 {
                cancelled.insert(source.to_owned());
            }
        }
        for (id, token) in run.requests.lock().unwrap().iter() {
            if source.is_none_or(|source| source == id) {
                token.store(true, Ordering::Release);
            }
        }
        self.collaboration.wake();
        let mut pending = self.approvals.lock().unwrap();
        let ids = pending
            .iter()
            .filter(|(_, p)| {
                p.run.upgrade().is_some_and(|r| Arc::ptr_eq(&r, run))
                    && source.is_none_or(|s| {
                        s == p.source
                            || run
                                .requests
                                .lock()
                                .unwrap()
                                .get(&p.source)
                                .is_some_and(|token| token.load(Ordering::Acquire))
                    })
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in ids {
            if let Some(p) = pending.remove(&id) {
                let _ = p.tx.send(json!({"decision":"deny","message":"Cancelled"}));
                (self.emit)(
                    "agent:permission-cancel",
                    json!({"threadId":p.thread,"reqId":id}),
                );
            }
        }
    }
    fn claude_request(self: &Arc<Self>, run: &Arc<Run>, req: &Value, id: &Value) -> CoreResult {
        let mut aliases = vec![format!("claude:{id}")];
        if req["subtype"] == "mcp_message" && !req["message"]["id"].is_null() {
            aliases.push(format!("mcp:{}", req["message"]["id"]));
        }
        let request = collaboration::Request::new(run, aliases);
        match s(req, "subtype") {
            "can_use_tool" => {
                let mut ask = json!({"toolName":req["tool_name"],"input":req["input"],"toolUseID":req["tool_use_id"],"agentID":req["agent_id"],"title":req["title"],"displayName":req["display_name"],"description":req["description"],"decisionReason":req["decision_reason"],"blockedPath":req["blocked_path"],"canAlways":req["suppress_always_allow_rule"]!=true&&!arr(&req["permission_suggestions"]).is_empty()});
                let r = self.ask(run, format!("claude:{id}"), ask.take());
                if r["decision"] == "deny" {
                    Ok(
                        json!({"behavior":"deny","message":r["message"].as_str().unwrap_or("The user declined this action.")}),
                    )
                } else {
                    let mut reply = json!({"behavior":"allow","updatedInput":r.get("updatedInput").filter(|v|!v.is_null()).unwrap_or(&req["input"])});
                    if r["decision"] == "always" {
                        reply["updatedPermissions"] = req["permission_suggestions"].clone()
                    }
                    Ok(reply)
                }
            }
            "mcp_message" => {
                let message = &req["message"];
                let result: CoreResult = match s(message, "method") {
                    "initialize" => Ok(
                        json!({"protocolVersion":message["params"]["protocolVersion"].as_str().unwrap_or("2024-11-05"),"capabilities":{"tools":{}},"serverInfo":{"name":req["server_name"],"version":"1.0.0"}}),
                    ),
                    "tools/list" => {
                        let depth = run
                            .thread
                            .upgrade()
                            .and_then(|t| t.sub.as_ref().map(|s| s.depth))
                            .unwrap_or(0);
                        let tools = toolsets::all(depth)
                            .into_iter()
                            .find(|v| v["name"] == req["server_name"])
                            .map(|v| v["tools"].clone())
                            .unwrap_or(json!([]));
                        Ok(json!({"tools":tools}))
                    }
                    "tools/call" => {
                        let params = &message["params"];
                        Ok(self
                            .tool(
                                run,
                                s(req, "server_name"),
                                s(params, "name"),
                                &params["arguments"],
                                params["_meta"]["claudecode/toolUseId"]
                                    .as_str()
                                    .unwrap_or(""),
                                &request.cancelled,
                            )
                            .unwrap_or_else(|error| toolsets::text(error, true)))
                    }
                    "notifications/cancelled" => {
                        self.cancel(
                            run,
                            Some(&format!("mcp:{}", message["params"]["requestId"])),
                        );
                        Ok(json!({}))
                    }
                    "notifications/initialized" | "ping" => Ok(json!({})),
                    _ => Err("Unsupported MCP method".into()),
                };
                let response = if message["id"].is_null() {
                    Value::Null
                } else {
                    match result {
                        Ok(result) => json!({"jsonrpc":"2.0","id":message["id"],"result":result}),
                        Err(error) => {
                            json!({"jsonrpc":"2.0","id":message["id"],"error":{"code":-32601,"message":error}})
                        }
                    }
                };
                Ok(json!({"mcp_response":response}))
            }
            "elicitation" => Ok(json!({"action":"decline"})),
            _ => Err(format!(
                "Unsupported Claude control request {}",
                s(req, "subtype")
            )),
        }
    }
    fn codex_request(
        self: &Arc<Self>,
        run: &Arc<Run>,
        method: &str,
        p: &Value,
        id: &Value,
    ) -> CoreResult {
        let request = collaboration::Request::new(run, vec![format!("codex:{id}")]);
        let t = run.thread.upgrade().ok_or("Chat closed")?;
        let cfg = t.config.lock().unwrap().clone();
        let mode = s(&cfg, "permissionMode");
        let source = format!("codex:{id}");
        match method {
            "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
                let file = method.contains("fileChange");
                if mode == "bypassPermissions" || (file && mode == "acceptEdits") {
                    return Ok(json!({"decision":"accept"}));
                }
                let command = arr(&p["commandActions"])
                    .iter()
                    .map(|v| s(v, "command"))
                    .collect::<Vec<_>>()
                    .join(" && ");
                let patch = run
                    .patch_approvals
                    .lock()
                    .unwrap()
                    .get(s(p, "itemId"))
                    .cloned()
                    .unwrap_or(Value::Null);
                let input = if file {
                    patch
                        .get("input")
                        .cloned()
                        .unwrap_or(json!({"file_path":p["grantRoot"]}))
                } else {
                    json!({"command":if command.is_empty(){s(p,"command")}else{&command},"description":p["reason"]})
                };
                let description = [s(p, "reason"), s(&patch, "paths")]
                    .into_iter()
                    .filter(|v| !v.is_empty())
                    .collect::<Vec<_>>()
                    .join("\n");
                let req = json!({"toolName":if file{"Patch"}else{"Bash"},"input":input,"toolUseID":p["itemId"],"description":description,"canAlways":true});
                let r = self.ask(run, source, req);
                Ok(
                    json!({"decision":match s(&r,"decision"){"always"=>"acceptForSession","allow"=>"accept",_=>"decline"}}),
                )
            }
            "item/tool/call" => {
                let result = self
                    .tool(
                        run,
                        s(p, "namespace"),
                        s(p, "tool"),
                        &p["arguments"],
                        s(p, "callId"),
                        &request.cancelled,
                    )
                    .unwrap_or_else(|e| toolsets::text(e, true));
                Ok(toolsets::dynamic(&result))
            }
            "item/tool/requestUserInput" => {
                let r=self.ask(run,source,json!({"toolName":"AskUserQuestion","input":{"questions":codex::questions(p)},"toolUseID":p["itemId"],"canAlways":false}));
                Ok(codex::answers(p, &r))
            }
            "item/permissions/requestApproval" => {
                let reply=self.ask(run,source,json!({"toolName":"CodexPermissions","input":{"permissions":p["permissions"],"cwd":p["cwd"]},"description":p["reason"],"toolUseID":p["itemId"],"canAlways":true}));
                Ok(codex::permissions(p, &reply))
            }
            "execCommandApproval" | "applyPatchApproval" => {
                let edit = method == "applyPatchApproval";
                let reply = if mode == "bypassPermissions" || (edit && mode == "acceptEdits") {
                    json!({"decision":"allow"})
                } else {
                    let command = arr(&p["command"])
                        .iter()
                        .map(|v| v.as_str().unwrap_or(""))
                        .collect::<Vec<_>>()
                        .join(" ");
                    let input = if edit {
                        p["fileChanges"].as_object().and_then(|m|m.iter().next()).map(|(path,c)|json!({"file_path":path,"diff":c.get("unified_diff").or(c.get("diff")).or(c.get("content")).cloned().unwrap_or(Value::Null)})).unwrap_or(json!({}))
                    } else {
                        json!({"command":command,"cwd":p["cwd"]})
                    };
                    self.ask(run,source,json!({"toolName":if edit{"Patch"}else{"Bash"},"input":input,"toolUseID":p["callId"],"description":p["reason"],"canAlways":true}))
                };
                Ok(
                    json!({"decision":match s(&reply,"decision"){"always"=>json!("approved_for_session"),"allow"=>json!("approved"),_=>json!({"denied":{"rejection":reply["message"].as_str().unwrap_or("User declined")}})}}),
                )
            }
            "mcpServer/elicitation/request" => {
                let reply=self.ask(run,source,json!({"toolName":"CodexMcpForm","input":p,"description":p["message"],"canAlways":false}));
                let accepted = reply["decision"] == "allow";
                let content = if accepted && p["mode"] != "url" {
                    let value = reply["updatedInput"]["content"].clone();
                    codex::validate_form(&p["requestedSchema"], &value)?;
                    value
                } else {
                    Value::Null
                };
                Ok(
                    json!({"action":if accepted{"accept"}else if reply["updatedInput"]["cancel"]==true{"cancel"}else{"decline"},"content":content,"_meta":null}),
                )
            }
            _ => Err(format!("Unsupported Codex request {method}")),
        }
    }
    fn google_launch(
        self: &Arc<Self>,
        run: &Arc<Run>,
        cfg: &Value,
        cwd: &Path,
        resume: &str,
    ) -> Result<Arc<Client>, String> {
        let program = cli::subscription(
            &self.storage,
            &run.provider,
            cli::find(&self.storage, &run.provider)?,
        )?;
        let agy = run.provider == "antigravity";
        let meta = if resume.is_empty() {
            Value::Null
        } else {
            self.history.journal_meta(&run.provider, resume)?
        };
        let native = s(&meta, "nativeId");
        let mut args = if agy {
            vec![
                "--input-format".into(),
                "stream-json".into(),
                "--output-format".into(),
                "stream-json".into(),
                "--disable-slash-commands".into(),
            ]
        } else {
            vec![
                "--output-format".into(),
                "stream-json".into(),
                "--skip-trust".into(),
            ]
        };
        if !native.is_empty() {
            args.extend([
                if agy { "--conversation" } else { "--resume" }.into(),
                native.into(),
            ]);
        }
        let model = s(cfg, "model");
        if !model.is_empty() && model != "default" {
            args.extend(["--model".into(), model.into()])
        }
        let effort = s(cfg, "effort");
        if agy && matches!(effort, "low" | "medium" | "high" | "xhigh" | "max") {
            args.extend(["--effort".into(), effort.into()])
        }
        let mode = s(cfg, "permissionMode");
        if agy {
            match mode {
                "bypassPermissions" => args.push("--dangerously-skip-permissions".into()),
                "plan" | "auto" => args.extend(["--mode".into(), mode.into()]),
                "acceptEdits" => args.extend(["--mode".into(), "accept-edits".into()]),
                _ => {}
            }
        } else {
            args.extend([
                "--approval-mode".into(),
                match mode {
                    "bypassPermissions" => "yolo",
                    "plan" => "plan",
                    "auto" | "acceptEdits" => "auto_edit",
                    _ => "default",
                }
                .into(),
            ])
        }
        for dir in arr(&cfg["dirs"]).iter().filter_map(Value::as_str) {
            args.extend([
                if agy {
                    "--add-dir"
                } else {
                    "--include-directories"
                }
                .into(),
                dir.into(),
            ])
        }
        if !agy {
            args.extend(["-p".into(), "".into()])
        }
        let weak = Arc::downgrade(self);
        let wr = Arc::downgrade(run);
        let ex = weak.clone();
        let er = wr.clone();
        let c = Client::spawn(
            &program,
            &args,
            cwd,
            Arc::new(move |c, msg| {
                if let (Some(owner), Some(run)) = (weak.upgrade(), wr.upgrade()) {
                    if !Self::current(&run) {
                        return;
                    }
                    let Some(t) = run.thread.upgrade() else {
                        return;
                    };
                    let sid = t.session.lock().unwrap().clone();
                    let native = msg["conversation_id"]
                        .as_str()
                        .or(msg["session_id"].as_str())
                        .or(msg["result"]["conversation_id"].as_str())
                        .or(msg["step_update"]["conversation_id"].as_str())
                        .or(msg["result"]["session_id"].as_str());
                    if let Some(native) = native {
                        if !sid.is_empty() {
                            if let Err(e) = owner.history.journal_patch(
                                &run.provider,
                                &sid,
                                &json!({"nativeId":native}),
                            ) {
                                owner.failed(&run, e);
                                return;
                            }
                        }
                    }
                    let events = run
                        .google
                        .lock()
                        .unwrap()
                        .as_mut()
                        .map(|tr| tr.push(&msg, &run.provider))
                        .unwrap_or_default();
                    if events.iter().any(|ev| ev["type"] == "turn.end") {
                        *run.google.lock().unwrap() = None;
                    }
                    for mut ev in events {
                        let end = ev["type"] == "turn.end";
                        if end {
                            ev["durationMs"] =
                                json!(storage::now()
                                    .saturating_sub(run.started.load(Ordering::Relaxed)));
                            let _ = owner.history.journal_patch(
                                &run.provider,
                                &sid,
                                &json!({"lastModified":storage::now()}),
                            );
                        }
                        owner.emit_event(&run, ev);
                        if end {
                            let c = c.clone();
                            std::thread::spawn(move || c.close());
                        }
                    }
                }
            }),
            Arc::new(move |error| {
                if let (Some(owner), Some(run)) = (ex.upgrade(), er.upgrade()) {
                    if run.running.load(Ordering::Acquire) {
                        owner.failed(&run, error)
                    }
                }
            }),
        )?;
        *run.client.lock().unwrap() = Some(c.clone());
        Ok(c)
    }
    fn record_turn(&self, run: &Arc<Run>, msg: &Value) -> Result<(), String> {
        let models=msg["modelUsage"].as_object().into_iter().flatten().map(|(name,u)|json!({"model":name,"input":u["inputTokens"].as_u64().unwrap_or(0),"output":u["outputTokens"].as_u64().unwrap_or(0),"cacheRead":u["cacheReadInputTokens"].as_u64().unwrap_or(0),"cacheWrite":u["cacheCreationInputTokens"].as_u64().unwrap_or(0),"cost":u["costUSD"].as_f64().unwrap_or(0.)})).collect::<Vec<_>>();
        let cwd = run
            .thread
            .upgrade()
            .map(|t| t.config.lock().unwrap()["cwd"].clone())
            .unwrap_or(Value::Null);
        let record = json!({"ts":storage::now(),"sessionId":msg["session_id"],"cwd":cwd,"durationMs":msg["duration_ms"],"turns":msg["num_turns"],"cost":msg["total_cost_usd"],"error":msg["is_error"]==true,"models":models});
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.storage.data.join("stats-turns.jsonl"))
            .map_err(|e| e.to_string())?;
        writeln!(f, "{record}").map_err(|e| e.to_string())
    }
    pub fn usage(self: &Arc<Self>, provider: &str) -> CoreResult {
        cli::require_enabled(provider)?;
        match provider {
            "codex" => {
                let r = self
                    .codex_server()?
                    .request("account/rateLimits/read", json!({}))?;
                let mut ev = events::codex_limits(&r["rateLimits"]).unwrap_or(json!({}));
                ev["plan"] = r["rateLimits"]["planType"].clone();
                ev.as_object_mut().unwrap().remove("type");
                Ok(ev)
            }
            "claude" => self
                .claude_control(json!({"subtype":"get_usage","skip_behaviors":true}))
                .map(|v| claude_limits(&v)),
            "antigravity" | "gemini" => cli::google_usage(&self.storage, provider),
            _ => Err("Unknown provider".into()),
        }
    }
    fn claude_control(self: &Arc<Self>, request: Value) -> CoreResult {
        let live = self
            .threads
            .lock()
            .unwrap()
            .values()
            .filter_map(|t| t.run.lock().unwrap().clone())
            .find(|r| {
                r.provider == "claude"
                    && r.alive.load(Ordering::Acquire)
                    && r.client.lock().unwrap().is_some()
            });
        if let Some(run) = live {
            let client = run.client.lock().unwrap().clone().unwrap();
            return client.control(request);
        }
        let program =
            cli::subscription(&self.storage, "claude", cli::find(&self.storage, "claude")?)?;
        let mut args = vec![
            "--output-format".into(),
            "stream-json".into(),
            "--verbose".into(),
            "--input-format".into(),
            "stream-json".into(),
        ];
        if !matches!(s(&request, "subtype"), "mcp_status" | "mcp_reconnect") {
            args.push("--strict-mcp-config".into());
        }
        let c = Client::spawn(
            &program,
            &args,
            &self.storage.home,
            Arc::new(|c, m| {
                if m["type"] == "control_request" {
                    c.control_response(m["request_id"].clone(), Err("No interactive chat".into()))
                }
            }),
            Arc::new(|_| {}),
        )?;
        let result = (|| {
            let init = c.control(json!({"subtype":"initialize"}))?;
            validate_claude_account(&init["account"])?;
            if request["subtype"] == "initialize" {
                Ok(init)
            } else {
                c.control(request)
            }
        })();
        c.close();
        result
    }
    pub fn probe(self: &Arc<Self>, force: bool) -> CoreResult {
        if !force {
            if let Some((ts, v)) = &*self.probe.lock().unwrap() {
                if storage::now() - ts < 60000 {
                    return Ok(v.clone());
                }
            }
        }
        let mut providers = json!({});
        std::thread::scope(|scope| {
            let tasks = cli::ENABLED.map(|id| (id, scope.spawn(move || self.probe_one(id))));
            for (id, task) in tasks {
                let mut value = task
                    .join()
                    .unwrap_or(Err("Provider probe failed".into()))
                    .unwrap_or_else(|e| json!({"available":false,"error":e,"models":[]}));
                value["label"] = json!(cli::label(id));
                value["brand"] = cli::brand(id);
                value["caps"] = cli::caps(id);
                providers[id] = value;
            }
        });
        let mut result = providers["claude"].clone();
        result["providers"] = providers;
        *self.probe.lock().unwrap() = Some((storage::now(), result.clone()));
        Ok(result)
    }
    fn probe_one(self: &Arc<Self>, id: &str) -> CoreResult {
        match id {
            "claude" => {
                let init = self.claude_control(json!({"subtype":"initialize"}))?;
                Ok(
                    json!({"available":true,"version":init["claude_code_version"],"models":init["models"],"account":init["account"],"commands":init["commands"],"usage":self.usage("claude").unwrap_or(Value::Null)}),
                )
            }
            "codex" => {
                let c = self.codex_server()?;
                let account = c.request("account/read", json!({"refreshToken":false}))?;
                let mut catalog = Vec::new();
                let mut cursor = Value::Null;
                for _ in 0..20 {
                    let page = c.request("model/list", json!({"cursor":cursor,"limit":100}))?;
                    catalog.extend(arr(&page["data"]).iter().cloned());
                    let next = page["nextCursor"].clone();
                    if next.is_null() || next == cursor {
                        break;
                    }
                    cursor = next;
                }
                let models = json!({"data":catalog});
                let mut list = vec![
                    json!({"value":"default","displayName":"Default","description":"Codex config","supportedEffortLevels":["low","medium","high","xhigh"]}),
                ];
                for m in arr(&models["data"]).iter().filter(|m| m["hidden"] != true) {
                    list.push(json!({"value":m["id"],"displayName":m.get("displayName").unwrap_or(&m["id"]),"description":m["description"],"serviceTiers":m["serviceTiers"],"defaultServiceTier":m["defaultServiceTier"],"supportedEffortLevels":arr(&m["supportedReasoningEfforts"]).iter().filter_map(|v|v.get("reasoningEffort").or(v.get("effort"))).collect::<Vec<_>>()}))
                }
                let resolved = self.codex_model(&c, "default").unwrap_or_default();
                if let Some(model) = list
                    .iter()
                    .skip(1)
                    .find(|m| m["value"] == resolved)
                    .cloned()
                {
                    for key in [
                        "serviceTiers",
                        "defaultServiceTier",
                        "supportedEffortLevels",
                    ] {
                        list[0][key] = model[key].clone();
                    }
                }
                Ok(
                    json!({"available":true,"loggedIn":account["account"]["type"]=="chatgpt","account":{"email":account["account"]["email"],"subscriptionType":account["account"]["planType"]},"models":list,"commands":[{"name":"compact","description":"Compact context"},{"name":"review","description":"Review changes"},{"name":"status","description":"Chat status and controls"},{"name":"mcp","description":"MCP servers"},{"name":"skills","description":"Skills"},{"name":"goal","description":"Goal"},{"name":"model","description":"Select model"},{"name":"permissions","description":"Permissions"},{"name":"diff","description":"Changes"},{"name":"fork","description":"Fork conversation"},{"name":"new","description":"New Codex chat"},{"name":"help","description":"Codex controls"}],"usage":self.usage(id).unwrap_or(Value::Null)}),
                )
            }
            _ => cli::google_probe(&self.storage, id),
        }
    }
    pub fn quick(
        self: &Arc<Self>,
        prompt: &str,
        system: &str,
        timeout: Duration,
    ) -> Result<String, String> {
        let result=self.headless(&json!({"provider":"claude","prompt":prompt,"model":"haiku","instructions":system,"permissionMode":"default","oneshot":true}),timeout)?;
        if result["isError"] == true {
            return Err(result["error"]
                .as_str()
                .unwrap_or("Completion failed")
                .into());
        }
        Ok(s(&result, "text").trim().into())
    }
    pub fn headless(self: &Arc<Self>, spec: &Value, timeout: Duration) -> CoreResult {
        let id = format!("headless-{}", uuid::Uuid::new_v4());
        let provider = spec["provider"].as_str().unwrap_or("claude");
        cli::require_enabled(provider)?;
        let t = Arc::new(Thread {
            id: id.clone(),
            provider: Mutex::new(provider.into()),
            config: Mutex::new(spec.clone()),
            session: Mutex::new(s(spec, "resume").into()),
            resume_at: Mutex::new(None),
            run: Mutex::new(None),
            lifecycle: Mutex::new(()),
            sub: None,
            hidden: true,
            result: Mutex::new(Value::Null),
            wake: Condvar::new(),
            inbox: Mutex::new(Default::default()),
            delivering: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            mailbox_paused: AtomicBool::new(false),
            turn_sequence: AtomicU64::new(0),
            event_cursor: AtomicU64::new(0),
        });
        self.threads.lock().unwrap().insert(id.clone(), t.clone());
        let mut payload = spec.clone();
        payload["threadId"] = json!(id);
        payload["text"] = spec["prompt"].clone();
        let result = (|| {
            self.send(&payload)?;
            let g = t.result.lock().unwrap();
            let (g, wait) = t
                .wake
                .wait_timeout_while(g, timeout, |v| v.is_null())
                .unwrap();
            if wait.timed_out() {
                return Err("Background task timed out".into());
            }
            let mut result = g.clone();
            result["sessionId"] = json!(t.session.lock().unwrap().clone());
            Ok(result)
        })();
        self.close_thread(&id);
        result
    }
    fn children(&self, id: &str) -> Vec<Arc<Thread>> {
        self.threads
            .lock()
            .unwrap()
            .values()
            .filter(|t| t.sub.as_ref().is_some_and(|s| s.parent == id))
            .cloned()
            .collect()
    }
    fn close_thread(&self, id: &str) {
        if let Some(t) = self.find(id) {
            t.closed.store(true, Ordering::Release);
            t.mailbox_paused.store(true, Ordering::Release);
            t.inbox.lock().unwrap().clear();
        }
        for t in self.children(id) {
            self.close_thread(&t.id);
        }
        if let Some(t) = self.find(id) {
            let r = t.run.lock().unwrap().clone();
            if let Some(run) = r {
                self.stop_run(&run)
            }
        }
        self.threads.lock().unwrap().remove(id);
        self.collaboration.wake();
    }
    pub fn shutdown(&self) {
        self.closing.store(true, Ordering::Release);
        let ids = self
            .threads
            .lock()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for id in ids {
            self.close_thread(&id)
        }
        if let Some(c) = self.server.lock().unwrap().take() {
            c.close();
        }
    }
    pub fn maintain(&self) {
        let mailboxes = self
            .threads
            .lock()
            .unwrap()
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for t in mailboxes {
            self.schedule_inbox(&t);
        }
        let minutes = self.storage.ui()["idleAgentMinutes"].as_f64().unwrap_or(5.);
        if minutes <= 0. {
            return;
        }
        let now = storage::now();
        let threads = self
            .threads
            .lock()
            .unwrap()
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for t in threads {
            let run = t.run.lock().unwrap().clone();
            if let Some(run) = run {
                if !run.running.load(Ordering::Acquire)
                    && run.background.lock().unwrap().is_empty()
                    && now.saturating_sub(run.last.load(Ordering::Relaxed))
                        > (if t.sub.is_some() {
                            (minutes * 60000.).min(30000.)
                        } else {
                            minutes * 60000.
                        }) as u64
                    && !self
                        .approvals
                        .lock()
                        .unwrap()
                        .values()
                        .any(|a| a.run.upgrade().is_some_and(|r| Arc::ptr_eq(&r, &run)))
                    && !self.children(&t.id).iter().any(|c| {
                        c.run.lock().unwrap().as_ref().is_some_and(|r| {
                            r.running.load(Ordering::Acquire)
                                || !r.background.lock().unwrap().is_empty()
                        })
                    })
                {
                    self.stop_run(&run)
                }
            }
        }
    }
    fn tool(
        self: &Arc<Self>,
        run: &Arc<Run>,
        set: &str,
        name: &str,
        args: &Value,
        tool_id: &str,
        cancelled: &Arc<AtomicBool>,
    ) -> CoreResult {
        let t = run.thread.upgrade().ok_or("Chat closed")?;
        let depth = t.sub.as_ref().map(|s| s.depth).unwrap_or(0);
        let sets = toolsets::all(depth);
        let definition = sets
            .iter()
            .find(|v| v["name"] == set)
            .and_then(|v| arr(&v["tools"]).iter().find(|v| v["name"] == name))
            .ok_or("Unknown desk tool")?;
        for key in arr(&definition["inputSchema"]["required"])
            .iter()
            .filter_map(Value::as_str)
        {
            if args[key].is_null() {
                return Ok(toolsets::text(format!("Missing input {key}"), true));
            }
        }
        if let Some(properties) = definition["inputSchema"]["properties"].as_object() {
            if let Some(input) = args.as_object() {
                for (key, value) in input {
                    let schema = properties
                        .get(key)
                        .ok_or_else(|| format!("Unknown input {key}"))?;
                    let valid = match s(schema, "type") {
                        "string" => value.is_string(),
                        "boolean" => value.is_boolean(),
                        "number" => value.is_number(),
                        "integer" => value.is_i64() || value.is_u64(),
                        "array" => value.is_array(),
                        "object" => value.is_object(),
                        _ => true,
                    };
                    if !valid
                        || (!arr(&schema["enum"]).is_empty()
                            && !arr(&schema["enum"]).contains(value))
                    {
                        return Ok(toolsets::text(format!("Invalid input {key}"), true));
                    }
                }
            } else {
                return Ok(toolsets::text("Expected an input object", true));
            }
        }
        if let Err(error) = codex::validate_form(&definition["inputSchema"], args) {
            return Ok(toolsets::text(format!("Invalid input: {error}"), true));
        }

        match set {
            "ccd_session" => Ok(toolsets::text(
                match name {
                    "mark_chapter" => {
                        format!("Chapter marked: {}. Continue your work.", s(args, "title"))
                    }
                    "spawn_task" => format!(
                        "task_id: task_{} — suggestion shown to the user.",
                        uuid::Uuid::new_v4()
                    ),
                    "dismiss_task" => format!("Dismissed {}.", s(args, "task_id")),
                    _ => return Err("Unknown session tool".into()),
                },
                false,
            )),
            "desk-browser" => {
                let mut p = args.clone();
                p["threadId"] = json!(t.id);
                p["action"] = json!(name);
                let v = self.host("browser.tool", p)?;
                Ok(if v["content"].is_array() {
                    v
                } else {
                    toolsets::text(events::result_text(&v), false)
                })
            }
            "desk-agents" => self.team_tool(run, name, args, tool_id, cancelled),
            _ => Err("Unknown toolset".into()),
        }
    }
    fn codex_action(self: &Arc<Self>, p: &Value) -> CoreResult {
        let action = s(p, "action");
        if action == "validate-form" {
            codex::validate_form(&p["schema"], &p["content"])?;
            return Ok(json!({"valid":true}));
        }
        if !matches!(
            action,
            "skills"
                | "apps"
                | "hooks"
                | "skill/config"
                | "mcp"
                | "mcp/reload"
                | "mcp/login"
                | "goal/get"
                | "goal/set"
                | "goal/clear"
                | "compact"
                | "review"
                | "windowsSandbox/setup"
        ) {
            return Err(format!("Unsupported Codex action {action}"));
        }
        let server = self.codex_server()?;
        if action == "windowsSandbox/setup" {
            if !cfg!(windows) {
                return Err("Windows sandbox setup is available only on Windows".into());
            }
            return server.request(
                "windowsSandbox/setupStart",
                json!({"mode":"unelevated","cwd":p["cwd"].as_str().filter(|s|!s.is_empty())}),
            );
        }
        if action == "apps" {
            return server.request("app/list",json!({"threadId":p["sessionId"],"cursor":p["cursor"],"limit":50,"forceRefetch":p["force"]==true}));
        }
        if action == "hooks" {
            return server.request("hooks/list",json!({"cwds":[p["cwd"].as_str().unwrap_or(self.storage.home.to_str().unwrap_or(""))]}));
        }
        if action == "skill/config" {
            let file = s(p, "path");
            if file.is_empty() || !p["enabled"].is_boolean() {
                return Err("Invalid skill selector".into());
            }
            return server.request(
                "skills/config/write",
                json!({"path":file,"enabled":p["enabled"]}),
            );
        }
        if action == "skills" {
            return server.request("skills/list",json!({"cwds":[p["cwd"].as_str().unwrap_or(self.storage.home.to_str().unwrap_or(""))],"forceReload":p["force"]==true}));
        }
        if action == "mcp/reload" {
            return server.request("config/mcpServer/reload", json!({}));
        }
        if action == "mcp/login" {
            let name = s(p, "name");
            if name.is_empty() || name.len() > 256 {
                return Err("Invalid MCP server name".into());
            }
            return server.request("mcpServer/oauth/login", json!({"name":name}));
        }
        if matches!(action, "goal/get" | "mcp")
            && p["sessionId"].as_str().unwrap_or("").is_empty()
            && self.find(s(p, "threadId")).is_none()
        {
            return if action == "goal/get" {
                Ok(json!({"goal":null}))
            } else {
                server.request(
                    "mcpServerStatus/list",
                    json!({"cursor":p["cursor"],"limit":50}),
                )
            };
        }
        let t = self.thread(s(p, "threadId"), "codex")?;
        if *t.provider.lock().unwrap() != "codex" {
            return Err("This chat is using another provider".into());
        }
        {
            let mut cfg = t.config.lock().unwrap();
            for key in ["cwd", "model", "effort", "permissionMode", "serviceTier"] {
                if let Some(v) = p["config"].get(key) {
                    cfg[key] = v.clone();
                }
            }
        }
        if t.session.lock().unwrap().is_empty() {
            if let Some(sid) = p["sessionId"].as_str() {
                *t.session.lock().unwrap() = sid.into();
            }
        }
        let run = self.start(&t);
        let _lock = run.operation.lock().unwrap();
        let c = self.ensure(&run)?;
        let sid = t.session.lock().unwrap().clone();
        match action {
            "mcp" => c.request(
                "mcpServerStatus/list",
                json!({"threadId":sid,"cursor":p["cursor"],"limit":50}),
            ),
            "goal/get" => c.request("thread/goal/get", json!({"threadId":sid})),
            "goal/clear" => c.request("thread/goal/clear", json!({"threadId":sid,"origin":"user"})),
            "goal/set" => {
                let mut params = json!({"threadId":sid,"origin":"user"});
                if let Some(objective) = p["objective"].as_str() {
                    if objective.trim().is_empty() || objective.len() > 24000 {
                        return Err("Goal objective is empty or too long".into());
                    }
                    params["objective"] = json!(objective);
                }
                if let Some(status) = p["status"].as_str() {
                    if !matches!(status, "active" | "paused" | "complete") {
                        return Err("Invalid goal status".into());
                    }
                    params["status"] = json!(status);
                }
                if let Some(budget) = p["tokenBudget"].as_u64() {
                    if budget == 0 || budget > 100_000_000 {
                        return Err("Invalid goal token budget".into());
                    }
                    params["tokenBudget"] = json!(budget);
                }
                c.request("thread/goal/set", params)
            }
            "review" | "compact" => {
                if run.running.swap(true, Ordering::AcqRel) {
                    return Err("Chat is busy".into());
                }
                let result = if action == "compact" {
                    run.manual_compact.store(true, Ordering::Release);
                    self.emit_event(&run, json!({"type":"status","activity":"compacting"}));
                    c.request("thread/compact/start", json!({"threadId":sid}))
                } else {
                    let target = if p["target"].is_object() {
                        p["target"].clone()
                    } else {
                        json!({"type":"uncommittedChanges"})
                    };
                    if !matches!(
                        s(&target, "type"),
                        "uncommittedChanges" | "baseBranch" | "commit" | "custom"
                    ) {
                        run.running.store(false, Ordering::Release);
                        return Err("Unsupported review target".into());
                    }
                    c.request(
                        "review/start",
                        json!({"threadId":sid,"delivery":"inline","target":target}),
                    )
                };
                if result.is_err() {
                    run.manual_compact.store(false, Ordering::Release);
                    run.running.store(false, Ordering::Release);
                    self.emit_event(&run, json!({"type":"turn.end","text":"","isError":false}));
                }
                result
            }
            _ => Err(format!("Unsupported Codex action {action}")),
        }
    }
    pub fn invoke(self: &Arc<Self>, ch: &str, args: &[Value]) -> CoreResult {
        let a = |i| args.get(i).unwrap_or(&Value::Null);
        let p = a(0);
        let tid = s(p, "threadId");
        match ch{
  "desk:codex"=>self.codex_action(p),
  "agent:probe"=>self.probe(p==&true),"agent:usage"=>self.usage(p.as_str().unwrap_or("claude")),"agent:send"=>self.send(p),
  "agent:respondPermission"=>{let mut pending=self.approvals.lock().unwrap();let id=s(p,"reqId");if pending.get(id).is_some_and(|a|a.thread==tid){if let Some(a)=pending.remove(id){let _=a.tx.send(p.clone());return Ok(json!(true))}}Ok(json!(false))},
  "desk:switch-provider"=>{let provider=s(p,"provider");cli::require_enabled(provider)?;let t=self.thread(tid,provider)?;let r=t.run.lock().unwrap().clone();if r.as_ref().is_some_and(|r|r.running.load(Ordering::Acquire)){return Err("Chat is busy".into())}t.mailbox_paused.store(true,Ordering::Release);if let Some(r)=r{self.stop_run(&r)}*t.provider.lock().unwrap()=provider.into();*t.session.lock().unwrap()=s(p,"resume").into();*t.resume_at.lock().unwrap()=None;t.mailbox_paused.store(false,Ordering::Release);self.schedule_inbox(&t);Ok(json!(true))},
  "agent:configure"=>{let Some(t)=self.find(tid)else{return Ok(json!(false))};{let mut cfg=t.config.lock().unwrap();for k in["model","effort","permissionMode","serviceTier"]{if let Some(v)=p.get(k){cfg[k]=v.clone()}}}let r=t.run.lock().unwrap().clone();if let Some(r)=r{if r.provider=="claude"{let _lock=r.operation.lock().unwrap();let c=self.ensure(&r)?;for(key,subtype,field)in[("model","set_model","model"),("permissionMode","set_permission_mode","mode")]{if let Some(v)=p.get(key){c.control(json!({"subtype":subtype,field:v}))?;}}if let Some(effort)=p.get("effort"){c.control(json!({"subtype":"apply_flag_settings","settings":{"effortLevel":effort}}))?;}}}Ok(json!(true))},
  "agent:interrupt"=>{let id=p.as_str().unwrap_or("");if let Some(t)=self.find(id){t.mailbox_paused.store(true,Ordering::Release);t.inbox.lock().unwrap().clear();}if let Ok(r)=self.active(id){self.cancel(&r,None);match r.provider.as_str(){"claude"=>{let c=r.client.lock().unwrap().clone();if let Some(c)=c{c.control(json!({"subtype":"interrupt","cancel_queued":true}))?;}},"codex"=>{let turn=r.codex.lock().unwrap().turn.clone().unwrap_or_default();let sid=r.thread.upgrade().map(|t|t.session.lock().unwrap().clone()).unwrap_or_default();if !turn.is_empty(){self.codex_server()?.request("turn/interrupt",json!({"threadId":sid,"turnId":turn}))?;}},_=>{self.emit_event(&r,json!({"type":"turn.end","text":"","isError":false}));self.stop_run(&r);}}}for t in self.children(id){self.stop_tree(&t)}Ok(json!(true))},
  "agent:closeThread"=>{self.close_thread(p.as_str().unwrap_or(""));Ok(Value::Null)},
  "desk:release"=>{if let Ok(r)=self.active(p.as_str().unwrap_or("")){if !r.running.load(Ordering::Acquire){self.stop_run(&r);return Ok(json!(true))}}Ok(json!(false))},
  "agent:contextUsage"=>{let Ok(r)=self.active(p.as_str().unwrap_or(""))else{return Ok(Value::Null)};if r.provider=="codex"{return Ok(r.codex.lock().unwrap().context.clone())}if r.provider!="claude"{return Ok(Value::Null)}let c=self.ensure(&r)?;let mut u=c.control(json!({"subtype":"get_context_usage","detail":"summary"}))?;if let Some(categories)=u["categories"].as_array(){u["categories"]=json!(categories.iter().filter(|c|c["kind"]=="used"&&c["tokens"].as_u64().unwrap_or(0)>0).collect::<Vec<_>>());}Ok(u)},
  "agent:stopTask"|"agent:backgroundTask"=>{if ch=="agent:stopTask"&&self.stop_team_from_ui(p.as_str().unwrap_or(""),a(1).as_str().unwrap_or("")){return Ok(json!(true));}let r=self.active(p.as_str().unwrap_or(""))?;if r.provider!="claude"{return Err("Not supported by this agent".into())}let c=self.ensure(&r)?;let value=c.control(if ch=="agent:stopTask"{json!({"subtype":"stop_task","task_id":a(1)})}else{json!({"subtype":"background_tasks","tool_use_id":a(1)})})?;Ok(if ch=="agent:stopTask"{json!(true)}else{value.get("backgrounded").cloned().unwrap_or(json!(true))})},
  "agent:taskOutput"=>{let file=PathBuf::from(p.as_str().unwrap_or(""));if !self.task_files.lock().unwrap().contains(&file){return Ok(Value::Null)}use std::io::{Read,Seek,SeekFrom};let mut input=std::fs::File::open(&file).map_err(|e|e.to_string())?;let size=input.metadata().map_err(|e|e.to_string())?.len();let start=size.saturating_sub(65536);input.seek(SeekFrom::Start(start)).map_err(|e|e.to_string())?;let mut bytes=Vec::new();input.take(65536).read_to_end(&mut bytes).map_err(|e|e.to_string())?;let text=match String::from_utf8(bytes.clone()){Ok(s)=>s,Err(_)=>encoding_rs::IBM866.decode(&bytes).0.into_owned()};Ok(json!({"text":text,"truncated":start>0}))},
  "desk:summarize"=>self.quick(&format!("Summarize this earlier coding session in at most 600 words. Preserve goals, decisions, changed files, results, problems and next steps.\n\n{}",p.as_str().unwrap_or("").chars().take(120000).collect::<String>()),"You write precise handoff notes for software engineers.",Duration::from_secs(120)).map(|v|json!(v)),
  "agent:autoTitle"=>{let out=self.quick(&format!("Write a short title (2–5 words) in the language of this message. Reply with the title only, without quotes or trailing period.\n\n{}",s(p,"text").chars().take(2000).collect::<String>()),"You name chat conversations.",Duration::from_secs(45))?;let title=out.lines().next().unwrap_or("").trim_matches(|c:char|c.is_whitespace()||"\"'«»“”#*.".contains(c)).chars().take(80).collect::<String>();if title.is_empty(){return Ok(Value::Null)}self.rename(s(p,"sessionId"),&title,s(p,"cwd"),p["provider"].as_str().unwrap_or("claude"))?;Ok(json!(title))},
  "app:commitMessage"=>{let diff=super::git::diff_for_message(Path::new(p.as_str().unwrap_or("")),arr(a(1)))?;let out=self.quick(&format!("Write an English imperative git commit message, subject <=72 characters and optional three short bullets. Output only the message. Never include AI or co-author attribution.\n\n{}",diff.chars().take(24000).collect::<String>()),"You write concise git commit messages.",Duration::from_secs(120))?;Ok(json!(out.lines().filter(|l|!l.to_lowercase().contains("co-authored-by")&&!l.to_lowercase().contains("generated with")&&!l.starts_with("```")).collect::<Vec<_>>().join("\n").trim()))},
  "desk:skills"=>{if p=="codex"{let r=self.codex_server()?.request("skills/list",json!({"cwds":[a(1).as_str().unwrap_or(self.storage.home.to_str().unwrap_or(""))]}))?;Ok(json!(arr(&r["data"]).iter().flat_map(|x|arr(&x["skills"])).filter(|k|k["enabled"]!=false).map(|k|json!({"name":k["name"],"description":k["description"],"scope":k["scope"],"path":k["path"]})).collect::<Vec<_>>()))}else{Ok(json!([]))}},
  "mcp:status"=>{if p=="codex"{let r=self.codex_server()?.request("mcpServerStatus/list",json!({}))?;Ok(json!(arr(&r["data"]).iter().map(|m|json!({"name":m["name"],"status":if !m["toolsError"].is_null(){"failed"}else if m["authStatus"]=="notLoggedIn"{"needs-auth"}else{"connected"},"tools":m["tools"].as_object().map(|v|v.len()).unwrap_or(0),"scope":if m["pluginId"].is_null(){"config"}else{"plugin"},"error":m["toolsError"]})).collect::<Vec<_>>()))}else if p=="antigravity"||p=="gemini"{Ok(json!([]))}else{let r=self.claude_control(json!({"subtype":"mcp_status"}))?;Ok(json!(arr(&r["mcpServers"]).iter().map(|m|json!({"name":m["name"],"status":m["status"],"scope":m.get("scope").or(m.get("source")),"tools":arr(&m["tools"]).len(),"error":m["error"]})).collect::<Vec<_>>()))}},
  "mcp:reconnect"=>{if a(1)=="codex"{self.codex_server()?.request("config/mcpServer/reload",Value::Null)?;}else{self.claude_control(json!({"subtype":"mcp_reconnect","serverName":p}))?;}Ok(Value::Null)},
  "mcp:add"|"mcp:remove"=>self.mcp_cli(ch,args),
  "agent:rewind"=>{let t=self.thread(tid,p["config"]["provider"].as_str().unwrap_or("claude"))?;if t.run.lock().unwrap().is_none(){*t.config.lock().unwrap()=p["config"].clone();*t.session.lock().unwrap()=s(&p["config"],"resume").into();self.start(&t);}let run=self.active(tid)?;if run.provider!="claude"{return Err("File rewind is supported by Claude only".into())}let _lock=run.operation.lock().unwrap();let c=self.ensure(&run)?;c.control(json!({"subtype":"rewind_files","user_message_id":p["uuid"],"dry_run":p["dryRun"]==true}))},
  "agent:rewindConversation"=>{let provider=p["provider"].as_str().unwrap_or("claude");let t=self.thread(tid,provider)?;let current=*t.provider.lock().unwrap()==provider;let r=t.run.lock().unwrap().clone();if current{if let Some(r)=r{self.stop_run(&r)}}let sid=p["sessionId"].as_str().filter(|s|!s.is_empty()).map(str::to_owned).unwrap_or(t.session.lock().unwrap().clone());let n=p["dropTurns"].as_i64().unwrap_or(0);if !sid.is_empty()&&n>0{match provider{"codex"=>{self.codex_server()?.request("thread/rollback",json!({"threadId":sid,"numTurns":n}))?;},"antigravity"|"gemini"=>{self.history.journal_rollback(provider,&sid,n)?;},_=>{}}}if current{if p["resumeAt"]==false||(provider=="claude"&&p["resumeAt"].is_null()){*t.session.lock().unwrap()=String::new();}else{*t.session.lock().unwrap()=sid;}*t.resume_at.lock().unwrap()=if provider=="claude"{p["resumeAt"].as_str().map(str::to_owned)}else{None};}Ok(json!(true))},
  "agent:fork"=>{let provider=p["provider"].as_str().unwrap_or("claude");if provider=="codex"{let r=self.codex_server()?.request("thread/fork",json!({"threadId":p["sessionId"]}))?;return Ok(r["thread"]["id"].clone())}if provider=="claude"{return self.history.fork_claude(s(p,"sessionId"),s(p,"cwd"),s(p,"uuid"))}Err("Fork is not supported by this CLI".into())},
  _=>Err(format!("No native agent handler for {ch}"))}
    }
    fn mcp_cli(&self, ch: &str, args: &[Value]) -> CoreResult {
        let a = |i| args.get(i).unwrap_or(&Value::Null);
        let p = a(0);
        let adding = ch == "mcp:add";
        let provider = if adding {
            p["provider"].as_str().unwrap_or("claude")
        } else {
            a(2).as_str().unwrap_or("claude")
        };
        if !matches!(provider, "claude" | "codex") {
            return Err("This CLI does not expose MCP management".into());
        }
        let name = if adding {
            s(p, "name")
        } else {
            p.as_str().unwrap_or("")
        };
        if name.is_empty()
            || !name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "_.:-".contains(c))
        {
            return Err("Invalid MCP server name".into());
        }
        let mut argv = vec![
            "mcp".to_owned(),
            if adding { "add" } else { "remove" }.into(),
        ];
        if adding {
            let stdio = p["transport"] == "stdio";
            if provider == "claude" {
                argv.extend(["-s".into(), p["scope"].as_str().unwrap_or("user").into()]);
                if !stdio {
                    argv.extend(["--transport".into(), s(p, "transport").into()])
                }
            }
            if stdio {
                if let Some(env) = p["env"].as_object() {
                    for (k, v) in env {
                        argv.extend([
                            if provider == "claude" { "-e" } else { "--env" }.into(),
                            format!("{k}={}", v.as_str().unwrap_or("")),
                        ])
                    }
                }
                argv.extend([name.into(), "--".into(), s(p, "target").into()]);
                argv.extend(
                    arr(&p["args"])
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned),
                );
            } else {
                argv.push(name.into());
                if provider == "codex" {
                    argv.push("--url".into())
                }
                argv.push(s(p, "target").into());
            }
        } else {
            argv.push(name.into());
            if provider == "claude" {
                if let Some(scope) = a(1).as_str() {
                    argv.extend(["-s".into(), scope.into()]);
                }
            }
        }
        let p = cli::subscription(&self.storage, provider, cli::find(&self.storage, provider)?)?;
        Ok(json!(process::run(
            &p,
            &argv,
            Some(&self.storage.home),
            None,
            Duration::from_secs(60),
            process::MAX_OUTPUT
        )?
        .text()?
        .trim()))
    }
    pub fn rename(
        self: &Arc<Self>,
        sid: &str,
        title: &str,
        cwd: &str,
        provider: &str,
    ) -> CoreResult {
        if provider == "codex" {
            self.codex_server()?
                .request("thread/name/set", json!({"threadId":sid,"name":title}))?;
        }
        self.history.rename(sid, title, Some(cwd), provider)
    }
    pub fn archive(self: &Arc<Self>, sid: &str, cwd: &str, provider: &str) -> CoreResult {
        let threads = self
            .threads
            .lock()
            .unwrap()
            .values()
            .filter(|t| *t.session.lock().unwrap() == sid)
            .map(|t| t.id.clone())
            .collect::<Vec<_>>();
        for id in threads {
            self.close_thread(&id)
        }
        if provider == "codex" {
            self.codex_server()?
                .request("thread/archive", json!({"threadId":sid}))?;
            self.storage.update("native/session-metadata.json", |v| {
                v[sid]["deleted"] = json!(true);
                Ok(())
            })?;
            return Ok(json!(true));
        }
        self.history.remove(sid, Some(cwd), provider)
    }
    pub fn running(&self, id: &str) -> bool {
        self.active(id)
            .is_ok_and(|r| r.running.load(Ordering::Acquire))
    }
    pub fn recently_active(&self, id: &str, sid: &str) -> bool {
        let threads = self.threads.lock().unwrap();
        threads.values().any(|t| {
            if t.id != id && *t.session.lock().unwrap() != sid {
                return false;
            }
            t.run.lock().unwrap().as_ref().is_some_and(|r| {
                r.running.load(Ordering::Acquire)
                    || storage::now().saturating_sub(r.last.load(Ordering::Relaxed)) < 6000
            })
        })
    }
    pub fn status(&self) -> Value {
        let threads = self.threads.lock().unwrap();
        json!({"threads":threads.len(),"liveRuns":threads.values().filter(|t|t.run.lock().unwrap().is_some()).count(),"running":threads.values().filter(|t|t.run.lock().unwrap().as_ref().is_some_and(|r|r.running.load(Ordering::Acquire))).count(),"pendingPermissions":self.approvals.lock().unwrap().len(),"operations":self.jobs.load(Ordering::Relaxed)})
    }
}
pub fn claude_limits(u: &Value) -> Value {
    let mut out = json!({"plan":u["subscription_type"]});
    if u["rate_limits_available"] == true {
        for (from, to) in [("five_hour", "session"), ("seven_day", "weekly")] {
            let w = &u["rate_limits"][from];
            if let Some(pct) = w["utilization"].as_f64() {
                out[to] =
                    json!({"pct":pct.clamp(0.,100.),"resetsAt":events::timestamp(&w["resets_at"])});
            }
        }
    }
    out
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, Arc<Agents>) {
        let root = tempfile::tempdir().unwrap();
        let storage = Arc::new(Storage::new(
            root.path().join("data"),
            root.path().join("home"),
            root.path().into(),
        ));
        let history = Arc::new(History::new(
            storage.clone(),
            root.path().join("home/.claude/projects"),
        ));
        let agents = Agents::new(storage, history, Arc::new(|_, _| {}));
        (root, agents)
    }
    #[test]
    fn idle_trim_preserves_work_approvals_and_saved_session() {
        let (_root, agents) = fixture();
        let thread = agents.thread("idle", "claude").unwrap();
        *thread.session.lock().unwrap() = "saved-session".into();
        let run = agents.start(&thread);
        run.last.store(1, Ordering::Relaxed);
        run.running.store(true, Ordering::Release);
        agents.maintain();
        assert!(Agents::current(&run));
        run.running.store(false, Ordering::Release);
        run.background.lock().unwrap().insert("task:1".into());
        agents.maintain();
        assert!(Agents::current(&run));
        run.background.lock().unwrap().clear();
        let (tx, _rx) = mpsc::sync_channel(1);
        agents.approvals.lock().unwrap().insert(
            "approval".into(),
            Approval {
                thread: thread.id.clone(),
                run: Arc::downgrade(&run),
                source: "test".into(),
                tx,
            },
        );
        agents.maintain();
        assert!(Agents::current(&run));
        agents.approvals.lock().unwrap().clear();
        agents.maintain();
        assert!(!Agents::current(&run));
        assert_eq!(*thread.session.lock().unwrap(), "saved-session");
        assert!(thread.run.lock().unwrap().is_none());
        let resumed = agents.start(&thread);
        assert!(Agents::current(&resumed));
        agents.stop_run(&run);
        assert!(Agents::current(&resumed));
        agents.shutdown();
    }
    #[test]
    fn closing_run_denies_pending_permission_without_touching_successor() {
        let (_root, agents) = fixture();
        let thread = agents.thread("chat", "claude").unwrap();
        let old = agents.start(&thread);
        let (tx, rx) = mpsc::sync_channel(1);
        agents.approvals.lock().unwrap().insert(
            "pending".into(),
            Approval {
                thread: thread.id.clone(),
                run: Arc::downgrade(&old),
                source: "test".into(),
                tx,
            },
        );
        agents.stop_run(&old);
        assert_eq!(rx.try_recv().unwrap()["decision"], "deny");
        assert!(agents.approvals.lock().unwrap().is_empty());
        let current = agents.start(&thread);
        agents.failed(&old, "late callback".into());
        assert!(Agents::current(&current));
        agents.shutdown();
    }
    #[test]
    fn concurrent_sends_acquire_one_run_per_chat() {
        let (_root, agents) = fixture();
        let thread = agents.thread("parallel", "claude").unwrap();
        let barrier = Arc::new(std::sync::Barrier::new(16));
        let workers = (0..16)
            .map(|_| {
                let a = agents.clone();
                let t = thread.clone();
                let b = barrier.clone();
                std::thread::spawn(move || {
                    b.wait();
                    a.start(&t)
                })
            })
            .collect::<Vec<_>>();
        let runs = workers
            .into_iter()
            .map(|w| w.join().unwrap())
            .collect::<Vec<_>>();
        assert!(runs.iter().all(|r| Arc::ptr_eq(r, &runs[0])));
        agents.shutdown();
    }
}
fn policy(mode: &str, cfg: &Value) -> Value {
    let full = json!({"type":"dangerFullAccess"});
    let sandboxed = true;
    let read = if sandboxed {
        json!({"type":"readOnly","networkAccess":false})
    } else {
        full.clone()
    };
    let write = if sandboxed {
        json!({"type":"workspaceWrite","writableRoots":arr(&cfg["dirs"]),"networkAccess":false,"excludeTmpdirEnvVar":false,"excludeSlashTmp":false})
    } else {
        full.clone()
    };
    match mode {
        "bypassPermissions" => {
            json!({"approvalPolicy":"never","sandbox":"danger-full-access","sandboxPolicy":full})
        }
        "auto" => {
            json!({"approvalPolicy":"on-request","sandbox":if sandboxed{"workspace-write"}else{"danger-full-access"},"sandboxPolicy":write})
        }
        "plan" => {
            json!({"approvalPolicy":"untrusted","sandbox":if sandboxed{"read-only"}else{"danger-full-access"},"sandboxPolicy":read})
        }
        _ => {
            json!({"approvalPolicy":"untrusted","sandbox":if sandboxed{"workspace-write"}else{"danger-full-access"},"sandboxPolicy":write})
        }
    }
}

fn validate_claude_account(account: &Value) -> Result<(), String> {
    let provider = s(account, "apiProvider");
    let key = s(account, "apiKeySource");
    if (!provider.is_empty() && provider != "firstParty")
        || (!key.is_empty() && key != "none")
        || s(account, "subscriptionType").is_empty()
    {
        return Err("Sign in to Claude Code with your Claude subscription; API-key and cloud-billing providers are disabled in Duet.".into());
    }
    Ok(())
}

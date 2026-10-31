//! Application services owned by Rust, independent of Tauri and of the temporary Node bridge.
mod agents;
mod cli;
mod codex;
mod config;
mod context;
mod desktop;
mod events;
mod files;
mod git;
mod history;
mod jsonl;
mod live;
mod pr;
mod process;
mod project_index;
mod rpc;
mod scheduler;
mod search;
mod stats;
mod storage;
mod telegram;
mod terminal;
mod toolsets;
#[path = "json.rs"]
mod wire_json;

use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

pub type Emit = Arc<dyn Fn(&str, Value) + Send + Sync>;
pub use agents::Host;
pub type CoreResult = Result<Value, String>;
/// Native CLI fallback for providers without an in-process dynamic-tool bridge.
pub fn context_client(args:&[String])->Result<Value,String>{
    let endpoint=args.first().ok_or("Expected context endpoint")?;
    let url=url::Url::parse(endpoint).map_err(|e|e.to_string())?;
    if url.scheme()!="http"||url.host_str()!=Some("127.0.0.1")||url.port().is_none()||!url.path().starts_with("/context/")||!url.username().is_empty()||url.password().is_some(){return Err("Context endpoints must use a local run capability".into())}
    let action=args.get(1).ok_or("Expected inspect/read/edit/job/restore")?;
    if !["inspect","read","edit","job","restore","cancel"].contains(&action.as_str()){return Err("Unknown context action".into())}
    let input=if args.get(2).map(String::as_str)==Some("--request-file"){let file=args.get(3).ok_or("Expected JSON request file")?;String::from_utf8(storage::read_limited(std::path::Path::new(file),256*1024)?).map_err(|e|e.to_string())?}else{args.get(2).cloned().unwrap_or_else(||"{}".into())};
    let mut body:Value=serde_json::from_str(&input).map_err(|e|e.to_string())?;if !body.is_object(){return Err("Expected a JSON object".into())}body["action"]=json!(action);
    let client=reqwest::blocking::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).timeout(std::time::Duration::from_secs(60)).build().map_err(|e|e.to_string())?;
    let response=client.post(url).json(&body).send().map_err(|e|e.to_string())?;response.json::<Value>().map_err(|e|e.to_string())
}
pub const CHANNELS: &[&str] = &[
    "agent:autoTitle",
    "agent:backgroundTask",
    "agent:closeThread",
    "agent:configure",
    "agent:contextUsage",
    "agent:deleteSession",
    "agent:fork",
    "agent:interrupt",
    "agent:listSessions",
    "agent:loadSession",
    "agent:loadSessionPage",
    "agent:loadSubagentPage",
    "agent:loadSubagents",
    "agent:probe",
    "agent:renameSession",
    "agent:respondPermission",
    "agent:rewind",
    "agent:rewindConversation",
    "agent:segments",
    "agent:send",
    "agent:stopTask",
    "agent:taskOutput",
    "agent:usage",
    "app:buildInfo",
    "app:commitMessage",
    "app:getSettings",
    "app:gitBranch",
    "app:gitBranches",
    "app:gitCheckout",
    "app:gitCommit",
    "app:gitDiscard",
    "app:gitFileDiff",
    "app:gitPull",
    "app:gitPush",
    "app:gitStatus",
    "app:openExternal",
    "app:openIn",
    "app:openPath",
    "app:openTargets",
    "app:pathExists",
    "app:pickFolder",
    "app:rebuild",
    "app:relaunch",
    "app:setSettings",
    "app:setTheme",
    "app:showInFolder",
    "browser:control",
    "browser:navigate",
    "browser:screenshot",
    "browser:setBounds",
    "browser:setVisible",
    "browser:state",
    "cmd:delete",
    "cmd:list",
    "cmd:paths",
    "cmd:read",
    "cmd:rename",
    "cmd:write",
    "desk:native-core",
    "desk:history-context",
    "desk:notification",
    "desk:release",
    "desk:skills",
    "desk:codex",
    "desk:context",
    "desk:summarize",
    "desk:switch-provider",
    "desk:ui-error",
    "desk:watch",
    "files:list",
    "files:read",
    "files:unwatch",
    "files:watch",
    "files:write",
    "fs:attachment",
    "fs:pasteText",
    "fs:index",
    "fs:stat",
    "instr:hooksSummary",
    "instr:list",
    "instr:read",
    "instr:write",
    "mcp:add",
    "mcp:reconnect",
    "mcp:remove",
    "mcp:status",
    "pr:branches",
    "pr:create",
    "pr:draft",
    "pr:failedLogs",
    "pr:push",
    "pr:status",
    "sched:delete",
    "sched:list",
    "sched:runNow",
    "sched:save",
    "sched:setTelegram",
    "sched:telegramTest",
    "sched:toggle",
    "search:query",
    "search:reindex",
    "stats:summary",
    "term:create",
    "term:kill",
    "term:resize",
    "term:write",
    "tg:setEnabled",
    "tg:status",
    "voice:ping",
    "win:close",
    "win:detach",
    "win:focus",
    "win:handoff",
    "win:info",
    "win:list",
    "win:ready",
    "win:reattach",
    "win:setTheme",
    "wt:all",
    "wt:apply",
    "wt:create",
    "wt:isRepo",
    "wt:remove",
];

pub struct NativeCore {
    desktop: Arc<desktop::Desktop>,
    scheduler: Arc<scheduler::Scheduler>,
    telegram: Arc<telegram::Telegram>,
    stopped: std::sync::atomic::AtomicBool,
    agents: Arc<agents::Agents>,
    emit: Emit,
    history: Arc<history::History>,
    storage: std::sync::Arc<storage::Storage>,
    terminals: terminal::Terminals,
    files: files::Files,
    search: search::Search,
    requests: AtomicU64,
}
impl NativeCore {
    pub fn new(data: PathBuf, transcripts: PathBuf, emit: Emit) -> Self {
        let home = data.join("test-home");
        let runtime = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_owned();
        Self::with_paths(data, home, runtime, transcripts, emit)
    }
    pub fn with_paths(
        data: PathBuf,
        home: PathBuf,
        runtime: PathBuf,
        transcripts: PathBuf,
        emit: Emit,
    ) -> Self {
        let remote_slot: Arc<std::sync::Mutex<Option<std::sync::Weak<telegram::Telegram>>>> =
            Arc::new(std::sync::Mutex::new(None));
        let observe = remote_slot.clone();
        let ui_emit = emit;
        let emit: Emit = Arc::new(move |channel, payload| {
            let remote = observe
                .lock()
                .unwrap()
                .as_ref()
                .and_then(std::sync::Weak::upgrade);
            if let Some(remote) = remote {
                remote.observe(channel, &payload);
            }
            ui_emit(channel, payload);
        });
        let storage = Arc::new(storage::Storage::new(data.clone(), home, runtime));
        let history = Arc::new(history::History::new(storage.clone(), transcripts.clone()));
        let agents = agents::Agents::new(storage.clone(), history.clone(), emit.clone());
        let desktop = Arc::new(desktop::Desktop::new(
            storage.clone(),
            agents.clone(),
            emit.clone(),
        ));
        let scheduler = scheduler::Scheduler::new(storage.clone(), agents.clone(), emit.clone());
        let telegram = telegram::Telegram::new(
            storage.clone(),
            agents.clone(),
            scheduler.clone(),
            history.clone(),
            emit.clone(),
        );
        *remote_slot.lock().unwrap() = Some(Arc::downgrade(&telegram));
        Self {
            desktop,
            scheduler,
            telegram,
            stopped: std::sync::atomic::AtomicBool::new(false),
            agents,
            emit: emit.clone(),
            history,
            storage,
            terminals: terminal::Terminals::new(emit.clone()),
            files: files::Files::new(emit.clone()),
            search: search::Search::new(data.join("native/search.sqlite3"), transcripts, emit),
            requests: AtomicU64::new(0),
        }
    }
    pub fn set_host(self: &Arc<Self>, host: Host) {
        let weak = Arc::downgrade(self);
        self.agents.set_host(Arc::new(move |method, p| {
            if method == "browser.tool" {
                weak.upgrade()
                    .ok_or("Application closed")?
                    .desktop
                    .browser_tool(&p)
            } else {
                host(method, p)
            }
        }));
    }
    pub fn boot(self: &Arc<Self>) -> CoreResult {
        self.desktop.boot()?;
        let weak = Arc::downgrade(self);
        let background = std::env::var_os("DUET_NATIVE_PREVIEW").is_none()
            && std::env::var_os("DUET_NATIVE_TEST").is_none();
        if background {
            self.scheduler.initialize()?;
            self.telegram.start();
        }
        std::thread::spawn(move || {
            let mut ticks = 0;
            loop {
                std::thread::sleep(std::time::Duration::from_secs(2));
                let Some(core) = weak.upgrade() else { break };
                if core.stopped.load(Ordering::Acquire) {
                    break;
                }
                core.desktop.flush_bounds();
                for item in core.desktop.watches() {
                    let path = core
                        .history
                        .find(
                            item["provider"].as_str().unwrap_or("claude"),
                            events::s(&item, "sessionId"),
                            item["cwd"].as_str(),
                        )
                        .ok();
                    core.desktop.check_watch(&item, path);
                }
                ticks += 1;
                if ticks % 15 == 0 {
                    core.desktop.maintain_browser();
                    core.agents.maintain();
                    if background {
                        core.scheduler.tick();
                    }
                }
            }
        });
        Ok(Value::Null)
    }
    pub fn shutdown(&self) {
        self.desktop.flush_browser();
        self.desktop.flush_bounds();
        self.terminals.shutdown();
        if self.stopped.swap(true, Ordering::AcqRel) {
            return;
        }
        self.telegram.stop();
        self.scheduler.stop();
        self.agents.shutdown();
    }
    pub fn native_event(&self, id: &str, event: &str, data: Value) {
        self.desktop.native_event(id, event, data)
    }
    pub fn invoke_from(&self, window: &str, channel: &str, args: &[Value]) -> CoreResult {
        if channel == "agent:closeThread" {
            if let Some(id) = args.first().and_then(Value::as_str) {
                self.desktop.dispose(id);
            }
        }
        if channel.starts_with("browser:")
            || channel.starts_with("win:")
            || [
                "app:openTargets",
                "app:openIn",
                "app:openPath",
                "app:openExternal",
                "app:showInFolder",
                "app:pickFolder",
                "app:rebuild",
                "app:buildInfo",
                "app:relaunch",
                "app:setTheme",
                "desk:watch",
                "desk:ui-error",
                "desk:notification",
                "voice:ping",
            ]
            .contains(&channel)
        {
            return self.desktop.invoke(window, channel, args);
        }
        self.invoke(channel, args)
    }
    pub fn handles(channel: &str) -> bool {
        CHANNELS.contains(&channel)
    }
    pub fn invoke(&self, channel: &str, args: &[Value]) -> CoreResult {
        self.requests.fetch_add(1, Ordering::Relaxed);
        if channel.starts_with("pr:") {
            return pr::invoke(&self.storage, &self.agents, channel, args);
        }
        if channel.starts_with("sched:") {
            return self.scheduler.invoke(channel, args);
        }
        if channel.starts_with("tg:") {
            return self.telegram.invoke(channel, args);
        }
        if channel.starts_with("app:git") {
            return git::invoke(channel, args);
        }
        if channel.starts_with("wt:") {
            return git::worktree(&self.storage, channel, args);
        }
        if channel.starts_with("term:") {
            return self.terminals.invoke(channel, args, &self.storage);
        }
        if channel.starts_with("cmd:") {
            return config::commands(&self.storage, channel, args, &self.emit);
        }
        if channel.starts_with("instr:") {
            return config::instructions(&self.storage, channel, args);
        }
        let arg = |n: usize| args.get(n).unwrap_or(&Value::Null);
        let string = |n: usize| {
            arg(n)
                .as_str()
                .ok_or_else(|| format!("{channel}: expected string argument {n}"))
        };
        match channel {
            "desk:context" => self.agents.context_api(arg(0)),
            "desk:history-context" => {
                let parts = events::arr(arg(0));
                if parts.len() > 500 {
                    return Err("Too many history parts".into());
                }
                let mut text = String::new();
                let mut seen = std::collections::HashSet::new();
                for part in parts.iter().rev() {
                    let sid = events::s(part, "sessionId");
                    let segment = part["segment"].as_i64();
                    let provider = part["provider"].as_str().unwrap_or("claude");
                    if !seen.insert((sid, segment, provider)) {
                        continue;
                    }
                    let context = self.history.context(
                        sid,
                        part["cwd"].as_str(),
                        segment,
                        provider,
                        part["cursor"].as_i64(),
                    )?;
                    if !context.is_empty() {
                        text.push_str(&format!("\n## {} session {}\n{}", provider, sid, context));
                    }
                    if text.len() > 120000 {
                        break;
                    }
                }
                Ok(json!(text.chars().take(120000).collect::<String>()))
            }
            "stats:summary" => stats::summary(&self.storage, arg(0).as_u64().unwrap_or(30)),
            "agent:loadSubagents" => self.history.subagents(
                string(0)?,
                arg(1).as_str(),
                arg(2).as_str().unwrap_or("claude"),
            ),
            "agent:loadSubagentPage" => self.history.subagent_page(
                string(0)?,
                arg(1).as_str(),
                arg(2).as_str().unwrap_or("claude"),
                string(3)?,
                arg(4),
            ),
            "agent:listSessions" => self.history.list(),
            "agent:loadSession" => self.history.load(
                string(0)?,
                arg(1).as_str(),
                arg(2).as_i64(),
                arg(3).as_str().unwrap_or("claude"),
                None,
            ),
            "agent:loadSessionPage" => self.history.load(
                string(0)?,
                arg(1).as_str(),
                arg(2).as_i64(),
                arg(3).as_str().unwrap_or("claude"),
                Some(arg(4)),
            ),
            "agent:segments" => self.history.segments(
                string(0)?,
                arg(1).as_str(),
                arg(2).as_str().unwrap_or("claude"),
            ),
            "agent:renameSession" => self.agents.rename(
                string(0)?,
                string(1)?,
                arg(2).as_str().unwrap_or(""),
                arg(3).as_str().unwrap_or("claude"),
            ),
            "agent:deleteSession" => self.agents.archive(
                string(0)?,
                arg(1).as_str().unwrap_or(""),
                arg(2).as_str().unwrap_or("claude"),
            ),
            "fs:index" => project_index::index(arg(0).as_str().unwrap_or("")),
            "app:getSettings" => Ok(self.storage.ui()),
            "app:setSettings" => self.storage.set_ui(arg(0)),
            "files:list" => self.files.list(string(0)?),
            "files:read" => self.files.read(string(0)?),
            "files:write" => self.files.write(string(0)?, string(1)?),
            "files:watch" => self.files.watch(string(0)?),
            "files:unwatch" => self.files.unwatch(string(0)?),
            "fs:stat" => self.files.stat(arg(0)),
            "fs:attachment" => self.files.attachment(string(0)?),
            "fs:pasteText" => self.files.paste_text(&self.storage.data, string(0)?),
            "app:pathExists" => Ok(json!(arg(0)
                .as_str()
                .filter(|s| !s.is_empty())
                .is_some_and(|p| std::path::Path::new(p).exists()))),
            "search:query" => self.search.query(arg(0)),
            "search:reindex" => self.search.reindex(),
            "desk:native-core" => {
                let inventory: Value =
                    serde_json::from_str(include_str!("../../../desktop/ipc-ownership.json"))
                        .map_err(|e| e.to_string())?;
                let remaining: Vec<&Value> = inventory["channels"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|entry| entry["owner"] == "node-legacy")
                    .map(|entry| &entry["channel"])
                    .collect();
                Ok(json!({
                    "phase":"complete", "legacyNodeCore":false,
                    "nativeChannels":CHANNELS,
                    "remainingNodeChannels":remaining,
                    "requests":{"rust":self.requests.load(Ordering::Relaxed),"nodeLegacy":0},
                    "limits":{"fileReadBytes":files::MAX_READ,"attachmentBytes":files::MAX_ATTACHMENT,
                        "watchedFiles":files::MAX_WATCHED,"jsonlRecordBytes":jsonl::MAX_RECORD,
                        "sqliteCacheKiB":search::CACHE_KIB,"searchResults":search::MAX_RESULTS},
                    "search":self.search.stats(), "agents":self.agents.status()
                }))
            }
            _ => self.agents.invoke(channel, args),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ownership_inventory_covers_every_contract_without_a_node_fallback() {
        let root = tempfile::tempdir().unwrap();
        let core = NativeCore::new(
            root.path().to_owned(),
            root.path().join("transcripts"),
            Arc::new(|_, _| {}),
        );
        let inventory: Value =
            serde_json::from_str(include_str!("../../../desktop/ipc-ownership.json")).unwrap();
        let owners: Vec<_> = inventory["channels"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|entry| entry["owner"] == "rust")
            .map(|entry| entry["channel"].as_str().unwrap())
            .collect();
        assert_eq!(owners.len(), CHANNELS.len());
        for channel in owners {
            assert!(NativeCore::handles(channel));
        }
        let status = core.invoke("desk:native-core", &[]).unwrap();
        assert_eq!(status["phase"], "complete");
        assert_eq!(status["legacyNodeCore"], false);
        assert!(status["remainingNodeChannels"]
            .as_array()
            .unwrap()
            .is_empty());
        assert!(NativeCore::handles("agent:send"));
    }
}

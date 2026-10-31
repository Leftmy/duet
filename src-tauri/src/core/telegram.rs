//! Telegram remote control. Only the configured private chat/user can start or approve work.
use super::{
    agents::Agents,
    cli,
    events::{arr, s},
    history::History,
    scheduler::Scheduler,
    storage::{self, Storage},
    CoreResult, Emit,
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    time::Duration,
};
struct Live {
    thread: Option<String>,
    started: u64,
    progress: String,
    message: Option<i64>,
    bot_name: String,
    error: String,
    polling: bool,
    refs: HashMap<String, Value>,
    events: VecDeque<(String, Value)>,
    permissions: HashMap<String, (String, String)>,
    online: u64,
}
pub struct Telegram {
    storage: Arc<Storage>,
    agents: Arc<Agents>,
    scheduler: Arc<Scheduler>,
    history: Arc<History>,
    emit: Emit,
    live: Mutex<Live>,
    wake: Condvar,
    stopped: AtomicBool,
    started: AtomicBool,
}
fn clip(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}
fn btn(text: impl Into<String>, data: impl Into<String>) -> Value {
    json!({"text":text.into(),"callback_data":data.into()})
}
fn keyboard(rows: Vec<Vec<Value>>) -> Value {
    json!({"inline_keyboard":rows})
}
fn allowed(update: &Value, chat: &str) -> bool {
    update["chat"]["type"] == "private"
        && update["chat"]["id"]
            .as_i64()
            .map(|n| n.to_string())
            .as_deref()
            == Some(chat)
        && update["from"]["id"]
            .as_i64()
            .map(|n| n.to_string())
            .as_deref()
            == Some(chat)
}
impl Telegram {
    pub fn new(
        storage: Arc<Storage>,
        agents: Arc<Agents>,
        scheduler: Arc<Scheduler>,
        history: Arc<History>,
        emit: Emit,
    ) -> Arc<Self> {
        Arc::new(Self {
            storage,
            agents,
            scheduler,
            history,
            emit,
            live: Mutex::new(Live {
                thread: None,
                started: 0,
                progress: String::new(),
                message: None,
                bot_name: String::new(),
                error: String::new(),
                polling: false,
                refs: HashMap::new(),
                events: VecDeque::new(),
                permissions: HashMap::new(),
                online: storage::now() / 1000,
            }),
            wake: Condvar::new(),
            stopped: AtomicBool::new(false),
            started: AtomicBool::new(false),
        })
    }
    fn ru(&self) -> bool {
        self.storage.ui()["language"] == "ru"
    }
    fn tr<'a>(&self, en: &'a str, ru: &'a str) -> &'a str {
        if self.ru() {
            ru
        } else {
            en
        }
    }
    fn state(&self) -> Value {
        self.storage.read("telegram.json")
    }
    fn patch(&self, patch: &Value) -> CoreResult {
        self.storage.update("telegram.json", |v| {
            storage::merge(v, patch);
            Ok(())
        })
    }
    fn configured(&self) -> bool {
        let (token, chat) = self.scheduler.config();
        !token.is_empty() && !chat.is_empty() && chat.chars().all(|c| c.is_ascii_digit())
    }
    pub fn status(&self) -> Value {
        let st = self.state();
        let live = self.live.lock().unwrap();
        json!({"enabled":st["enabled"]==true,"configured":self.configured(),"running":live.polling,"busy":live.thread.is_some(),"busySince":if live.thread.is_some(){json!(live.started)}else{Value::Null},"botName":live.bot_name,"lastError":live.error,"current":{"project":st["project"],"chat":st["chat"]["title"],"mode":st["mode"].as_str().unwrap_or("edits"),"model":st["model"].as_str().unwrap_or("default")}})
    }
    fn update(&self) {
        (self.emit)("tg:update", self.status())
    }
    pub fn invoke(self: &Arc<Self>, ch: &str, args: &[Value]) -> CoreResult {
        match ch {
            "tg:status" => Ok(self.status()),
            "tg:setEnabled" => {
                let enabled = args.first() == Some(&json!(true));
                if enabled && !self.configured() {
                    return Err(self
                        .tr(
                            "Configure a bot token and a positive private chat id first.",
                            "Сначала укажи токен бота и положительный ID личного чата.",
                        )
                        .into());
                }
                self.patch(&json!({"enabled":enabled}))?;
                self.update();
                Ok(self.status())
            }
            _ => Err("Unknown Telegram channel".into()),
        }
    }
    pub fn start(self: &Arc<Self>) {
        if self.started.swap(true, Ordering::AcqRel) {
            return;
        }
        let weak = Arc::downgrade(self);
        std::thread::spawn(move || {
            let mut last_key = String::new();
            while let Some(owner) = weak.upgrade() {
                if owner.stopped.load(Ordering::Acquire) {
                    break;
                }
                let st = owner.state();
                if st["enabled"] != true || !owner.configured() {
                    owner.live.lock().unwrap().polling = false;
                    drop(owner);
                    std::thread::sleep(Duration::from_secs(1));
                    continue;
                }
                let (token, chat) = owner.scheduler.config();
                let key = format!("{token}\n{chat}");
                if key != last_key {
                    let bot = owner.scheduler.api("getMe", &json!({}), 20);
                    match bot {
                        Ok(bot) => {
                            let id = bot["id"].to_string();
                            let mut patch = json!({"botId":id});
                            if st["botId"] != patch["botId"] {
                                patch["offset"] = json!(0)
                            }
                            let _ = owner.patch(&patch);
                            {
                                let mut live = owner.live.lock().unwrap();
                                live.bot_name = s(&bot, "username").into();
                                live.online = storage::now() / 1000;
                                live.error.clear();
                                live.polling = true;
                            }
                            let commands = [
                                "start", "menu", "projects", "chats", "new", "status", "stop",
                                "settings", "help",
                            ]
                            .iter()
                            .map(|name| json!({"command":name,"description":name}))
                            .collect::<Vec<_>>();
                            let _ = owner.scheduler.api(
                                "setMyCommands",
                                &json!({"commands":commands}),
                                20,
                            );
                            owner.update();
                            last_key = key;
                        }
                        Err(error) => {
                            owner.live.lock().unwrap().error = error;
                            owner.update();
                            drop(owner);
                            std::thread::sleep(Duration::from_secs(5));
                            continue;
                        }
                    }
                }
                owner.live.lock().unwrap().polling = true;
                let offset = owner.state()["offset"].as_i64().unwrap_or(0);
                let response=owner.scheduler.api("getUpdates",&json!({"offset":offset,"timeout":25,"allowed_updates":["message","callback_query"]}),35);
                match response {
                    Ok(updates) => {
                        for update in arr(&updates) {
                            if owner.stopped.load(Ordering::Acquire)
                                || owner.state()["enabled"] != true
                            {
                                break;
                            }
                            if let Some(id) = update["update_id"].as_i64() {
                                let _ = owner.patch(&json!({"offset":id+1}));
                            }
                            if let Err(error) = owner.handle(update) {
                                owner.live.lock().unwrap().error = error.clone();
                                let _ = owner.send(&clip(&error, 2000), None);
                            }
                        }
                    }
                    Err(error) => {
                        owner.live.lock().unwrap().error = error;
                        owner.update();
                        drop(owner);
                        std::thread::sleep(Duration::from_secs(3));
                    }
                }
            }
        });
        let weak = Arc::downgrade(self);
        std::thread::spawn(move || {
            while let Some(owner) = weak.upgrade() {
                if owner.stopped.load(Ordering::Acquire) {
                    break;
                }
                let mut live = owner.live.lock().unwrap();
                if live.events.is_empty() {
                    let (g, _) = owner
                        .wake
                        .wait_timeout(live, Duration::from_secs(3))
                        .unwrap();
                    live = g;
                }
                let event = live.events.pop_front();
                let busy = live.thread.clone();
                let progress = live.progress.clone();
                let message = live.message;
                drop(live);
                if let Some((ch, payload)) = event {
                    let _ = owner.deliver(&ch, &payload);
                } else if busy.is_some() {
                    let (_, chat) = owner.scheduler.config();
                    let _ = owner.scheduler.api(
                        "sendChatAction",
                        &json!({"chat_id":chat,"action":"typing"}),
                        10,
                    );
                    if let Some(message) = message {
                        let _=owner.scheduler.api("editMessageText",&json!({"chat_id":chat,"message_id":message,"text":format!("⏳ {}\n{}",owner.tr("Working","Работаю"),clip(&progress,600)),"reply_markup":keyboard(vec![vec![btn("⏹ Stop","stop")]])}),10);
                    }
                }
            }
        });
    }
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
        self.wake.notify_all()
    }
    pub fn observe(&self, ch: &str, payload: &Value) {
        let mut live = self.live.lock().unwrap();
        if live.thread.as_deref() != payload["threadId"].as_str() {
            return;
        }
        let ev = &payload["ev"];
        if ch == "agent:event" {
            match s(ev, "type") {
                "session" => {
                    let _=self.patch(&json!({"chat":{"sessionId":ev["sessionId"],"title":self.state()["chat"]["title"],"cwd":self.state()["chat"]["cwd"],"provider":ev["provider"].as_str().unwrap_or(self.state()["agent"].as_str().unwrap_or("claude"))}}));
                }
                "tool" => {
                    live.progress =
                        format!("{} {}", s(ev, "name"), clip(&ev["input"].to_string(), 400));
                }
                "turn.end" => {
                    if live.events.len() < 128 {
                        live.events.push_back((ch.into(), payload.clone()));
                        self.wake.notify_one();
                    }
                }
                _ => {}
            }
        } else if matches!(
            ch,
            "agent:permission" | "agent:permission-cancel" | "agent:closed"
        ) && live.events.len() < 128
        {
            live.events.push_back((ch.into(), payload.clone()));
            self.wake.notify_one();
        }
    }
    fn send(&self, text: &str, markup: Option<Value>) -> CoreResult {
        self.scheduler.send_telegram(text, markup)
    }
    fn show(&self, text: String, rows: Vec<Vec<Value>>) -> CoreResult {
        self.send(&text, Some(keyboard(rows)))
    }
    fn reference(&self, value: Value) -> String {
        let key = uuid::Uuid::new_v4().simple().to_string()[..12].to_owned();
        let mut live = self.live.lock().unwrap();
        if live.refs.len() >= 800 {
            live.refs.clear()
        }
        live.refs.insert(key.clone(), value);
        key
    }
    fn menu(&self) -> CoreResult {
        let st = self.state();
        let title = st["chat"]["title"]
            .as_str()
            .unwrap_or(self.tr("New chat", "Новый чат"));
        let provider = st["agent"].as_str().unwrap_or("claude");
        let folder = st["chat"]["cwd"]
            .as_str()
            .or(st["project"]["folder"].as_str())
            .unwrap_or("");
        let keyboard = json!({"keyboard":[[{"text":"📁 Projects"},{"text":"💬 Chats"}],[{"text":"➕ New chat"},{"text":"⚙ Settings"},{"text":"📊 Status"}]],"resize_keyboard":true,"is_persistent":true});
        self.send(
            &format!(
                "Duet · {}\n{title}\n{folder}\n\n{}",
                cli::label(provider),
                self.tr(
                    "Send a message to continue.",
                    "Отправь сообщение, чтобы продолжить."
                )
            ),
            Some(keyboard),
        )
    }
    fn settings(&self) -> CoreResult {
        let st = self.state();
        let mode = st["mode"].as_str().unwrap_or("edits");
        let model = st["model"].as_str().unwrap_or("default");
        let agent = st["agent"].as_str().unwrap_or("claude");
        self.show(
            format!(
                "⚙ {}\nAgent: {}\nModel: {model}\nPermissions: {mode}",
                self.tr("Settings", "Настройки"),
                cli::label(agent)
            ),
            vec![
                cli::IDS
                    .iter()
                    .map(|id| btn(cli::label(id), format!("ag:{id}")))
                    .collect(),
                ["default", "sonnet", "opus", "haiku"]
                    .iter()
                    .map(|id| btn(*id, format!("md:{id}")))
                    .collect(),
                vec![
                    btn("🛡 Ask", "mo:ask"),
                    btn("✏ Edits", "mo:edits"),
                    btn("⚡ Full access", "mo:full"),
                ],
                vec![btn(
                    if st["notify"] == false {
                        "🔕 Notifications off"
                    } else {
                        "🔔 Notifications on"
                    },
                    "nt",
                )],
                vec![btn(self.tr("Back", "Назад"), "h")],
            ],
        )
    }
    fn projects(&self) -> CoreResult {
        let ui = self.storage.ui();
        let mut rows = vec![];
        for project in arr(&ui["projects"]) {
            let mut value = project.clone();
            value["kind"] = json!("project");
            let reference = self.reference(value);
            rows.push(vec![btn(
                format!("📁 {}", s(project, "name")),
                format!("p:{reference}"),
            )]);
        }
        let mut seen = std::collections::HashSet::new();
        for session in arr(&self.history.list()?) {
            let cwd = s(session, "cwd");
            if !cwd.is_empty() && seen.insert(cwd.to_owned()) && seen.len() <= 8 {
                let reference=self.reference(json!({"kind":"folder","folder":cwd,"name":Path::new(cwd).file_name().unwrap_or_default().to_string_lossy()}));
                rows.push(vec![btn(
                    format!(
                        "📂 {}",
                        Path::new(cwd)
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                    ),
                    format!("p:{reference}"),
                )]);
            }
        }
        rows.push(vec![btn(self.tr("Back", "Назад"), "h")]);
        self.show(self.tr("Choose a project:", "Выбери проект:").into(), rows)
    }
    fn chats(&self, page: usize) -> CoreResult {
        let st = self.state();
        let cwd = st["project"]["folder"].as_str().unwrap_or("");
        let all = st["chatsScope"] == "all";
        let sessions = self.history.list()?;
        let list = arr(&sessions)
            .iter()
            .filter(|v| all || cwd.is_empty() || s(v, "cwd") == cwd)
            .take(80)
            .collect::<Vec<_>>();
        let mut rows = vec![];
        for session in list.iter().skip(page * 8).take(8) {
            let reference = self.reference((*session).clone());
            rows.push(vec![btn(
                clip(s(session, "title"), 60),
                format!("c:{reference}"),
            )]);
        }
        let mut pager = vec![];
        if page > 0 {
            pager.push(btn("←", format!("cl:{}", page - 1)))
        }
        if (page + 1) * 8 < list.len() {
            pager.push(btn("→", format!("cl:{}", page + 1)))
        }
        if !pager.is_empty() {
            rows.push(pager)
        }
        rows.push(vec![
            btn(
                if all {
                    "Only this project"
                } else {
                    "All projects"
                },
                "scope",
            ),
            btn(self.tr("Back", "Назад"), "h"),
        ]);
        self.show(self.tr("Choose a chat:", "Выбери чат:").into(), rows)
    }
    fn start_task(&self, text: &str) -> CoreResult {
        if self.live.lock().unwrap().thread.is_some() {
            return self.show(
                self.tr(
                    "Already working; stop the current turn first.",
                    "Уже работаю; сначала останови текущий ход.",
                )
                .into(),
                vec![vec![btn("⏹ Stop", "stop")]],
            );
        }
        let st = self.state();
        let ui = self.storage.ui();
        let project = &st["project"];
        let found = arr(&ui["projects"])
            .iter()
            .find(|p| p["id"] == project["id"] && !project["id"].is_null());
        let cwd = st["chat"]["cwd"]
            .as_str()
            .filter(|s| !s.is_empty())
            .or(project["folder"].as_str())
            .or_else(|| {
                found.and_then(|p| {
                    p["cwd"].as_str().or(p["path"].as_str()).or(p["folders"]
                        .as_array()
                        .and_then(|a| a.first())
                        .and_then(Value::as_str))
                })
            })
            .ok_or(self.tr("Choose a project first.", "Сначала выбери проект."))?;
        if !Path::new(cwd).is_dir() {
            return Err("Project folder does not exist".into());
        }
        let resume = st["chat"]["sessionId"].as_str();
        let provider = st["chat"]["provider"]
            .as_str()
            .or(st["agent"].as_str())
            .unwrap_or("claude");
        let thread = resume
            .map(str::to_owned)
            .unwrap_or_else(|| format!("tg-{}", uuid::Uuid::new_v4()));
        let mode = match st["mode"].as_str().unwrap_or("edits") {
            "ask" => "default",
            "full" => "bypassPermissions",
            _ => "acceptEdits",
        };
        let prompt = if let Some(quote) = st["quote"].as_str() {
            format!("{quote}\n\n{text}")
        } else {
            text.into()
        };
        let info = json!({"threadId":thread,"prompt":prompt,"cwd":cwd,"resume":resume,"provider":provider,"model":st["model"].as_str().unwrap_or("default"),"permissionMode":mode,"projectId":project["id"],"source":"telegram"});
        {
            let mut live = self.live.lock().unwrap();
            live.thread = Some(thread.clone());
            live.started = storage::now();
            live.progress.clear();
            live.message = None;
            live.permissions.clear();
        }
        let _=self.patch(&json!({"quote":null,"chat":{"sessionId":resume,"title":st["chat"]["title"].as_str().unwrap_or(&clip(text,80)),"cwd":cwd,"provider":provider}}));
        (self.emit)("desk:external-run", info);
        let sent = self.send(
            self.tr("⏳ Working…", "⏳ Работаю…"),
            Some(keyboard(vec![vec![btn("⏹ Stop", "stop")]])),
        )?;
        self.live.lock().unwrap().message = sent["message_id"].as_i64();
        self.update();
        Ok(json!(true))
    }
    fn stop_task(&self) -> CoreResult {
        let thread = self.live.lock().unwrap().thread.clone();
        if let Some(thread) = thread {
            self.agents.invoke("agent:interrupt", &[json!(thread)])?;
        }
        Ok(json!(true))
    }
    fn handle(self: &Arc<Self>, update: &Value) -> CoreResult {
        let (_, chat) = self.scheduler.config();
        if !update["callback_query"].is_null() {
            let cq = &update["callback_query"];
            let mut identity = cq["message"].clone();
            identity["from"] = cq["from"].clone();
            if !allowed(&identity, &chat) {
                return Ok(Value::Null);
            }
            let _ = self.scheduler.api(
                "answerCallbackQuery",
                &json!({"callback_query_id":cq["id"]}),
                10,
            );
            return self.callback(s(cq, "data"));
        }
        let message = &update["message"];
        if !allowed(message, &chat) {
            return Ok(Value::Null);
        }
        let online = self.live.lock().unwrap().online;
        if message["date"].as_u64().is_some_and(|ts| ts + 120 < online) {
            return Ok(Value::Null);
        }
        if !message["document"].is_null() || !arr(&message["photo"]).is_empty() {
            return self.upload(message);
        }
        let raw = message["text"]
            .as_str()
            .or(message["caption"].as_str())
            .unwrap_or("");
        let command = raw
            .split_whitespace()
            .next()
            .unwrap_or("")
            .split('@')
            .next()
            .unwrap_or("");
        match command{"/start"|"/menu"=>self.menu(),"/help"=>self.show(self.tr("Choose a project or chat, then send a message. /stop interrupts the current turn. Permissions can be answered here or in Duet.","Выбери проект или чат, затем отправь сообщение. /stop останавливает текущий ход. Разрешения можно подтверждать здесь или в Duet.").into(),vec![vec![btn("Menu","h")]]),"/projects"|"/project"=>self.projects(),"/chats"|"/chat"=>self.chats(0),"/new"=>{self.patch(&json!({"chat":null}))?;self.menu()},"/settings"|"/mode"=>self.settings(),"/status"=>self.show(format!("Duet\n{}",self.status()),vec![vec![btn("⏹ Stop","stop"),btn("Menu","h")]]),"/stop"=>self.stop_task(),_ if raw.starts_with("📁")=>self.projects(),_ if raw.starts_with("💬")=>self.chats(0),_ if raw.starts_with("➕")=>{self.patch(&json!({"chat":null}))?;self.menu()},_ if raw.starts_with('⚙')=>self.settings(),_ if raw.starts_with("📊")=>self.show(self.status().to_string(),vec![vec![btn("Menu","h")]]),_ if !raw.is_empty()=>self.start_task(raw),_=>Ok(Value::Null)}
    }
    fn callback(&self, data: &str) -> CoreResult {
        let (action, param) = data.split_once(':').unwrap_or((data, ""));
        match action {
            "h" => self.menu(),
            "pl" => self.projects(),
            "cl" => self.chats(param.parse().unwrap_or(0)),
            "p" => {
                let value = self
                    .live
                    .lock()
                    .unwrap()
                    .refs
                    .get(param)
                    .cloned()
                    .ok_or("This menu expired; open it again")?;
                self.patch(&json!({"project":if value["kind"]=="project"{json!({"id":value["id"]})}else{json!({"folder":value["folder"]})},"chat":null}))?;
                self.menu()
            }
            "c" => {
                let value = self
                    .live
                    .lock()
                    .unwrap()
                    .refs
                    .get(param)
                    .cloned()
                    .ok_or("This menu expired; open it again")?;
                self.patch(&json!({"chat":{"sessionId":value["sessionId"],"title":value["title"],"cwd":value["cwd"],"provider":value["provider"]}}))?;
                self.show(
                    format!("💬 {}\n{}", s(&value, "title"), s(&value, "cwd")),
                    vec![
                        vec![
                            btn("Continue", "h"),
                            btn("Last answer", format!("last:{param}")),
                        ],
                        vec![btn("Chats", "cl:0")],
                    ],
                )
            }
            "sc" => {
                let list = self.history.list()?;
                let value = arr(&list)
                    .iter()
                    .find(|s| s["sessionId"] == param)
                    .ok_or("Chat not found")?;
                self.patch(&json!({"chat":value}))?;
                self.menu()
            }
            "last" => {
                let value = self
                    .live
                    .lock()
                    .unwrap()
                    .refs
                    .get(param)
                    .cloned()
                    .ok_or("Menu expired")?;
                let page = self.history.load(
                    s(&value, "sessionId"),
                    Some(s(&value, "cwd")),
                    None,
                    s(&value, "provider"),
                    Some(&json!({"turns":1})),
                )?;
                let text = arr(&page["events"])
                    .iter()
                    .filter(|e| e["type"] == "text")
                    .map(|e| s(e, "text"))
                    .collect::<Vec<_>>()
                    .join("\n");
                self.send(&clip(&text, 3900), None)
            }
            "n" => {
                self.patch(&json!({"chat":null}))?;
                self.menu()
            }
            "set" => self.settings(),
            "ag" => {
                if !cli::IDS.contains(&param) {
                    return Err("Unknown provider".into());
                }
                self.patch(&json!({"agent":param,"chat":null,"model":"default"}))?;
                self.settings()
            }
            "md" => {
                self.patch(&json!({"model":clip(param,100)}))?;
                self.settings()
            }
            "mo" if param == "full" => self.show(
                self.tr(
                    "Full access allows commands and edits without asking. Enable it?",
                    "Полный доступ разрешает команды и изменения без подтверждения. Включить?",
                )
                .into(),
                vec![vec![
                    btn("Enable full access", "full:yes"),
                    btn("Cancel", "set"),
                ]],
            ),
            "full" if param == "yes" => {
                self.patch(&json!({"mode":"full"}))?;
                self.settings()
            }
            "mo" => {
                if !["ask", "edits"].contains(&param) {
                    return Err("Unknown permission mode".into());
                }
                self.patch(&json!({"mode":param}))?;
                self.settings()
            }
            "nt" => {
                let enabled = self.state()["notify"] == false;
                self.patch(&json!({"notify":enabled}))?;
                self.settings()
            }
            "scope" => {
                let all = self.state()["chatsScope"] != "all";
                self.patch(&json!({"chatsScope":if all{"all"}else{"project"}}))?;
                self.chats(0)
            }
            "st" => self.show(self.status().to_string(), vec![vec![btn("Menu", "h")]]),
            "stop" => self.stop_task(),
            "pa" => {
                let (key, decision) = param.split_once(':').ok_or("Invalid approval")?;
                let pending = self.live.lock().unwrap().permissions.remove(key);
                if let Some((thread, id)) = pending {
                    self.agents.invoke("agent:respondPermission",&[json!({"threadId":thread,"reqId":id,"decision":match decision{"allow"=>"allow","always"=>"always",_=>"deny"},"message":"The user denied this action from Telegram."})])?;
                }
                Ok(json!(true))
            }
            _ => self.menu(),
        }
    }
    fn deliver(&self, ch: &str, payload: &Value) -> CoreResult {
        if ch == "agent:permission" {
            if payload["toolName"] == "AskUserQuestion" {
                return self.agents.invoke("agent:respondPermission",&[json!({"threadId":payload["threadId"],"reqId":payload["reqId"],"decision":"deny","message":"The user is on Telegram. Continue with best judgment and state assumptions."})]);
            }
            let key = self.reference(payload.clone());
            self.live.lock().unwrap().permissions.insert(
                key.clone(),
                (s(payload, "threadId").into(), s(payload, "reqId").into()),
            );
            let mut buttons = vec![
                btn("Allow", format!("pa:{key}:allow")),
                btn("Deny", format!("pa:{key}:deny")),
            ];
            if payload["canAlways"] == true {
                buttons.push(btn("Always", format!("pa:{key}:always")))
            }
            return self.show(
                format!(
                    "🛡 {}\n{}\n{}",
                    s(payload, "toolName"),
                    s(payload, "description"),
                    clip(
                        &serde_json::to_string_pretty(&payload["input"]).unwrap_or_default(),
                        2500
                    )
                ),
                vec![buttons],
            );
        }
        if ch == "agent:permission-cancel" {
            self.live
                .lock()
                .unwrap()
                .permissions
                .retain(|_, (_, id)| id != s(payload, "reqId"));
            return Ok(Value::Null);
        }
        if ch == "agent:closed" || payload["ev"]["type"] == "turn.end" {
            let ev = &payload["ev"];
            let text = ev["text"]
                .as_str()
                .filter(|s| !s.is_empty())
                .or(ev["error"].as_str())
                .or(payload["error"].as_str())
                .unwrap_or(self.tr("Done.", "Готово."));
            let thread = {
                let mut live = self.live.lock().unwrap();
                live.message = None;
                live.permissions.clear();
                live.thread.take()
            };
            self.update();
            for chunk in text.chars().collect::<Vec<_>>().chunks(3800).take(4) {
                self.send(&chunk.iter().collect::<String>(), None)?;
            }
            if text.chars().count() > 12000 {
                let tmp = self.storage.data.join("native/telegram-answer.md");
                storage::atomic_write(&tmp, text.as_bytes())?;
                self.upload_document(&tmp, "answer.md")?;
            }
            if let Some(thread) = thread {
                let _ = self.agents.invoke("desk:release", &[json!(thread)]);
            }
            return Ok(json!(true));
        }
        Ok(Value::Null)
    }
    fn upload_document(&self, p: &Path, name: &str) -> CoreResult {
        let (token, chat) = self.scheduler.config();
        let bytes = storage::read_limited(p, 20 * 1024 * 1024)?;
        let boundary = format!("duet{}", uuid::Uuid::new_v4().simple());
        let mut body=format!("--{boundary}\r\nContent-Disposition: form-data; name=\"chat_id\"\r\n\r\n{chat}\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"document\"; filename=\"{name}\"\r\nContent-Type: text/markdown\r\n\r\n").into_bytes();
        body.extend(bytes);
        body.extend(format!("\r\n--{boundary}--\r\n").as_bytes());
        let response = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?
            .post(format!("https://api.telegram.org/bot{token}/sendDocument"))
            .header(
                "Content-Type",
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(body)
            .send()
            .map_err(|e| e.to_string().replace(&token, "***"))?;
        if !response.status().is_success() {
            return Err("Telegram document upload failed".into());
        }
        Ok(json!(true))
    }
    fn upload(&self, msg: &Value) -> CoreResult {
        let st = self.state();
        let cwd = st["chat"]["cwd"]
            .as_str()
            .or(st["project"]["folder"].as_str())
            .ok_or("Choose a project before sending files")?;
        let file = if msg["document"].is_null() {
            arr(&msg["photo"]).last().ok_or("Photo is empty")?
        } else {
            &msg["document"]
        };
        if file["file_size"].as_u64().unwrap_or(0) > 20 * 1024 * 1024 {
            return Err("Upload exceeds 20 MiB".into());
        }
        let meta = self
            .scheduler
            .api("getFile", &json!({"file_id":file["file_id"]}), 20)?;
        let remote = s(&meta, "file_path");
        if remote.contains("..") || remote.starts_with('/') || remote.contains(':') {
            return Err("Invalid Telegram file path".into());
        }
        let (token, _) = self.scheduler.config();
        let mut response = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(|e| e.to_string())?
            .get(format!("https://api.telegram.org/file/bot{token}/{remote}"))
            .send()
            .map_err(|e| e.to_string().replace(&token, "***"))?;
        if !response.status().is_success() {
            return Err("Could not download Telegram attachment".into());
        }
        let mut bytes = vec![];
        response
            .by_ref()
            .take(20 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Download failed")?;
        if bytes.len() > 20 * 1024 * 1024 {
            return Err("Upload exceeds 20 MiB".into());
        }
        let name = file["file_name"]
            .as_str()
            .unwrap_or("photo.jpg")
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || "._-".contains(*c))
            .take(120)
            .collect::<String>();
        let root = PathBuf::from(cwd).join(".claude-desk-uploads");
        if !Path::new(cwd).is_dir() {
            return Err("Project folder does not exist".into());
        }
        let p = root.join(format!("{}_{name}", uuid::Uuid::new_v4()));
        storage::atomic_write(&p, &bytes)?;
        let prompt = format!(
            "{}\n\nAttachment saved at: {}",
            msg["caption"]
                .as_str()
                .unwrap_or("Inspect this attachment."),
            p.display()
        );
        self.start_task(&prompt)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn remote_only_accepts_the_configured_private_user() {
        assert!(allowed(
            &json!({"chat":{"id":123,"type":"private"},"from":{"id":123}}),
            "123"
        ));
        assert!(!allowed(
            &json!({"chat":{"id":123,"type":"private"},"from":{"id":456}}),
            "123"
        ));
        assert!(!allowed(
            &json!({"chat":{"id":123,"type":"group"},"from":{"id":123}}),
            "123"
        ));
    }
}

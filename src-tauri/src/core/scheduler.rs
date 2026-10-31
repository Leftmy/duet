use super::{
    agents::Agents,
    cli,
    events::{arr, s},
    storage::{self, Storage},
    CoreResult, Emit,
};
use chrono::{Datelike, Local, TimeZone};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    io::Read,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
pub struct Scheduler {
    storage: Arc<Storage>,
    agents: Arc<Agents>,
    emit: Emit,
    pending: Mutex<HashSet<String>>,
    active: Mutex<HashSet<String>>,
    stopped: AtomicBool,
}
pub fn next(task: &Value, now: u64) -> Option<u64> {
    if task["enabled"] != true {
        return None;
    }
    let sc = &task["schedule"];
    if sc["type"] == "interval" {
        return Some(now + sc["minutes"].as_u64().unwrap_or(5).clamp(5, 44640) * 60000);
    }
    let time = s(sc, "time");
    let (h, m) = time.split_once(':')?;
    let h = h.parse::<u32>().ok()?;
    let m = m.parse::<u32>().ok()?;
    let now_date = Local.timestamp_millis_opt(now as i64).single()?;
    for i in 0..=7 {
        let d = now_date.date_naive() + chrono::Duration::days(i);
        let naive = d.and_hms_opt(h, m, 0)?;
        let local = Local.from_local_datetime(&naive).earliest();
        if let Some(dt) = local {
            let ms = dt.timestamp_millis() as u64;
            let day = dt.weekday().num_days_from_sunday();
            if ms > now
                && (arr(&sc["days"]).is_empty()
                    || arr(&sc["days"])
                        .iter()
                        .any(|d| d.as_u64() == Some(day as u64)))
            {
                return Some(ms);
            }
        }
    }
    None
}
fn normalize(sc: &Value) -> Result<Value, String> {
    match s(sc, "type") {
        "interval" => {
            let n = sc["minutes"].as_f64().ok_or("Invalid interval")?.round();
            if !(5.0..=44640.).contains(&n) {
                return Err("Interval must be 5 minutes to 31 days".into());
            }
            Ok(json!({"type":"interval","minutes":n as u64}))
        }
        "daily" => {
            let (h, m) = s(sc, "time").split_once(':').ok_or("Invalid daily time")?;
            let (h, m) = (
                h.parse::<u32>().map_err(|_| "Invalid time")?,
                m.parse::<u32>().map_err(|_| "Invalid time")?,
            );
            if h > 23 || m > 59 {
                return Err("Invalid daily time".into());
            }
            let mut days = arr(&sc["days"])
                .iter()
                .filter_map(Value::as_u64)
                .filter(|n| *n <= 6)
                .collect::<Vec<_>>();
            days.sort();
            days.dedup();
            if days.len() == 7 {
                days.clear()
            }
            Ok(json!({"type":"daily","time":format!("{h:02}:{m:02}"),"days":days}))
        }
        _ => Err("Unknown schedule type".into()),
    }
}
impl Scheduler {
    pub fn new(storage: Arc<Storage>, agents: Arc<Agents>, emit: Emit) -> Arc<Self> {
        Arc::new(Self {
            storage,
            agents,
            emit,
            pending: Mutex::new(HashSet::new()),
            active: Mutex::new(HashSet::new()),
            stopped: AtomicBool::new(false),
        })
    }
    pub fn initialize(&self) -> Result<(), String> {
        if !self.storage.data.join("schedules.json").is_file() {
            return Ok(());
        }
        self.storage.update("schedules.json", |v| {
            if let Some(tasks) = v["tasks"].as_array_mut() {
                for t in tasks {
                    t["running"] = json!(false);
                    if let Some(h) = t["history"].as_array_mut() {
                        h.truncate(20)
                    }
                    if t["enabled"] != true {
                        t["nextRun"] = Value::Null
                    } else if t["nextRun"].is_null() {
                        t["nextRun"] = json!(next(t, storage::now()))
                    }
                }
            }
            Ok(())
        })?;
        Ok(())
    }
    pub fn view(&self) -> Value {
        let state = self.storage.read("schedules.json");
        let active = self.active.lock().unwrap();
        let pending = self.pending.lock().unwrap();
        let tasks = arr(&state["tasks"])
            .iter()
            .map(|t| {
                let mut t = t.clone();
                let id = s(&t, "id").to_owned();
                t["running"] = json!(active.contains(&id));
                t["queued"] = json!(pending.contains(&id) && !active.contains(&id));
                t
            })
            .collect::<Vec<_>>();
        json!({"tasks":tasks,"settings":{"telegramChatId":s(&state["settings"],"telegramChatId"),"hasToken":!s(&state["settings"],"telegramToken").is_empty()}})
    }
    fn changed(&self) -> Value {
        let v = self.view();
        (self.emit)("sched:update", v.clone());
        v
    }
    pub fn config(&self) -> (String, String) {
        let s = self.storage.read("schedules.json");
        (
            s["settings"]["telegramToken"].as_str().unwrap_or("").into(),
            s["settings"]["telegramChatId"]
                .as_str()
                .unwrap_or("")
                .into(),
        )
    }
    pub fn api(&self, method: &str, params: &Value, timeout: u64) -> CoreResult {
        let (token, _) = self.config();
        if token.is_empty() {
            return Err("Telegram bot token is missing".into());
        }
        let url = format!("https://api.telegram.org/bot{token}/{method}");
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(timeout))
            .build()
            .map_err(|e| e.to_string())?;
        let response = client
            .post(url)
            .json(params)
            .send()
            .map_err(|e| e.to_string().replace(&token, "***"))?;
        let mut data = vec![];
        response
            .take(8 * 1024 * 1024 + 1)
            .read_to_end(&mut data)
            .map_err(|e| e.to_string().replace(&token, "***"))?;
        if data.len() > 8 * 1024 * 1024 {
            return Err("Telegram response is too large".into());
        }
        let data: Value = serde_json::from_slice(&data).map_err(|_| "Invalid Telegram response")?;
        if data["ok"] != true {
            return Err(data["description"]
                .as_str()
                .unwrap_or("Telegram request failed")
                .replace(&token, "***"));
        }
        Ok(data["result"].clone())
    }
    pub fn send_telegram(&self, text: &str, markup: Option<Value>) -> CoreResult {
        let (_, chat) = self.config();
        if chat.is_empty() {
            return Err("Telegram chat id is missing".into());
        }
        let mut params = json!({"chat_id":chat,"text":text.chars().take(3900).collect::<String>(),"disable_web_page_preview":true});
        if let Some(markup) = markup {
            params["reply_markup"] = markup
        }
        self.api("sendMessage", &params, 20)
    }
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Release)
    }
    pub fn tick(self: &Arc<Self>) {
        if self.stopped.load(Ordering::Acquire) {
            return;
        }
        let state = self.storage.read("schedules.json");
        let now = storage::now();
        let mut due = arr(&state["tasks"])
            .iter()
            .filter(|t| {
                let id = s(t, "id");
                !self.active.lock().unwrap().contains(id)
                    && (self.pending.lock().unwrap().contains(id)
                        || (t["enabled"] == true
                            && t["nextRun"].as_u64().is_some_and(|n| n <= now)))
            })
            .cloned()
            .collect::<Vec<_>>();
        due.sort_by_key(|t| {
            (
                !self.pending.lock().unwrap().contains(s(t, "id")),
                t["nextRun"].as_u64().unwrap_or(0),
            )
        });
        for task in due {
            let id = s(&task, "id").to_owned();
            {
                let mut active = self.active.lock().unwrap();
                if active.len() >= 2 {
                    break;
                }
                if !active.insert(id.clone()) {
                    continue;
                }
            }
            self.pending.lock().unwrap().remove(&id);
            self.changed();
            let owner = self.clone();
            std::thread::spawn(move || {
                owner.run(&task);
            });
        }
    }
    fn run(self: &Arc<Self>, task: &Value) {
        let started = storage::now();
        let mut spec = task.clone();
        spec["provider"] = json!(task["provider"].as_str().unwrap_or("claude"));
        let result = self.agents.headless(&spec, Duration::from_secs(30 * 60));
        let rec = match result {
            Ok(v) => {
                json!({"ts":started,"ok":v["isError"]!=true,"durationMs":storage::now()-started,"text":v["text"].as_str().or(v["error"].as_str()).unwrap_or("").chars().take(4000).collect::<String>(),"sessionId":v["sessionId"],"provider":spec["provider"],"costUsd":v["costUsd"]})
            }
            Err(e) => {
                json!({"ts":started,"ok":false,"durationMs":storage::now()-started,"text":e.chars().take(4000).collect::<String>(),"sessionId":null,"provider":spec["provider"]})
            }
        };
        let id = s(task, "id");
        let mut current = Value::Null;
        let _ = self.storage.update("schedules.json", |v| {
            if let Some(t) = v["tasks"]
                .as_array_mut()
                .and_then(|tasks| tasks.iter_mut().find(|t| s(t, "id") == id))
            {
                t["running"] = json!(false);
                t["lastRun"] = json!(started);
                let mut history = vec![rec.clone()];
                history.extend(arr(&t["history"]).iter().take(19).cloned());
                t["history"] = json!(history);
                t["nextRun"] = json!(next(t, storage::now()));
                current = t.clone();
            }
            Ok(())
        });
        self.active.lock().unwrap().remove(id);
        self.changed();
        if !current.is_null() {
            if current["notify"]["desktop"] == true {
                let _=self.agents.host("notification",json!({"title":current["name"],"body":s(&rec,"text").chars().take(200).collect::<String>()}));
            }
            let remote = self.storage.read("telegram.json");
            if current["notify"]["telegram"] == true && remote["notify"] != false {
                let markup = if remote["enabled"] == true && rec["sessionId"].is_string() {
                    Some(
                        json!({"inline_keyboard":[[{"text":"Continue","callback_data":format!("sc:{}",s(&rec,"sessionId"))}]]}),
                    )
                } else {
                    None
                };
                let _ = self.send_telegram(
                    &format!(
                        "{} {}\n\n{}",
                        if rec["ok"] == true { "✅" } else { "❌" },
                        s(&current, "name"),
                        s(&rec, "text")
                    ),
                    markup,
                );
            }
        }
        self.tick()
    }
    pub fn invoke(self: &Arc<Self>, ch: &str, args: &[Value]) -> CoreResult {
        let a = |i| args.get(i).unwrap_or(&Value::Null);
        let p = a(0);
        match ch {
            "sched:list" => Ok(self.view()),
            "sched:save" => {
                let name = s(p, "name").trim();
                let prompt = s(p, "prompt").trim();
                if name.is_empty() || prompt.is_empty() {
                    return Err("Name and prompt are required".into());
                }
                if prompt.len() > 1024 * 1024 {
                    return Err("Task prompt is too large".into());
                }
                let cwd = if s(p, "cwd").is_empty() {
                    self.storage.home.to_string_lossy().into_owned()
                } else {
                    s(p, "cwd").into()
                };
                if !std::path::Path::new(&cwd).is_dir() {
                    return Err("Project folder does not exist".into());
                }
                let schedule = normalize(&p["schedule"])?;
                let mut task = Value::Null;
                self.storage.update("schedules.json",|v|{if !v["tasks"].is_array(){v["tasks"]=json!([])}let tasks=v["tasks"].as_array_mut().unwrap();let previous=tasks.iter().find(|t|t["id"]==p["id"]&&!p["id"].is_null()).cloned().unwrap_or(Value::Null);if tasks.len()>=1000&&previous.is_null(){return Err("Too many scheduled tasks".into())}task=json!({"id":previous["id"].as_str().map(str::to_owned).unwrap_or(uuid::Uuid::new_v4().to_string()),"name":name.chars().take(120).collect::<String>(),"prompt":prompt,"cwd":cwd,"provider":if cli::IDS.contains(&s(p,"provider")){s(p,"provider")}else{"claude"},"model":p["model"].as_str().unwrap_or("default"),"effort":p["effort"],"permissionMode":if ["acceptEdits","default","bypassPermissions"].contains(&s(p,"permissionMode")){s(p,"permissionMode")}else{"acceptEdits"},"schedule":schedule,"enabled":p["enabled"].as_bool().unwrap_or(previous["enabled"].as_bool().unwrap_or(true)),"notify":{"desktop":p["notify"]["desktop"].as_bool().unwrap_or(true),"telegram":p["notify"]["telegram"]==true},"running":previous["running"]==true,"lastRun":previous["lastRun"],"history":arr(&previous["history"]),"createdAt":previous["createdAt"].as_u64().unwrap_or(storage::now())});task["nextRun"]=json!(next(&task,storage::now()));if let Some(index)=tasks.iter().position(|t|t["id"]==task["id"]){tasks[index]=task.clone()}else{tasks.push(task.clone())}Ok(())})?;
                self.changed();
                Ok(task)
            }
            "sched:delete" => {
                let id = p.as_str().unwrap_or("");
                let mut found = false;
                self.storage.update("schedules.json", |v| {
                    if let Some(tasks) = v["tasks"].as_array_mut() {
                        let n = tasks.len();
                        tasks.retain(|t| s(t, "id") != id);
                        found = n != tasks.len();
                    }
                    Ok(())
                })?;
                self.pending.lock().unwrap().remove(id);
                self.changed();
                Ok(json!(found))
            }
            "sched:toggle" => {
                let id = p.as_str().unwrap_or("");
                self.storage.update("schedules.json", |v| {
                    let t = v["tasks"]
                        .as_array_mut()
                        .and_then(|ts| ts.iter_mut().find(|t| s(t, "id") == id))
                        .ok_or("Task not found")?;
                    t["enabled"] = json!(a(1) == &true);
                    t["nextRun"] = json!(next(t, storage::now()));
                    Ok(())
                })?;
                self.changed();
                Ok(json!(true))
            }
            "sched:runNow" => {
                let id = p.as_str().unwrap_or("");
                if !arr(&self.storage.read("schedules.json")["tasks"])
                    .iter()
                    .any(|t| s(t, "id") == id)
                {
                    return Err("Task not found".into());
                }
                if self.active.lock().unwrap().contains(id) {
                    return Err("Task is already running".into());
                }
                self.pending.lock().unwrap().insert(id.into());
                self.tick();
                self.changed();
                let started = self.active.lock().unwrap().contains(id);
                Ok(json!({"started":started,"queued":!started}))
            }
            "sched:setTelegram" => {
                self.storage.update("schedules.json", |v| {
                    if !p["token"].is_null() {
                        let token = s(p, "token").trim();
                        if !token.is_empty()
                            && !regex::Regex::new(r"^\d+:[\w-]{20,}$")
                                .unwrap()
                                .is_match(token)
                        {
                            return Err("Invalid bot token format".into());
                        }
                        v["settings"]["telegramToken"] = json!(token)
                    }
                    if !p["chatId"].is_null() {
                        let chat = s(p, "chatId").trim();
                        if !chat.is_empty()
                            && !regex::Regex::new(r"^(-?\d+|@\w{4,})$")
                                .unwrap()
                                .is_match(chat)
                        {
                            return Err("Invalid chat id".into());
                        }
                        v["settings"]["telegramChatId"] = json!(chat)
                    }
                    Ok(())
                })?;
                Ok(self.changed()["settings"].clone())
            }
            "sched:telegramTest" => {
                self.send_telegram("Duet: Telegram notifications are working.", None)?;
                Ok(json!(true))
            }
            _ => Err(format!("Unknown scheduler channel {ch}")),
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn schedules_validate_and_daily_time_moves_past_now() {
        assert!(normalize(&json!({"type":"interval","minutes":4})).is_err());
        assert!(normalize(&json!({"type":"daily","time":"25:01"})).is_err());
        let n = storage::now();
        let t = json!({"enabled":true,"schedule":{"type":"daily","time":"12:30","days":[]}});
        let next = next(&t, n).unwrap();
        assert!(next > n && next - n <= 25 * 3600000);
    }
}

#[path = "browser.rs"]
mod browser;
use super::{
    agents::Agents,
    events::{arr, s},
    process,
    storage::{self, Storage},
    CoreResult, Emit,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

struct Detached {
    label: String,
    info: Value,
    ready: bool,
    reopen: bool,
    live: String,
}
pub struct Desktop {
    storage: Arc<Storage>,
    agents: Arc<Agents>,
    emit: Emit,
    browser: browser::Browsers,
    detached: Mutex<HashMap<String, Detached>>,
    pending_bounds: Mutex<HashMap<String, Value>>,
    started: u64,
    watched: Mutex<HashMap<String, Vec<Value>>>,
    fingerprints: Mutex<HashMap<String, (u64, u128)>>,
}
impl Desktop {
    pub fn new(storage: Arc<Storage>, agents: Arc<Agents>, emit: Emit) -> Self {
        Self {
            browser: browser::Browsers::new(storage.clone(), agents.clone(), emit.clone()),
            storage,
            agents,
            emit,
            detached: Mutex::new(HashMap::new()),
            pending_bounds: Mutex::new(HashMap::new()),
            started: storage::now(),
            watched: Mutex::new(HashMap::new()),
            fingerprints: Mutex::new(HashMap::new()),
        }
    }
    fn host(&self, method: &str, p: Value) -> CoreResult {
        self.agents.host(method, p)
    }
    fn op(&self, id: &str, op: &str, patch: Value) -> CoreResult {
        let mut p = patch;
        if !p.is_object() {
            p = json!({})
        }
        p["id"] = json!(id);
        p["op"] = json!(op);
        self.host("window.op", p)
    }
    pub fn boot(&self) -> CoreResult {
        let s = self.storage.settings();
        let mut options = s["windowBounds"].clone();
        if !options.is_object() {
            options = json!({"width":1380,"height":880})
        }
        options["minWidth"] = json!(860);
        options["minHeight"] = json!(560);
        self.host(
            "window.create",
            json!({"id":"main","kind":"window","options":options}),
        )?;
        if s["maximized"] == true {
            self.op("main", "maximize", Value::Null)?;
        }
        Ok(Value::Null)
    }
    pub fn dispose(&self, key: &str) {
        self.browser.dispose(key);
    }
    pub fn browser_tool(&self, p: &Value) -> CoreResult {
        self.browser.tool(p)
    }
    pub fn maintain_browser(&self) {
        self.browser.maintain();
    }
    pub fn flush_browser(&self) {
        self.browser.flush();
    }
    pub fn native_event(&self, id: &str, event: &str, data: Value) {
        if matches!(event, "bounds" | "window-state") {
            let mut pending = self.pending_bounds.lock().unwrap();
            let current = pending.entry(id.into()).or_insert_with(|| json!({}));
            if event == "bounds" {
                current["bounds"] = data;
            } else {
                storage::merge(current, &data);
            }
            return;
        }
        if event == "closed" {
            self.flush_bounds();
            self.watched
                .lock()
                .unwrap()
                .retain(|key, _| !key.starts_with(&format!("{id}:")));
        }

        if id == "main" {
            if event == "ready" {
                let _ = self.op(id, "show", Value::Null);
            }
            if event == "window-state" {
                let _ = self.storage.update("settings.json", |s| {
                    s["maximized"] = data["maximized"].clone();
                    if data["maximized"] != true
                        && data["minimized"] != true
                        && data["bounds"].is_object()
                    {
                        s["windowBounds"] = data["bounds"].clone()
                    }
                    Ok(())
                });
            }
            if event == "closed" {
                self.browser.flush();
                let labels = self
                    .detached
                    .lock()
                    .unwrap()
                    .values()
                    .map(|w| w.label.clone())
                    .collect::<Vec<_>>();
                for label in labels {
                    let _ = self.op(&label, "close", Value::Null);
                }
                self.agents.shutdown();
                let _ = self.host("app.quit", Value::Null);
            }
            return;
        }
        if self.browser.native_event(id, event, &data) {
            return;
        }
        let key = self
            .detached
            .lock()
            .unwrap()
            .iter()
            .find(|(_, w)| w.label == id)
            .map(|(k, _)| k.clone());
        if let Some(key) = key {
            match event {
                "ready" => {
                    let _ = self.op(id, "show", Value::Null);
                }
                "window-state" => {
                    let _=self.storage.update("detached.json",|s|{s[&key]=json!({"maximized":data["maximized"],"bounds":data["bounds"],"at":storage::now()});if let Some(map)=s.as_object_mut(){while map.len()>200{if let Some(k)=map.iter().min_by_key(|(_,v)|v["at"].as_u64().unwrap_or(0)).map(|(k,_)|k.clone()){map.remove(&k);}}}Ok(())});
                }
                "closed" => {
                    let rec = self.detached.lock().unwrap().remove(&key);
                    if let Some(rec) = rec {
                        if !rec.live.is_empty() {
                            let _ = self.agents.invoke("agent:closeThread", &[json!(rec.live)]);
                        }
                        if rec.ready {
                            (self.emit)(
                                "win:reattached",
                                json!({"sessionId":rec.info["sessionId"],"threadId":rec.info["threadId"],"open":rec.reopen}),
                            );
                        }
                    }
                }
                _ => {}
            }
        }
    }
    pub fn invoke(&self, window: &str, ch: &str, args: &[Value]) -> CoreResult {
        let a = |i| args.get(i).unwrap_or(&Value::Null);
        let p = a(0);
        match ch{
 channel if channel.starts_with("browser:")=>self.browser.invoke(channel,args),
 "app:pickFolder"=>self.host("dialog.open",Value::Null),"app:openExternal"=>{let target=p.as_str().unwrap_or("");if !url::Url::parse(target).is_ok_and(|u|matches!(u.scheme(),"http"|"https"|"mailto")){return Err("Expected an HTTP(S) or mailto URL".into())}self.host("shell.open",json!({"target":target}))},"app:openPath"=>self.host("shell.open",json!({"target":p})),"app:showInFolder"=>self.host("shell.reveal",json!({"target":p})),
 "app:openTargets"=>Ok(json!(open_targets())),"app:openIn"=>{let id=p.as_str().unwrap_or("");let cwd=a(1).as_str().unwrap_or("");if !Path::new(cwd).is_dir(){return Ok(json!(false))}let targets=open_targets();let Some(target)=targets.iter().find(|t|t["id"]==id)else{return Ok(json!(false))};if id=="explorer"{self.host("shell.open",json!({"target":cwd}))?;}else{launch_target(target,cwd)?;}Ok(json!(true))},
 "app:setTheme"|"win:setTheme"=>{let color=if p=="light"{"#ffffff"}else{"#181818"};if ch=="app:setTheme"{self.storage.update("settings.json",|v|{v["resolvedTheme"]=p.clone();Ok(())})?;}self.op(window,"background",json!({"color":color}))?;Ok(json!(true))},
 "voice:ping"=>Ok(json!(true)),"desk:notification"=>self.host("notification",p.clone()),"desk:ui-error"=>{let record=json!({"ts":storage::now(),"type":"ui-error","message":s(p,"message").chars().take(2000).collect::<String>(),"stack":s(p,"stack").chars().take(4000).collect::<String>()});let path=self.storage.data.join("diagnostics.log");if std::fs::metadata(&path).is_ok_and(|m|m.len()>2*1024*1024){let _=std::fs::rename(&path,self.storage.data.join("diagnostics.previous.log"));}use std::io::Write;let mut f=std::fs::OpenOptions::new().create(true).append(true).open(path).map_err(|e|e.to_string())?;writeln!(f,"{record}").map_err(|e|e.to_string())?;Ok(Value::Null)},
 "app:buildInfo"=>{let newer=std::fs::metadata(self.storage.runtime.join("dist/index.html")).ok().and_then(|m|m.modified().ok()).and_then(|t|t.duration_since(std::time::UNIX_EPOCH).ok()).is_some_and(|t|t.as_millis()as u64>self.started+2000);Ok(json!({"canRebuild":self.storage.runtime.join("package.json").is_file(),"newer":newer}))},"app:rebuild"=>{let npm=process::resolve("npm").ok_or("npm is not installed")?;process::run(&npm,&["run".into(),"build".into()],Some(&self.storage.runtime),None,Duration::from_secs(300),process::MAX_OUTPUT)?.text()?;Ok(json!(true))},"app:relaunch"=>self.host("app.relaunch",Value::Null),
 "desk:watch"=>{let key=p.as_str().unwrap_or("");if key.len()>256||arr(a(1)).len()>500{return Err("Too many session watches".into())}let mut watched=self.watched.lock().unwrap();if arr(a(1)).is_empty(){watched.remove(&format!("{window}:{key}"));}else{watched.insert(format!("{window}:{key}"),arr(a(1)).to_vec());}Ok(json!(true))},
 "win:detach"=>{let tid=s(p,"threadId");if tid.is_empty(){return Err("No chat to detach".into())}if self.agents.running(tid){return Err("Chat is busy".into())}let key=p["sessionId"].as_str().filter(|s|!s.is_empty()).unwrap_or(tid);let existing=self.detached.lock().unwrap().get(key).map(|w|w.label.clone());if let Some(label)=existing{self.op(&label,"restore",Value::Null)?;self.op(&label,"show",Value::Null)?;self.op(&label,"focus",Value::Null)?;return Ok(json!({"ok":true,"existing":true}))}let label=format!("chat-{}",uuid::Uuid::new_v4());self.detached.lock().unwrap().insert(key.into(),Detached{label:label.clone(),info:p.clone(),ready:false,reopen:false,live:String::new()});let saved=self.storage.read("detached.json");let mut options=saved[key]["bounds"].clone();if !options.is_object(){options=json!({"width":900,"height":800})}options["title"]=p["title"].clone();options["minWidth"]=json!(560);options["minHeight"]=json!(480);let hash=format!("detached={}",url::form_urlencoded::byte_serialize(key.as_bytes()).collect::<String>());if let Err(e)=self.host("window.create",json!({"id":label,"kind":"window","options":options,"hash":hash})){self.detached.lock().unwrap().remove(key);return Err(e)}if saved[key]["maximized"]==true{self.op(&label,"maximize",Value::Null)?;}Ok(json!({"ok":true}))},
 "win:list"=>Ok(json!(self.detached.lock().unwrap().iter().map(|(key,w)|json!({"key":key,"threadId":w.info["threadId"],"sessionId":w.info["sessionId"],"ready":w.ready})).collect::<Vec<_>>())),
 "win:focus"=>{let label=self.detached.lock().unwrap().get(p.as_str().unwrap_or("")).map(|w|w.label.clone());if let Some(label)=label{self.op(&label,"restore",Value::Null)?;self.op(&label,"show",Value::Null)?;self.op(&label,"focus",Value::Null)?;Ok(json!(true))}else{Ok(json!(false))}},
 "win:info"|"win:ready"|"win:close"|"win:reattach"|"win:handoff"=>{let mut windows=self.detached.lock().unwrap();let rec=windows.values_mut().find(|w|w.label==window).ok_or("Only a detached chat window can call this method")?;match ch{
 "win:info"=>Ok(rec.info.clone()),"win:ready"=>{let old=s(&rec.info,"threadId").to_owned();let session=s(&rec.info,"sessionId").to_owned();let already=rec.ready;rec.ready=true;rec.live=s(p,"threadId").into();let live=rec.live.clone();drop(windows);if !already{if old!=live{self.agents.invoke("agent:closeThread",&[json!(old)])?;}(self.emit)("win:detached",json!({"threadId":old,"sessionId":session}));}Ok(json!(true))},
 "win:close"|"win:reattach"=>{rec.reopen=ch=="win:reattach";drop(windows);self.op(window,"close",Value::Null)?;if ch=="win:reattach"{self.op("main","restore",Value::Null)?;self.op("main","focus",Value::Null)?;}Ok(json!(true))},
 "win:handoff"=>{drop(windows);if s(p,"sessionId").is_empty(){return Ok(json!(false))}(self.emit)("win:open",p.clone());self.op("main","restore",Value::Null)?;self.op("main","focus",Value::Null)?;Ok(json!(true))},_=>unreachable!()}},
 _=>Err(format!("No native desktop handler for {ch}"))}
    }
    pub fn flush_bounds(&self) {
        let pending = std::mem::take(&mut *self.pending_bounds.lock().unwrap());
        for (id, data) in pending {
            if id == "main" {
                let _ = self.storage.update("settings.json", |s| {
                    if let Some(v) = data.get("maximized") {
                        s["maximized"] = v.clone();
                    }
                    if let Some(v) = data.get("fullscreen") {
                        s["fullscreen"] = v.clone();
                    }
                    if s["maximized"] != true
                        && s["fullscreen"] != true
                        && data["minimized"] != true
                        && data["bounds"].is_object()
                    {
                        s["windowBounds"] = data["bounds"].clone()
                    }
                    Ok(())
                });
            } else {
                let key = self
                    .detached
                    .lock()
                    .unwrap()
                    .iter()
                    .find(|(_, w)| w.label == id)
                    .map(|(k, _)| k.clone());
                if let Some(key) = key {
                    let _=self.storage.update("detached.json",|s|{let previous=s[&key].clone();let bounds=if data["maximized"]!=true&&data["minimized"]!=true&&data["bounds"].is_object(){&data["bounds"]}else{&previous["bounds"]};s[&key]=json!({"maximized":data["maximized"].as_bool().unwrap_or(previous["maximized"]==true),"bounds":bounds,"at":storage::now()});Ok(())});
                }
            }
        }
    }
    pub fn watches(&self) -> Vec<Value> {
        self.watched
            .lock()
            .unwrap()
            .values()
            .flatten()
            .cloned()
            .collect()
    }
    pub fn check_watch(&self, item: &Value, path: Option<PathBuf>) {
        let key = format!("{}:{}", s(item, "provider"), s(item, "sessionId"));
        let current = path
            .and_then(|p| std::fs::metadata(p).ok())
            .map(|m| {
                (
                    m.len(),
                    m.modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_nanos())
                        .unwrap_or(0),
                )
            })
            .unwrap_or_default();
        let previous = self.fingerprints.lock().unwrap().insert(key, current);
        if previous.is_some_and(|p| p != current)
            && !self
                .agents
                .recently_active(s(item, "threadId"), s(item, "sessionId"))
        {
            let mut payload = item.clone();
            payload["at"] = json!(storage::now());
            (self.emit)("desk:session-changed", payload);
        }
    }
}
fn normalize(url: &str) -> Result<String, String> {
    let u = url.trim();
    if u.starts_with("http://")
        || u.starts_with("https://")
        || u.starts_with("file://")
        || u == "about:blank"
    {
        return Ok(u.into());
    }
    if u.starts_with("localhost") {
        return Ok(format!("http://{u}"));
    }
    if !u.contains(' ') && u.split('/').next().is_some_and(|p| p.contains('.')) {
        return Ok(format!("https://{u}"));
    }
    Ok(format!(
        "https://www.google.com/search?q={}",
        url::form_urlencoded::byte_serialize(u.as_bytes()).collect::<String>()
    ))
}
fn open_targets() -> Vec<Value> {
    let mut out =
        vec![json!({"id":"explorer","label":if cfg!(windows){"Explorer"}else{"File manager"}})];
    for (id, name, label) in [
        ("vscode", "code", "VS Code"),
        ("cursor", "cursor", "Cursor"),
        ("windsurf", "windsurf", "Windsurf"),
    ] {
        if let Some(p) = process::which(name) {
            out.push(json!({"id":id,"label":label,"application":p}))
        }
    }
    let toolbox = if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .map(|p| p.join("JetBrains/Toolbox/scripts"))
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|p| PathBuf::from(p).join(".local/share")))
            .map(|p| p.join("JetBrains/Toolbox/scripts"))
    };
    if let Some(dir) = toolbox {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten().take(1000) {
                let file = entry.path();
                let name = file
                    .file_stem()
                    .and_then(|p| p.to_str())
                    .unwrap_or("")
                    .to_lowercase();
                let label = match name.as_str() {
                    "idea" => "IntelliJ IDEA",
                    "webstorm" => "WebStorm",
                    "goland" => "GoLand",
                    "pycharm" => "PyCharm",
                    "phpstorm" => "PhpStorm",
                    "rider" => "Rider",
                    "clion" => "CLion",
                    "rustrover" => "RustRover",
                    "studio" => "Android Studio",
                    _ => continue,
                };
                if file.is_file() {
                    out.push(json!({"id":format!("jb:{name}"),"label":label,"application":file}));
                }
            }
        }
    }
    let terminal = if cfg!(windows) {
        process::which("wt").or_else(|| process::which("powershell"))
    } else {
        [
            "x-terminal-emulator",
            "gnome-terminal",
            "ptyxis",
            "konsole",
            "xfce4-terminal",
            "kitty",
            "alacritty",
            "wezterm",
            "tilix",
            "xterm",
        ]
        .iter()
        .find_map(|n| process::which(n))
    };
    if let Some(p) = terminal {
        out.push(json!({"id":"terminal","label":"Terminal","application":p}))
    }
    out
}
fn launch_target(target: &Value, cwd: &str) -> CoreResult {
    let program = process::Program::new(s(target, "application"));
    let name = program
        .bin
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let args = if target["id"] != "terminal" {
        vec![cwd.into()]
    } else {
        terminal_args(name, cwd)
    };
    let mut command = program.command();
    command
        .args(args)
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    if name.eq_ignore_ascii_case("powershell") {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x00000010);
    }
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(json!(true))
}
fn terminal_args(name: &str, cwd: &str) -> Vec<String> {
    let flags: Vec<&str> = match name {
        "wt" => vec!["-d", cwd],
        "powershell" => vec!["-NoExit"],
        "konsole" => vec!["--workdir", cwd],
        "kitty" => vec!["--directory", cwd],
        "wezterm" => vec!["start", "--cwd", cwd],
        "xterm" => vec![],
        "ptyxis" => vec!["--new-window", "--working-directory", cwd],
        _ => vec!["--working-directory", cwd],
    };
    flags.into_iter().map(str::to_owned).collect()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn external_terminal_paths_are_separate_arguments() {
        let path = "/project with spaces/тест";
        assert_eq!(terminal_args("wt", path), vec!["-d", path]);
        assert_eq!(terminal_args("konsole", path), vec!["--workdir", path]);
        assert_eq!(terminal_args("wezterm", path), vec!["start", "--cwd", path]);
    }
}

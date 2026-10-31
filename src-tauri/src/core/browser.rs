//! Chat-owned browser tabs. Sleeping tabs retain metadata, never a hidden renderer.
use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Condvar;
use std::time::Instant;

const SOFT_LIVE: usize = 8;
const HARD_LIVE: usize = 32;
const MAX_TABS: usize = 32;
const MAX_TOTAL: usize = 256;
pub(super) struct Browsers {
    storage: Arc<Storage>,
    agents: Arc<Agents>,
    emit: Emit,
    spaces: Mutex<HashMap<String, Space>>,
    active: Mutex<Active>,
    admission: Mutex<()>,
    dirty: AtomicBool,
}
struct Space {
    tabs: Vec<Arc<Tab>>,
    selected: String,
    touched: u64,
}
struct Active {
    key: Option<String>,
    visible: bool,
    bounds: Value,
}
struct Tab {
    id: String,
    operation: Mutex<()>,
    data: Mutex<Page>,
    ready: Condvar,
}
struct Page {
    label: Option<String>,
    url: String,
    title: String,
    loading: bool,
    pinned: bool,
    visible: bool,
    used: u64,
    hidden: u64,
    reason: String,
    protected: Option<String>,
    downloads: usize,
    scroll: (f64, f64),
    restore: bool,
    ignore_blank: bool,
    history: Vec<String>,
    index: usize,
    pending_index: Option<usize>,
}
impl Tab {
    fn new(url: String) -> Arc<Self> {
        let now = storage::now();
        Arc::new(Self {
            id: uuid::Uuid::new_v4().to_string(),
            operation: Mutex::new(()),
            data: Mutex::new(Page {
                label: None,
                title: String::new(),
                url: url.clone(),
                loading: false,
                pinned: false,
                visible: false,
                used: now,
                hidden: now,
                reason: "new".into(),
                protected: None,
                downloads: 0,
                scroll: (0., 0.),
                restore: false,
                ignore_blank: false,
                history: vec![url],
                index: 0,
                pending_index: None,
            }),
            ready: Condvar::new(),
        })
    }
    fn state(&self) -> Value {
        let p = self.data.lock().unwrap();
        json!({"id":self.id,"url":p.url,"title":p.title,"loading":p.loading,"sleeping":p.label.is_none(),"sleepReason":p.reason,"pinned":p.pinned,"protectedReason":p.protected,"canGoBack":p.index>0,"canGoForward":p.index+1<p.history.len()})
    }
}
impl Browsers {
    pub(super) fn new(storage: Arc<Storage>, agents: Arc<Agents>, emit: Emit) -> Self {
        Self {
            storage,
            agents,
            emit,
            spaces: Mutex::new(HashMap::new()),
            active: Mutex::new(Active {
                key: None,
                visible: false,
                bounds: json!({"x":0,"y":0,"width":1000,"height":700}),
            }),
            admission: Mutex::new(()),
            dirty: AtomicBool::new(false),
        }
    }
    fn host(&self, method: &str, p: Value) -> CoreResult {
        self.agents.host(method, p)
    }
    fn op(&self, id: &str, operation: &str, patch: Value) -> CoreResult {
        let mut p = if patch.is_object() { patch } else { json!({}) };
        p["id"] = json!(id);
        p["op"] = json!(operation);
        self.host("window.op", p)
    }
    fn all(&self) -> Vec<(String, Arc<Tab>)> {
        self.spaces
            .lock()
            .unwrap()
            .iter()
            .flat_map(|(key, space)| {
                space
                    .tabs
                    .iter()
                    .map(|tab| (key.clone(), tab.clone()))
                    .collect::<Vec<_>>()
            })
            .collect()
    }
    fn ensure_space(&self, key: &str) -> Result<(), String> {
        if key.is_empty() || key.len() > 256 {
            return Err("Invalid browser chat id".into());
        }
        if self.spaces.lock().unwrap().contains_key(key) {
            return Ok(());
        }
        let saved = self.storage.read("native/browser-tabs.json")[key].clone();
        let mut spaces = self.spaces.lock().unwrap();
        if spaces.contains_key(key) {
            return Ok(());
        }
        if spaces.len() >= 64 {
            return Err("Too many browser chats; close unused chats".into());
        }
        let remaining =
            MAX_TOTAL.saturating_sub(spaces.values().map(|s| s.tabs.len()).sum::<usize>());
        if remaining == 0 {
            return Err("Too many browser tabs".into());
        }
        let mut tabs = Vec::new();
        for record in arr(&saved["tabs"]).iter().take(MAX_TABS.min(remaining)) {
            let Ok(url) = address(s(record, "url")) else {
                continue;
            };
            let mut tab = Tab::new(url);
            if uuid::Uuid::parse_str(s(record, "id")).is_ok() {
                Arc::get_mut(&mut tab).unwrap().id = s(record, "id").into();
            }
            {
                let mut p = tab.data.lock().unwrap();
                p.title = s(record, "title").chars().take(512).collect();
                p.pinned = record["pinned"] == true;
                p.reason = "session".into();
                p.scroll = (finite(&record["scrollX"]), finite(&record["scrollY"]));
                p.restore = true;
                let history = arr(&record["history"])
                    .iter()
                    .filter_map(Value::as_str)
                    .filter_map(|v| address(v).ok())
                    .take(20)
                    .collect::<Vec<_>>();
                if !history.is_empty() {
                    p.history = history;
                    p.index = record["index"]
                        .as_u64()
                        .unwrap_or(0)
                        .min(p.history.len().saturating_sub(1) as u64)
                        as usize;
                }
            }
            tabs.push(tab);
        }
        if tabs.is_empty() {
            tabs.push(Tab::new("https://www.google.com/".into()));
        }
        let selected = tabs
            .iter()
            .find(|t| t.id == s(&saved, "selected"))
            .unwrap_or(&tabs[0])
            .id
            .clone();
        spaces.insert(
            key.into(),
            Space {
                tabs,
                selected,
                touched: storage::now(),
            },
        );
        Ok(())
    }
    fn find(&self, key: &str, selector: Option<&str>) -> Result<Arc<Tab>, String> {
        self.ensure_space(key)?;
        let spaces = self.spaces.lock().unwrap();
        let space = spaces.get(key).ok_or("Unknown browser chat")?;
        let id = selector.unwrap_or(&space.selected);
        space
            .tabs
            .iter()
            .find(|tab| tab.id == id)
            .cloned()
            .ok_or("Unknown tab in this chat".into())
    }
    fn state(&self, key: &str) -> Value {
        let snapshot = self
            .spaces
            .lock()
            .unwrap()
            .get(key)
            .map(|space| (space.selected.clone(), space.tabs.clone()));
        let Some((selected, tabs)) = snapshot else {
            return json!({"url":"","title":"","loading":false,"canGoBack":false,"canGoForward":false,"tabs":[],"activeTabId":null});
        };
        let mut state = tabs
            .iter()
            .find(|t| t.id == selected)
            .map(|t| t.state())
            .unwrap_or(json!({}));
        state["activeTabId"] = json!(selected);
        state["tabs"] = json!(tabs.iter().map(|t| t.state()).collect::<Vec<_>>());
        state
    }
    fn push(&self, key: &str) {
        let mut state = self.state(key);
        state["key"] = json!(key);
        (self.emit)("browser:state", state);
    }
    fn changed(&self, key: &str) {
        self.dirty.store(true, Ordering::Release);
        self.push(key);
    }
    fn attach(&self) -> CoreResult {
        let (key, visible, bounds) = {
            let a = self.active.lock().unwrap();
            (a.key.clone(), a.visible, a.bounds.clone())
        };
        let selected = key.as_ref().and_then(|k| {
            self.spaces
                .lock()
                .unwrap()
                .get(k)
                .map(|s| s.selected.clone())
        });
        for (owner, tab) in self.all() {
            let show = visible
                && key.as_deref() == Some(&owner)
                && selected.as_deref() == Some(&tab.id)
                && bounds["width"].as_f64().unwrap_or(0.) > 0.
                && bounds["height"].as_f64().unwrap_or(0.) > 0.;
            let (label, changed) = {
                let mut p = tab.data.lock().unwrap();
                let was = p.visible;
                if was && !show {
                    p.hidden = storage::now();
                }
                p.visible = show && p.label.is_some();
                (p.label.clone(), was != p.visible)
            };
            if let Some(label) = label {
                if show {
                    self.op(&label, "bounds", bounds.clone())?;
                }
                if changed {
                    self.op(&label, if show { "show" } else { "hide" }, Value::Null)?;
                }
            }
        }
        Ok(Value::Null)
    }
    fn awake(&self, key: &str, tab: &Arc<Tab>) -> Result<String, String> {
        if !self
            .spaces
            .lock()
            .unwrap()
            .get(key)
            .is_some_and(|space| space.tabs.iter().any(|t| Arc::ptr_eq(t, tab)))
        {
            return Err("Tab was closed".into());
        }
        {
            let mut p = tab.data.lock().unwrap();
            p.used = storage::now();
            if let Some(label) = &p.label {
                return Ok(label.clone());
            }
        }
        let _admission = self.admission.lock().unwrap();
        if self.idle_minutes() > 0. {
            self.trim(SOFT_LIVE - 1);
        }
        if self
            .all()
            .iter()
            .filter(|(_, t)| t.data.lock().unwrap().label.is_some())
            .count()
            >= HARD_LIVE
        {
            return Err("Too many protected live pages; sleep or close unused tabs".into());
        }
        let label = format!("browser-{}", uuid::Uuid::new_v4());
        let url = {
            let mut p = tab.data.lock().unwrap();
            p.label = Some(label.clone());
            p.loading = true;
            p.reason.clear();
            p.ignore_blank = p.url != "about:blank";
            p.url.clone()
        };
        let create = self
            .host(
                "window.create",
                json!({"id":label,"kind":"view","options":{}}),
            )
            .and_then(|_| {
                let bounds = self.active.lock().unwrap().bounds.clone();
                self.op(&label, "bounds", bounds)?;
                self.op(&label, "navigate", json!({"url":url}))
            });
        if let Err(error) = create {
            {
                let mut p = tab.data.lock().unwrap();
                p.label = None;
                p.loading = false;
                p.reason = "error".into();
            }
            let _ = self.op(&label, "close", Value::Null);
            self.push(key);
            return Err(error);
        }
        self.attach()?;
        self.push(key);
        Ok(label)
    }
    fn new_tab(&self, key: &str, url: &str, background: bool) -> CoreResult {
        self.ensure_space(key)?;
        let url = address(url)?;
        let tab = Tab::new(url);
        {
            let _admission = self.admission.lock().unwrap();
            let mut spaces = self.spaces.lock().unwrap();
            if spaces.values().map(|s| s.tabs.len()).sum::<usize>() >= MAX_TOTAL {
                return Err("Too many browser tabs".into());
            }
            let space = spaces.get_mut(key).ok_or("Browser chat was closed")?;
            if space.tabs.len() >= MAX_TABS {
                return Err("This chat has 32 tabs; close unused tabs".into());
            }
            space.tabs.push(tab.clone());
            if !background {
                space.selected = tab.id.clone();
            }
            space.touched = storage::now();
        }
        self.changed(key);
        if !background {
            self.select(key, &tab.id)?;
        }
        let mut state = self.state(key);
        state["createdTabId"] = json!(tab.id);
        Ok(state)
    }
    fn select(&self, key: &str, id: &str) -> CoreResult {
        let tab = self.find(key, Some(id))?;
        let _operation = tab.operation.lock().unwrap();
        {
            let mut spaces = self.spaces.lock().unwrap();
            let space = spaces.get_mut(key).ok_or("Browser chat was closed")?;
            if !space.tabs.iter().any(|t| Arc::ptr_eq(t, &tab)) {
                return Err("Tab was closed".into());
            }
            space.selected = id.into();
            space.touched = storage::now();
        }
        self.attach()?;
        self.awake(key, &tab)?;
        self.changed(key);
        Ok(self.state(key))
    }
    fn navigate(&self, key: &str, url: &str, selector: Option<&str>) -> CoreResult {
        let url = address(url)?;
        let tab = self.find(key, selector)?;
        let _operation = tab.operation.lock().unwrap();
        let old = {
            let mut p = tab.data.lock().unwrap();
            p.used = storage::now();
            p.pending_index = None;
            let label = p.label.clone();
            p.url = url.clone();
            p.loading = true;
            label
        };
        if let Some(label) = old {
            self.op(&label, "navigate", json!({"url":url}))?;
        } else {
            self.awake(key, &tab)?;
        }
        if selector.is_none() {
            (self.emit)("browser:show", json!({"key":key}));
        }
        self.changed(key);
        Ok(self.state(key))
    }
    fn probe(&self, label: &str) -> CoreResult {
        self.op(
            label,
            "probe",
            json!({"code":include_str!("browser_probe.js")}),
        )
    }
    fn sleep_locked(
        &self,
        key: &str,
        tab: &Arc<Tab>,
        force: bool,
        reason: &str,
    ) -> Result<bool, String> {
        let label = {
            let p = tab.data.lock().unwrap();
            if p.label.is_none() {
                return Ok(false);
            }
            p.label.clone().unwrap()
        };
        let probe = if force {
            let p = tab.data.lock().unwrap();
            json!({"url":p.url,"title":p.title,"x":p.scroll.0,"y":p.scroll.1})
        } else {
            self.probe(&label)?
        };
        if !force && (!probe["dirty"].is_boolean() || !probe["media"].is_boolean()) {
            return Err("Could not inspect page state; sleep skipped".into());
        }
        let blocked = {
            let p = tab.data.lock().unwrap();
            if probe["dirty"] == true {
                Some("input")
            } else if probe["media"] == true {
                Some("media")
            } else if p.downloads > 0 {
                Some("download")
            } else {
                None
            }
        };
        if let Some(blocked) = blocked {
            if !force {
                tab.data.lock().unwrap().protected = Some(blocked.into());
                self.push(key);
                return Err(format!("Protected tab: {blocked}"));
            }
        }
        // Keep the generation label until native close succeeds; failed disposal remains visible.
        self.op(&label, "close", Value::Null)?;
        {
            let mut p = tab.data.lock().unwrap();
            p.label = None;
            p.loading = false;
            p.visible = false;
            p.reason = reason.into();
            p.protected = None;
            p.downloads = 0;
            p.scroll = (finite(&probe["x"]), finite(&probe["y"]));
            p.restore = true;
            if let Some(url) = probe["url"].as_str().filter(|u| address(u).is_ok()) {
                p.url = url.into();
            }
            if let Some(title) = probe["title"].as_str() {
                p.title = title.chars().take(512).collect();
            }
        }
        tab.ready.notify_all();
        self.changed(key);
        Ok(true)
    }
    fn close_tab(&self, key: &str, id: &str, force: bool) -> CoreResult {
        let tab = self.find(key, Some(id))?;
        let _operation = tab.operation.lock().unwrap();
        self.sleep_locked(key, &tab, force, "manual")?;
        let selected = self.state(key)["activeTabId"] == id;
        let next = {
            let mut spaces = self.spaces.lock().unwrap();
            let space = spaces.get_mut(key).ok_or("Browser chat was closed")?;
            let index = space
                .tabs
                .iter()
                .position(|t| t.id == id)
                .ok_or("Tab already closed")?;
            space.tabs.remove(index);
            if space.selected == id {
                space.selected = space
                    .tabs
                    .get(index.min(space.tabs.len().saturating_sub(1)))
                    .map(|t| t.id.clone())
                    .unwrap_or_default();
            }
            space.selected.clone()
        };
        drop(_operation);
        if next.is_empty() {
            self.new_tab(key, "about:blank", false)?;
        } else if selected {
            self.select(key, &next)?;
        } else {
            self.attach()?;
        }
        self.changed(key);
        Ok(self.state(key))
    }
    fn idle_minutes(&self) -> f64 {
        self.storage.ui()["browserIdleMinutes"]
            .as_f64()
            .unwrap_or(5.)
            .clamp(0., 120.)
    }
    fn trim(&self, target: usize) {
        let started = Instant::now();
        let mut all = self.all();
        all.sort_by_key(|(_, t)| t.data.lock().unwrap().used);
        let mut live = all
            .iter()
            .filter(|(_, t)| t.data.lock().unwrap().label.is_some())
            .count();
        for (key, tab) in all {
            if live <= target || started.elapsed() > Duration::from_secs(2) {
                break;
            }
            let Ok(_operation) = tab.operation.try_lock() else {
                continue;
            };
            let p = tab.data.lock().unwrap();
            if p.label.is_none() || p.visible || p.pinned || p.loading || p.downloads > 0 {
                continue;
            }
            drop(p);
            if self
                .sleep_locked(&key, &tab, false, "pressure")
                .unwrap_or(false)
            {
                live -= 1;
            } else {
                tab.data.lock().unwrap().used = storage::now();
            }
        }
    }
    pub(super) fn maintain(&self) {
        let now = storage::now();
        let minutes = self.idle_minutes();
        let mut probes = 0;
        if minutes > 0. {
            for (key, tab) in self.all() {
                if probes >= 4 {
                    break;
                }
                let Ok(_operation) = tab.operation.try_lock() else {
                    continue;
                };
                let p = tab.data.lock().unwrap();
                if p.label.is_none()
                    || p.visible
                    || p.pinned
                    || p.loading
                    || p.downloads > 0
                    || now.saturating_sub(p.used.max(p.hidden)) < (minutes * 60000.) as u64
                {
                    continue;
                }
                drop(p);
                tab.data.lock().unwrap().used = now;
                probes += 1;
                let _ = self.sleep_locked(&key, &tab, false, "idle");
            }
        }
        self.flush();
    }
    pub(super) fn flush(&self) {
        if !self.dirty.swap(false, Ordering::AcqRel) {
            return;
        }
        let spaces = self.spaces.lock().unwrap();
        let mut snapshot = serde_json::Map::new();
        for (key, space) in spaces.iter() {
            let tabs=space.tabs.iter().map(|tab|{let p=tab.data.lock().unwrap();let start=p.index.saturating_sub(10);let history=p.history.iter().skip(start).take(20).collect::<Vec<_>>();json!({"id":tab.id,"url":p.url,"title":p.title,"pinned":p.pinned,"scrollX":p.scroll.0,"scrollY":p.scroll.1,"history":history,"index":p.index-start})}).collect::<Vec<_>>();
            snapshot.insert(
                key.clone(),
                json!({"selected":space.selected,"tabs":tabs,"at":space.touched}),
            );
        }
        drop(spaces);
        let data = Value::Object(snapshot);
        if self
            .storage
            .update("native/browser-tabs.json", |value| {
                storage::merge(value, &data);
                if let Some(map) = value.as_object_mut() {
                    while map.len() > 64 {
                        let oldest = map
                            .iter()
                            .min_by_key(|(_, v)| v["at"].as_u64().unwrap_or(0))
                            .map(|(k, _)| k.clone())
                            .unwrap();
                        map.remove(&oldest);
                    }
                }
                Ok(())
            })
            .is_err()
        {
            self.dirty.store(true, Ordering::Release);
        }
    }
    pub(super) fn dispose(&self, key: &str) {
        self.flush();
        let space = self.spaces.lock().unwrap().remove(key);
        if let Some(space) = space {
            for tab in space.tabs {
                let _operation = tab.operation.lock().unwrap();
                let label = tab.data.lock().unwrap().label.take();
                if let Some(label) = label {
                    let _ = self.op(&label, "close", Value::Null);
                }
                tab.ready.notify_all();
            }
        }
    }
    fn wait_ready(&self, tab: &Arc<Tab>) -> Result<(), String> {
        let data = tab.data.lock().unwrap();
        let (data, timeout) = tab
            .ready
            .wait_timeout_while(data, Duration::from_secs(12), |data| {
                data.loading && data.label.is_some()
            })
            .unwrap();
        if data.label.is_none() {
            return Err("Tab is sleeping or closed".into());
        }
        if timeout.timed_out() && data.loading {
            return Err("Page is still loading; retry the browser operation".into());
        }
        Ok(())
    }
    pub(super) fn invoke(&self, channel: &str, args: &[Value]) -> CoreResult {
        let a = |i| args.get(i).unwrap_or(&Value::Null);
        let p = a(0);
        match channel {
            "browser:state" => Ok(self.state(p.as_str().unwrap_or(""))),
            "browser:setBounds" => {
                self.active.lock().unwrap().bounds = p.clone();
                self.attach()
            }
            "browser:setVisible" => {
                let key = a(1).as_str();
                let show = p == &true;
                {
                    let mut active = self.active.lock().unwrap();
                    if !show && key.is_some() && active.key.as_deref() != key {
                        return Ok(Value::Null);
                    }
                    active.visible = show;
                    if let Some(key) = key {
                        active.key = Some(key.into());
                    }
                }
                if show {
                    if let Some(key) = key {
                        let tab = self.find(key, None)?;
                        let auto = tab.data.lock().unwrap().reason != "manual";
                        if auto {
                            let _operation = tab.operation.lock().unwrap();
                            self.awake(key, &tab)?;
                        }
                        self.push(key);
                    }
                }
                self.attach()
            }
            "browser:navigate" => {
                self.navigate(a(1).as_str().unwrap_or(""), p.as_str().unwrap_or(""), None)
            }
            "browser:screenshot" => {
                let key = p.as_str().unwrap_or("");
                let tab = self.find(key, None)?;
                let _operation = tab.operation.lock().unwrap();
                let label = self.awake(key, &tab)?;
                self.wait_ready(&tab)?;
                self.op(&label, "capture", Value::Null)
                    .map(|v| v["png"].clone())
            }
            "browser:control" => self.control(a(1).as_str().unwrap_or(""), p),
            _ => Err("Unknown browser operation".into()),
        }
    }
    fn control(&self, key: &str, p: &Value) -> CoreResult {
        let action = p.as_str().unwrap_or(s(p, "action"));
        let selector = p["tabId"].as_str();
        // Isolated native integration tests exercise the exact MCP tool path.
        // Remote pages have no application IPC; normal profiles have no hook.
        if action == "test-tool"
            && std::env::var("DUET_NATIVE_TEST").as_deref() == Ok("1")
            && std::env::var("DUET_NATIVE_PREVIEW").as_deref() == Ok("1")
        {
            let mut tool = p["tool"].clone();
            if !tool.is_object() {
                return Err("Invalid browser test tool".into());
            }
            tool["threadId"] = json!(key);
            return self.tool(&tool);
        }
        match action {
            "new-tab" => {
                return self.new_tab(
                    key,
                    p["url"].as_str().unwrap_or("about:blank"),
                    p["background"] == true,
                )
            }
            "select-tab" | "wake-tab" => {
                let tab = self.find(key, selector)?;
                return self.select(key, &tab.id);
            }
            "close-tab" => {
                let tab = self.find(key, selector)?;
                return self.close_tab(key, &tab.id, p["force"] == true);
            }
            "sleep-inactive" => {
                let selected = self.state(key)["activeTabId"]
                    .as_str()
                    .unwrap_or("")
                    .to_string();
                let mut slept = 0;
                let mut skipped = 0;
                for (owner, tab) in self.all().into_iter().filter(|(owner, _)| owner == key) {
                    if tab.id == selected {
                        continue;
                    }
                    let Ok(_operation) = tab.operation.try_lock() else {
                        skipped += 1;
                        continue;
                    };
                    let page = tab.data.lock().unwrap();
                    if page.label.is_none()
                        || page.visible
                        || page.pinned
                        || page.loading
                        || page.downloads > 0
                    {
                        continue;
                    }
                    drop(page);
                    if self
                        .sleep_locked(&owner, &tab, false, "manual")
                        .unwrap_or(false)
                    {
                        slept += 1;
                    } else {
                        skipped += 1;
                    }
                }
                let mut state = self.state(key);
                state["sleepReport"] = json!({"slept":slept,"skipped":skipped});
                return Ok(state);
            }
            _ => {}
        }
        let tab = self.find(key, selector)?;
        let _operation = tab.operation.lock().unwrap();
        if action == "sleep-tab" {
            self.sleep_locked(key, &tab, p["force"] == true, "manual")?;
            return Ok(self.state(key));
        }
        if action == "pin-tab" {
            tab.data.lock().unwrap().pinned = p["pinned"] == true;
            self.changed(key);
            return Ok(self.state(key));
        }
        if action == "external" {
            return self
                .host("shell.open", json!({"target":tab.data.lock().unwrap().url}))
                .map(|_| self.state(key));
        }
        let label = self.awake(key, &tab)?;
        if action == "back" || action == "forward" {
            let destination = {
                let mut page = tab.data.lock().unwrap();
                let index = if action == "back" {
                    page.index.checked_sub(1)
                } else if page.index + 1 < page.history.len() {
                    Some(page.index + 1)
                } else {
                    None
                };
                index.map(|index| {
                    page.pending_index = Some(index);
                    page.loading = true;
                    page.used = storage::now();
                    page.history[index].clone()
                })
            };
            if let Some(url) = destination {
                self.op(&label, "navigate", json!({"url":url}))?;
            }
        } else if matches!(action, "reload" | "stop" | "devtools") {
            self.op(&label, action, Value::Null)?;
            if action == "stop" {
                tab.data.lock().unwrap().loading = false;
                tab.ready.notify_all();
            }
        } else {
            return Err("Unknown browser control".into());
        }
        self.push(key);
        Ok(self.state(key))
    }
    pub(super) fn native_event(&self, label: &str, event: &str, data: &Value) -> bool {
        let found = self
            .all()
            .into_iter()
            .find(|(_, tab)| tab.data.lock().unwrap().label.as_deref() == Some(label));
        let Some((key, tab)) = found else {
            return false;
        };
        match event {
            "state" => {
                let mut page = tab.data.lock().unwrap();
                if data["navigationUrl"] == "about:blank"
                    && page.url != "about:blank"
                    && data["loading"] == false
                {
                    return true;
                }
                if let Some(url) = data["url"].as_str() {
                    if page.ignore_blank && url == "about:blank" {
                        return true;
                    }
                    if url != "about:blank" && data["loading"] == false {
                        page.ignore_blank = false;
                    }
                    page.url = url.chars().take(8192).collect();
                }
                if let Some(title) = data["title"].as_str() {
                    page.title = title.chars().take(512).collect();
                }
                if let Some(loading) = data["loading"].as_bool() {
                    page.loading = loading;
                }
                let restore = if !page.loading {
                    if let Some(index) = page.pending_index.take() {
                        page.index = index;
                        let url = page.url.clone();
                        page.history[index] = url;
                    } else if page.history.get(page.index) != Some(&page.url) {
                        let index = page.index;
                        page.history.truncate(index + 1);
                        let url = page.url.clone();
                        page.history.push(url);
                        if page.history.len() > 50 {
                            page.history.remove(0);
                        }
                        page.index = page.history.len() - 1;
                    }
                    if page.restore {
                        page.restore = false;
                        Some(page.scroll)
                    } else {
                        None
                    }
                } else {
                    None
                };
                drop(page);
                tab.ready.notify_all();
                if let Some((x, y)) = restore {
                    let _ = self.op(
                        label,
                        "execute",
                        json!({"code":format!("window.scrollTo({x},{y})")}),
                    );
                }
                self.changed(&key);
            }
            "popup" => {
                let _ = self.new_tab(&key, s(data, "url"), false);
            }
            "download" => {
                let mut page = tab.data.lock().unwrap();
                if data["active"] == true {
                    page.downloads += 1;
                } else {
                    page.downloads = page.downloads.saturating_sub(1);
                }
            }
            "closed" => {
                let mut page = tab.data.lock().unwrap();
                page.label = None;
                page.loading = false;
                page.visible = false;
                page.reason = "closed".into();
                drop(page);
                tab.ready.notify_all();
                self.push(&key);
            }
            _ => {}
        }
        true
    }
    pub(super) fn tool(&self, p: &Value) -> CoreResult {
        let key = s(p, "threadId");
        let action = s(p, "action");
        let selector = p["tab_id"].as_str();
        match action {
            "list_tabs" => {
                self.ensure_space(key)?;
                return Ok(self.state(key));
            }
            "new_tab" => {
                return self.new_tab(
                    key,
                    p["url"].as_str().unwrap_or("about:blank"),
                    p["background"] == true,
                )
            }
            "select_tab" => {
                let tab = self.find(key, selector)?;
                return self.select(key, &tab.id);
            }
            "close_tab" => {
                let tab = self.find(key, selector)?;
                return self.close_tab(key, &tab.id, false);
            }
            "sleep_tab" => {
                return self.control(key, &json!({"action":"sleep-tab","tabId":selector}))
            }
            "navigate" => return self.navigate(key, s(p, "url"), selector),
            _ => {}
        }
        let tab = self.find(key, selector)?;
        let _operation = tab.operation.lock().unwrap();
        let label = self.awake(key, &tab)?;
        self.wait_ready(&tab)?;
        let eval = |code: String| self.op(&label, "eval", json!({"code":code}));
        match action {
            "screenshot" => {
                (self.emit)("browser:show", json!({"key":key}));
                let image = self.op(&label, "capture", Value::Null)?;
                Ok(
                    json!({"tab_id":tab.id,"content":[{"type":"image","data":image["png"],"mimeType":"image/png"}]}),
                )
            }
            "read" | "read_page" => {
                let mut value=eval("(()=>{const els=[...document.querySelectorAll('a[href],button,input,textarea,select,[role=button]')].filter(e=>e.getClientRects().length).slice(0,200);window.__duetElements=els;return {title:document.title,url:location.href,text:(document.body?.innerText||'').slice(0,20000),elements:els.map((e,id)=>({id,tag:e.tagName,text:(e.innerText||e.getAttribute('aria-label')||e.getAttribute('placeholder')||e.value||'').slice(0,200),href:e.href}))}})()".into())?;
                value["tab_id"] = json!(tab.id);
                Ok(value)
            }
            "click" => {
                let selector = json!(s(p, "selector"));
                let text = json!(s(p, "text").to_lowercase());
                let index = p["id"]
                    .as_u64()
                    .map(|v| v.to_string())
                    .unwrap_or("null".into());
                let result=eval(format!("(()=>{{let e={selector}?document.querySelector({selector}):window.__duetElements?.[{index}];if(!e&&{text})e=[...document.querySelectorAll('a,button,input,[role=button],summary,label')].find(e=>(e.innerText||e.value||e.getAttribute('aria-label')||'').toLowerCase().includes({text}));if(!e)return 'not found';e.scrollIntoView({{block:'center'}});const a=e.closest?.('a[href]');if(a&&a.target&&!['_self','_top','_parent'].includes(a.target.toLowerCase())&&!a.hasAttribute('download'))return {{open_tab:a.href}};e.click();return 'clicked'}})()"))?;
                // Scripted element clicks have no browser user activation. Explicitly
                // route ordinary new-window links through the tab manager instead.
                if let Some(url) = result["open_tab"].as_str() {
                    drop(_operation);
                    self.new_tab(key, url, false)
                } else {
                    Ok(result)
                }
            }
            "type" => {
                let selector = json!(s(p, "selector"));
                let text = json!(s(p, "text"));
                let index = p["id"]
                    .as_u64()
                    .map(|v| v.to_string())
                    .unwrap_or("null".into());
                eval(format!("(()=>{{const e={selector}?document.querySelector({selector}):window.__duetElements?.[{index}];if(!e)return 'not found';e.focus();const proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;const set=Object.getOwnPropertyDescriptor(proto,'value')?.set;if(set)set.call(e,{text});else e.textContent={text};e.dispatchEvent(new Event('input',{{bubbles:true}}));e.dispatchEvent(new Event('change',{{bubbles:true}}));if({}){{if(e.form)e.form.requestSubmit();else e.dispatchEvent(new KeyboardEvent('keydown',{{key:'Enter',bubbles:true}}));}}return 'typed'}})()",p["submit"]==true))
            }
            "scroll" => {
                let dy = p["dy"].as_f64().unwrap_or_else(|| {
                    p["amount"].as_f64().unwrap_or(600.)
                        * if p["direction"] == "up" { -1. } else { 1. }
                });
                eval(format!("window.scrollBy(0,{dy});'scrolled'"))
            }
            "back" => {
                drop(_operation);
                self.control(key, &json!({"action":"back","tabId":tab.id}))
            }
            "run_js" => eval(s(p, "code").into()),
            _ => Err("Unknown browser tool".into()),
        }
    }
}
fn address(raw: &str) -> Result<String, String> {
    if raw.len() > 8192 || raw.chars().any(char::is_control) {
        return Err("Invalid browser URL".into());
    }
    let lower = raw.trim_start().to_ascii_lowercase();
    if [
        "javascript:",
        "vbscript:",
        "data:",
        "blob:",
        "tauri:",
        "devtools:",
    ]
    .iter()
    .any(|scheme| lower.starts_with(scheme))
    {
        return Err("Unsupported browser URL".into());
    }
    let url = super::normalize(raw)?;
    let parsed = url::Url::parse(&url).map_err(|_| "Invalid browser URL")?;
    if !matches!(parsed.scheme(), "http" | "https" | "file") && url != "about:blank" {
        return Err("Unsupported browser URL".into());
    }
    Ok(url)
}
fn finite(value: &Value) -> f64 {
    value
        .as_f64()
        .filter(|v| v.is_finite())
        .unwrap_or(0.)
        .clamp(0., 10000000.)
}

#[cfg(test)]
#[path = "browser_tests.rs"]
mod tests;

//! Owned Kimi Code server. Credentials and the loopback bearer never leave Rust.
use super::{
    cli,
    events::{arr, s},
    process::Program,
    rpc::Client,
    storage::{self, Storage},
    CoreResult,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::Read,
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex, Weak,
    },
    time::{Duration, Instant},
};
use tungstenite::{client, Message};
pub const MANAGED: &str = "managed:kimi-code";
type Sink = Arc<dyn Fn(Value) + Send + Sync>;
struct Command {
    frame: Value,
    reply: Option<mpsc::SyncSender<Result<(), String>>>,
}
pub struct Backend {
    pub process: Arc<Client>,
    base: String,
    token: String,
    home: PathBuf,
    http: reqwest::blocking::Client,
    commands: mpsc::Sender<Command>,
    subscribed: Mutex<HashMap<String, HashMap<String, u64>>>,
    closed: AtomicBool,
}
pub fn home(st: &Storage) -> PathBuf {
    std::env::var_os("KIMI_CODE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| st.home.join(".kimi-code"))
}
pub fn path(value: &str) -> String {
    value
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
impl Backend {
    pub fn start(
        st: &Storage,
        sink: Sink,
        on_exit: Arc<dyn Fn(String) + Send + Sync>,
    ) -> Result<Arc<Self>, String> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        drop(listener);
        let mut program: Program = cli::subscription(st, "kimi", cli::find(st, "kimi")?)?;
        program
            .env
            .push(("KIMI_CODE_HOME".into(), home(st).to_string_lossy().into()));
        program
            .env
            .push(("KIMI_DISABLE_TELEMETRY".into(), "1".into()));
        let process = Client::spawn(
            &program,
            &[
                "web".into(),
                "--no-open".into(),
                "--debug-endpoints".into(),
                "--host".into(),
                "127.0.0.1".into(),
                "--port".into(),
                port.to_string(),
            ],
            &st.home,
            Arc::new(|_, _| {}),
            Arc::new(move |_| on_exit("Kimi Code server stopped".into())),
        )?;
        let base = format!("http://127.0.0.1:{port}");
        let http = reqwest::blocking::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?;
        let deadline = Instant::now() + Duration::from_secs(30);
        let token = loop {
            if process.closed.load(Ordering::Acquire) {
                return Err(
                    "Kimi Code could not start. Kimi Code 2.4.1 or newer is required.".into(),
                );
            }
            if let Ok(raw) = storage::read_limited(&home(st).join("server.token"), 8192) {
                let token = String::from_utf8_lossy(&raw).trim().to_owned();
                if !token.is_empty()
                    && http
                        .get(format!("{base}/api/v1/healthz"))
                        .timeout(Duration::from_secs(1))
                        .send()
                        .is_ok_and(|r| r.status().is_success())
                {
                    break token;
                }
            }
            if Instant::now() > deadline {
                process.close();
                return Err("Kimi Code startup timed out".into());
            }
            std::thread::sleep(Duration::from_millis(100));
        };
        let (tx, rx) = mpsc::channel();
        let backend = Arc::new(Self {
            process,
            base,
            token,
            home: home(st),
            http,
            commands: tx,
            subscribed: Mutex::new(HashMap::new()),
            closed: AtomicBool::new(false),
        });
        let meta = backend.api("GET", "/api/v1/meta", None)?;
        if meta["backend"] != "v2" || meta["capabilities"]["websocket"] != true {
            backend.shutdown();
            return Err("Update Kimi Code: the v2 server API is required".into());
        }
        let weak = Arc::downgrade(&backend);
        std::thread::spawn(move || socket_loop(weak, rx, sink));
        Ok(backend)
    }
    pub fn alive(&self) -> bool {
        !self.closed.load(Ordering::Acquire) && !self.process.closed.load(Ordering::Acquire)
    }
    pub fn api(&self, method: &str, route: &str, body: Option<&Value>) -> CoreResult {
        if !self.alive() {
            return Err("Kimi Code server stopped".into());
        }
        if !route.starts_with("/api/") && !matches!(route, "/openapi.json" | "/asyncapi.json") {
            return Err("Invalid Kimi API route".into());
        }
        let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
        let mut request = self
            .http
            .request(method, format!("{}{route}", self.base))
            .bearer_auth(&self.token);
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request
            .send()
            .map_err(|_| "Kimi Code connection failed".to_owned())?;
        if response.status() == reqwest::StatusCode::NO_CONTENT {
            return Ok(Value::Null);
        }
        let mut bytes = Vec::new();
        response
            .take(32 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() > 32 * 1024 * 1024 {
            return Err("Kimi response exceeds 32 MiB; use transcript paging".into());
        }
        let mut value = super::wire_json::parse(&bytes)?;
        if value.get("code").is_none() {
            return Ok(value);
        }
        if value["code"].as_i64() != Some(0) {
            return Err(format!("Kimi {}: {}", value["code"], s(&value, "msg")));
        }
        Ok(value["data"].take())
    }
    pub fn debug(
        &self,
        sid: Option<&str>,
        agent: Option<&str>,
        service: &str,
        method: &str,
        args: Value,
    ) -> CoreResult {
        let scope = match (sid, agent) {
            (Some(sid), Some(agent)) => format!("/session/{}/agent/{}", path(sid), path(agent)),
            (Some(sid), None) => format!("/session/{}", path(sid)),
            _ => String::new(),
        };
        self.api(
            "POST",
            &format!("/api/v1/debug{scope}/{service}/{method}"),
            Some(&args),
        )
    }
    pub fn session(&self, sid: &str, suffix: &str, body: Option<&Value>) -> CoreResult {
        self.api(
            if body.is_some() { "POST" } else { "GET" },
            &format!("/api/v1/sessions/{}{suffix}", path(sid)),
            body,
        )
    }
    pub fn subscribe(&self, sid: &str) -> Result<(), String> {
        self.subscribed
            .lock()
            .unwrap()
            .entry(sid.into())
            .or_default();
        let (tx, rx) = mpsc::sync_channel(1);
        let id = uuid::Uuid::new_v4().to_string();
        self.commands.send(Command{frame:json!({"type":"subscribe_v2","id":id,"payload":{"session_id":sid,"transcript":{"*":"delta"}}}),reply:Some(tx)}).map_err(|_|"Kimi event connection closed")?;
        rx.recv_timeout(Duration::from_secs(15))
            .map_err(|_| "Kimi event subscription timed out")?
    }
    pub fn release(&self, sid: &str) {
        self.subscribed.lock().unwrap().remove(sid);
        let _=self.commands.send(Command{frame:json!({"type":"unsubscribe_v2","id":uuid::Uuid::new_v4().to_string(),"payload":{"session_id":sid}}),reply:None});
        let _ = self.debug(None, None, "sessionManager", "close", json!([sid]));
    }
    pub fn authenticate(&self) -> Result<(), String> {
        let auth = self.api("GET", "/api/v1/auth", None)?;
        if auth["managed_provider"]["name"] != MANAGED
            || auth["managed_provider"]["status"] != "authenticated"
        {
            return Err("Sign in to Kimi Code with your subscription".into());
        }
        let config = self.api("GET", "/api/v1/config", None)?;
        let provider = &config["providers"][MANAGED];
        if provider["type"] != "kimi"
            || provider["api_key_env"]
                .as_str()
                .is_some_and(|v| !v.is_empty())
        {
            return Err("Kimi must use subscription OAuth, not API keys".into());
        }
        // The API's has_api_key also means OAuth exists. Inspect only local config credential overrides.
        let file = self.home.join("config.toml");
        if file.exists() {
            let bytes = storage::read_limited(&file, 2 * 1024 * 1024)?;
            let config: Value = toml::from_str(
                std::str::from_utf8(&bytes).map_err(|_| "Invalid Kimi config encoding")?,
            )
            .map_err(|_| "Cannot validate Kimi subscription config")?;
            let provider = &config["providers"][MANAGED];
            if ["api_key", "api_key_env"]
                .iter()
                .any(|key| provider[*key].as_str().is_some_and(|s| !s.is_empty()))
            {
                return Err(
                    "Remove the API key override from the Kimi subscription provider".into(),
                );
            }
            if let Some(models) = config["models"].as_object() {
                for (id, m) in models {
                    if id.starts_with("kimi-code/")
                        && ["api_key", "api_key_env", "base_url"]
                            .iter()
                            .any(|key| m[*key].as_str().is_some_and(|s| !s.is_empty()))
                    {
                        return Err(
                            "Remove custom API overrides from Kimi subscription models".into()
                        );
                    }
                }
            }
        }
        Ok(())
    }
    pub fn thinking(&self, model: &str, requested: &str) -> Result<Option<String>, String> {
        if requested.is_empty() || requested == "default" {
            return Ok(None);
        }
        let models = self.models()?;
        let item = arr(&models)
            .iter()
            .find(|m| m["model"] == model)
            .ok_or("Unknown Kimi model")?;
        let efforts = arr(&item["support_efforts"]);
        let requested = if requested == "max" {
            "high"
        } else {
            requested
        };
        if efforts.iter().any(|v| v == requested) {
            Ok(Some(requested.into()))
        } else {
            Ok(item["default_effort"].as_str().map(str::to_owned))
        }
    }
    pub fn models(&self) -> CoreResult {
        let all = self.api("GET", "/api/v1/models", None)?;
        Ok(json!(arr(&all["items"])
            .iter()
            .filter(|m| m["provider"] == MANAGED)
            .cloned()
            .collect::<Vec<_>>()))
    }
    pub fn model(&self, requested: &str) -> Result<String, String> {
        self.authenticate()?;
        let list = self.models()?;
        let models = arr(&list);
        if requested.is_empty() || requested == "default" {
            let cfg = self.api("GET", "/api/v1/config", None)?;
            return models
                .iter()
                .find(|m| m["model"] == cfg["default_model"])
                .or_else(|| models.first())
                .map(|m| s(m, "model").to_owned())
                .ok_or("Kimi subscription has no available models".into());
        }
        if models.iter().any(|m| m["model"] == requested) {
            Ok(requested.into())
        } else {
            Err("Select a Kimi Code subscription model".into())
        }
    }
    pub fn shutdown(&self) {
        self.closed.store(true, Ordering::Release);
        self.process.close();
    }
}
impl Drop for Backend {
    fn drop(&mut self) {
        self.shutdown();
    }
}
fn socket_loop(weak: Weak<Backend>, rx: mpsc::Receiver<Command>, sink: Sink) {
    let mut first = true;
    loop {
        let Some(b) = weak.upgrade() else { return };
        if !b.alive() {
            return;
        }
        let address = b.base.trim_start_matches("http://").to_owned();
        let token = b.token.clone();
        drop(b);
        let connection = (|| {
            let tcp = TcpStream::connect(&address).map_err(|e| e.to_string())?;
            tcp.set_read_timeout(Some(Duration::from_millis(100)))
                .map_err(|e| e.to_string())?;
            tcp.set_write_timeout(Some(Duration::from_secs(3)))
                .map_err(|e| e.to_string())?;
            let request = tungstenite::http::Request::builder()
                .uri(format!("ws://{address}/api/v1/ws"))
                .header("Host", &address)
                .header("Authorization", format!("Bearer {token}"))
                .header("Connection", "Upgrade")
                .header("Upgrade", "websocket")
                .header("Sec-WebSocket-Version", "13")
                .header(
                    "Sec-WebSocket-Key",
                    tungstenite::handshake::client::generate_key(),
                )
                .body(())
                .map_err(|e| e.to_string())?;
            client(request, tcp).map(|x| x.0).map_err(|e| e.to_string())
        })();
        let Ok(mut ws) = connection else {
            std::thread::sleep(Duration::from_millis(500));
            continue;
        };
        let Some(b) = weak.upgrade() else { return };
        let mut acknowledgements = HashMap::<String, mpsc::SyncSender<Result<(), String>>>::new();
        let _ = ws.send(Message::Text(
            json!({"type":"client_hello","id":"duet","payload":{"client_name":"Duet"}})
                .to_string()
                .into(),
        ));
        for (sid, cursors) in b.subscribed.lock().unwrap().iter() {
            let _=ws.send(Message::Text(json!({"type":"subscribe_v2","id":uuid::Uuid::new_v4().to_string(),"payload":{"session_id":sid,"transcript":{"*":"delta"},"transcript_since":cursors}}).to_string().into()));
        }
        drop(b);
        if !first {
            sink(json!({"type":"duet.reconnected"}));
        }
        first = false;
        loop {
            let Some(b) = weak.upgrade() else { return };
            if !b.alive() {
                return;
            }
            while let Ok(command) = rx.try_recv() {
                let id = s(&command.frame, "id").to_owned();
                if let Some(tx) = command.reply {
                    acknowledgements.insert(id, tx);
                }
                if ws
                    .send(Message::Text(command.frame.to_string().into()))
                    .is_err()
                {
                    break;
                }
            }
            drop(b);
            match ws.read() {
                Ok(Message::Text(text)) => {
                    if let Ok(message) = super::wire_json::parse(text.as_bytes()) {
                        if message["type"] == "ping" {
                            let _ = ws.send(Message::Text(
                                json!({"type":"pong","payload":message["payload"]})
                                    .to_string()
                                    .into(),
                            ));
                            continue;
                        }
                        if message["type"] == "ack" {
                            if let Some(tx) = acknowledgements.remove(s(&message, "id")) {
                                let not_found = arr(&message["payload"]["not_found"]);
                                let _ = tx.send(if message["code"] == 0 && not_found.is_empty() {
                                    Ok(())
                                } else {
                                    Err(format!("Kimi subscription: {}", s(&message, "msg")))
                                });
                            }
                            continue;
                        }
                        if matches!(s(&message, "type"), "transcript.ops" | "transcript.reset") {
                            if let Some(b) = weak.upgrade() {
                                if let Some(cursors) = b
                                    .subscribed
                                    .lock()
                                    .unwrap()
                                    .get_mut(s(&message, "session_id"))
                                {
                                    if let Some(seq) = message["payload"]["seq"].as_u64() {
                                        cursors
                                            .insert(s(&message["payload"], "agent_id").into(), seq);
                                    }
                                }
                            }
                        }
                        sink(message);
                    }
                }
                Ok(Message::Ping(bytes)) => {
                    let _ = ws.send(Message::Pong(bytes));
                }
                Ok(Message::Close(_)) | Err(tungstenite::Error::ConnectionClosed) => break,
                Err(tungstenite::Error::Io(ref error))
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) => {}
                Err(_) => break,
                _ => {}
            }
        }
        sink(json!({"type":"duet.disconnected"}));
        for (_, tx) in acknowledgements {
            let _ = tx.send(Err("Kimi event connection interrupted".into()));
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

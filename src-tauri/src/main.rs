#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod capture;
mod host;
mod media;
mod pump;
use duet_native::core::NativeCore;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Condvar, Mutex,
    },
    time::Duration,
};
use tauri::{Manager, Webview};
use tokio::sync::oneshot;

pub struct Backend {
    core: Mutex<Option<Arc<NativeCore>>>,
    core_workers: Arc<tokio::sync::Semaphore>,
    pub ui: Mutex<HashMap<String, bool>>,
    pub closing: Mutex<HashMap<String, bool>>,
    native_events: Mutex<VecDeque<Value>>,
    native_wake: Condvar,
    exiting: AtomicBool,
    delivery_bytes: AtomicUsize,
    delivery_messages: AtomicUsize,
}
impl Backend {
    fn new() -> Self {
        Self {
            core: Mutex::new(None),
            core_workers: Arc::new(tokio::sync::Semaphore::new(8)),
            ui: Mutex::new(HashMap::new()),
            closing: Mutex::new(HashMap::new()),
            native_events: Mutex::new(VecDeque::new()),
            native_wake: Condvar::new(),
            exiting: AtomicBool::new(false),
            delivery_bytes: AtomicUsize::new(0),
            delivery_messages: AtomicUsize::new(0),
        }
    }
    pub fn send(&self, message: Value) -> Result<(), String> {
        if message["type"] != "native.event" {
            return Err("Node core transport has been removed".into());
        }
        if message["event"] == "closed" {
            let id = message["window"].as_str().unwrap_or("");
            if self.ui.lock().unwrap().remove(id).is_none() {
                return Ok(());
            }
            self.closing.lock().unwrap().insert(id.into(), true);
        }
        let mut events = self.native_events.lock().unwrap();
        if matches!(
            message["event"].as_str(),
            Some("bounds" | "state" | "window-state")
        ) {
            if let Some(existing) = events
                .iter_mut()
                .find(|e| e["window"] == message["window"] && e["event"] == message["event"])
            {
                if message["event"] == "state" {
                    if let (Some(target), Some(patch)) = (
                        existing["data"].as_object_mut(),
                        message["data"].as_object(),
                    ) {
                        target.extend(patch.clone());
                    }
                } else {
                    *existing = message;
                }
                self.native_wake.notify_one();
                return Ok(());
            }
        }
        if events.len() >= 512 {
            if let Some(i) = events.iter().position(|e| {
                matches!(
                    e["event"].as_str(),
                    Some("bounds" | "state" | "window-state")
                )
            }) {
                events.remove(i);
            } else {
                return Err("Native window event queue is full".into());
            }
        }
        events.push_back(message);
        self.native_wake.notify_one();
        Ok(())
    }
    pub async fn evaluate(&self, view: &Webview, code: &str) -> Result<Value, String> {
        let (tx, rx) = oneshot::channel();
        let reply = Mutex::new(Some(tx));
        view.eval_with_callback(code, move |raw| {
            if let Some(tx) = reply.lock().unwrap().take() {
                let _ = tx.send(serde_json::from_str::<Value>(&raw).map_err(|e| e.to_string()));
            }
        })
        .map_err(|e| e.to_string())?;
        let value = tokio::time::timeout(Duration::from_secs(20), rx).await;
        value
            .map_err(|_| "Page JavaScript timed out".to_string())?
            .map_err(|_| "Page closed".to_string())?
    }
}
fn trusted(view: &Webview, backend: &Backend) -> bool {
    backend
        .ui
        .lock()
        .unwrap()
        .get(view.label())
        .copied()
        .unwrap_or(false)
        && view
            .url()
            .map(|url| {
                url.scheme() == "tauri"
                    || (matches!(url.scheme(), "http" | "https")
                        && url.host_str() == Some("tauri.localhost"))
            })
            .unwrap_or(false)
}
// Strip Win32 verbatim prefixes for external CLI compatibility.
fn cli_path(path: std::path::PathBuf) -> std::path::PathBuf {
    #[cfg(windows)]
    {
        let value = path.to_string_lossy();
        if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
            return std::path::PathBuf::from(format!(r"\\{}", rest));
        }
        if let Some(rest) = value.strip_prefix(r"\\?\") {
            return std::path::PathBuf::from(rest);
        }
    }
    path
}
#[tauri::command]
async fn duet_invoke(
    view: Webview,
    state: tauri::State<'_, Arc<Backend>>,
    channel: String,
    args: Vec<Value>,
) -> Result<Value, String> {
    if !trusted(&view, &state) {
        return Err("Only the local application UI can call the agent service".into());
    }
    let core = state
        .core
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("Rust core is not initialized")?;
    if !NativeCore::handles(&channel) {
        return Err(format!("Unknown native IPC channel {channel}"));
    }
    let window = view.label().to_owned();
    let backend = state.inner().clone();
    // Permission replies must remain reachable while other commands wait on a CLI.
    if channel == "agent:respondPermission" {
        return core.invoke_from(&window, &channel, &args);
    }
    let permit = state
        .core_workers
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| "Core is closing")?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let mut value=core.invoke_from(&window, &channel, &args)?;
        if channel=="desk:native-core" {
            value["delivery"]=json!({"queuedBytes":backend.delivery_bytes.load(Ordering::Relaxed),"queuedMessages":backend.delivery_messages.load(Ordering::Relaxed),"maxBytes":64*1024*1024,"channelCapacity":1024,"batchFrames":128});
        }
        Ok(value)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn window_control(
    view: Webview,
    state: tauri::State<'_, Arc<Backend>>,
    action: String,
) -> Result<Value, String> {
    if !trusted(&view, &state) {
        return Err("Untrusted window".into());
    }
    let w = view.window();
    match action.as_str() {
        "state" => Ok(()),
        "minimize" => w.minimize(),
        "maximize" => {
            if w.is_fullscreen().unwrap_or(false) {
                w.set_fullscreen(false)
            } else if w.is_maximized().unwrap_or(false) {
                w.unmaximize()
            } else {
                w.maximize()
            }
        }
        "fullscreen" => w.set_fullscreen(!w.is_fullscreen().unwrap_or(false)),
        "drag" => w.start_dragging(),
        "close" => w.close(),
        "devtools" => {
            view.open_devtools();
            Ok(())
        }
        _ => return Err("Unknown window action".into()),
    }
    .map_err(|e| e.to_string())?;
    if action != "state" {
        host::publish_window_state(&view, &state);
    }
    Ok(host::window_state(&view))
}
fn main() {
    let context_args:Vec<String>=std::env::args().skip(1).collect();
    if context_args.first().map(String::as_str)==Some("--context-client") {
        match duet_native::core::context_client(&context_args[1..]){Ok(value)=>{println!("{value}");std::process::exit(if value["error"].is_string(){1}else{0})},Err(error)=>{println!("{}",json!({"error":error}));std::process::exit(1)}}
    }
    let backend = Arc::new(Backend::new());
    let managed = backend.clone();
    let mut builder = tauri::Builder::default();
    if std::env::var_os("DUET_NATIVE_TEST").is_none()
        && std::env::var_os("DUET_NATIVE_PREVIEW").is_none()
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }));
    }
    let app = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(managed)
        .invoke_handler(tauri::generate_handler![duet_invoke, window_control])
        .on_webview_event(|view, event| {
            if let tauri::WebviewEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                let state = view.state::<Arc<Backend>>();
                if trusted(view, &state) {
                    let _ = view.eval(format!(
                        "window.__duetDeliver?.('desk:native-drop',{{paths:{}}})",
                        json!(paths)
                    ));
                }
            }
        })
        .setup(move |app| {
            let root = std::env::var_os("DUET_NATIVE_PROJECT_ROOT").map(std::path::PathBuf::from);
            let runtime = cli_path(root.unwrap_or(app.path().resource_dir()?.join("runtime")));
            let app_data = cli_path(app.path().config_dir()?);
            let user_data = std::env::var_os("DUET_NATIVE_USER_DATA")
                .map(std::path::PathBuf::from)
                .unwrap_or(app_data.join("Duet"));
            std::fs::create_dir_all(&user_data)?;
            let transcripts = if std::env::var_os("DUET_NATIVE_TEST").is_some() {
                std::env::var_os("DUET_NATIVE_TEST_TRANSCRIPTS").map(std::path::PathBuf::from)
            } else {
                None
            }
            .unwrap_or(app.path().home_dir()?.join(".claude/projects"));
            let emit = pump::start(app.handle().clone(), Arc::downgrade(&backend));
            let core = Arc::new(NativeCore::with_paths(
                user_data.clone(),
                app.path().home_dir()?,
                runtime.clone(),
                transcripts,
                emit,
            ));
            *backend.core.lock().unwrap() = Some(core.clone());
            let handle = app.handle().clone();
            let weak = Arc::downgrade(&backend);
            core.set_host(Arc::new(move |method, p| {
                let state = weak.upgrade().ok_or("Application closed")?;
                tauri::async_runtime::block_on(host::dispatch(&handle, &state, method, p))
            }));
            let weak = Arc::downgrade(&backend);
            std::thread::spawn(move || {
                while let Some(state) = weak.upgrade() {
                    let mut queue = state.native_events.lock().unwrap();
                    if queue.is_empty() {
                        let (g, _) = state
                            .native_wake
                            .wait_timeout(queue, Duration::from_secs(2))
                            .unwrap();
                        queue = g;
                    }
                    let message = queue.pop_front();
                    drop(queue);
                    let core = state.core.lock().unwrap().clone();
                    drop(state);
                    if let (Some(message), Some(core)) = (message, core) {
                        core.native_event(
                            message["window"].as_str().unwrap_or(""),
                            message["event"].as_str().unwrap_or(""),
                            message["data"].clone(),
                        );
                    }
                }
            });
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Err(error) = core.boot() {
                    eprintln!("Native startup failed: {error}");
                    handle.exit(1);
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Could not start Duet native shell");
    app.run(|app, event| {
        if let tauri::RunEvent::Exit = event {
            let backend = app.state::<Arc<Backend>>();
            backend.exiting.store(true, Ordering::Release);
            let core = backend.core.lock().unwrap().take();
            if let Some(core) = core {
                core.shutdown();
            }
        }
    });
}

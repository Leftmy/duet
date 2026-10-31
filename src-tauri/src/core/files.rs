use super::{CoreResult, Emit};
use base64::Engine;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{Read, Write},
    path::Path,
    sync::{Arc, Condvar, Mutex},
    thread::JoinHandle,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub const MAX_READ: u64 = 4 * 1024 * 1024;
pub const MAX_ATTACHMENT: u64 = 20 * 1024 * 1024;
pub const MAX_WATCHED: usize = 256;
const MAX_WRITE: usize = 8 * 1024 * 1024;
const HIDDEN: &[&str] = &[
    "node_modules",
    ".git",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    "target",
    "bin",
    "obj",
    ".idea",
    ".vs",
    "__pycache__",
    ".venv",
    "venv",
];
type Stamp = Option<(SystemTime, u64)>;
fn stamp(path: &str) -> Stamp {
    fs::metadata(path)
        .ok()
        .map(|m| (m.modified().unwrap_or(UNIX_EPOCH), m.len()))
}
fn mtime(meta: &fs::Metadata) -> f64 {
    meta.modified()
        .unwrap_or(UNIX_EPOCH)
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
        * 1000.0
}
fn limited(file: &str, limit: u64) -> Result<(Vec<u8>, fs::Metadata), String> {
    let reader = File::open(file).map_err(|e| e.to_string())?;
    let metadata = reader.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() {
        return Err("Not a file".into());
    }
    if metadata.len() > limit {
        return Err("File exceeds the size limit".into());
    }
    let mut data = Vec::with_capacity(metadata.len() as usize);
    reader
        .take(limit + 1)
        .read_to_end(&mut data)
        .map_err(|e| e.to_string())?;
    if data.len() as u64 > limit {
        return Err("File grew beyond the size limit while reading".into());
    }
    Ok((data, metadata))
}

#[derive(Default)]
struct Watches {
    stop: bool,
    paths: HashMap<String, Stamp>,
}
struct WatchState {
    data: Mutex<Watches>,
    wake: Condvar,
}
pub struct Files {
    emit: Emit,
    state: Arc<WatchState>,
    worker: Mutex<Option<JoinHandle<()>>>,
}
impl Files {
    pub fn new(emit: Emit) -> Self {
        Self {
            emit,
            state: Arc::new(WatchState {
                data: Mutex::new(Watches::default()),
                wake: Condvar::new(),
            }),
            worker: Mutex::new(None),
        }
    }
    pub fn list(&self, dir: &str) -> CoreResult {
        let mut out = Vec::new();
        for item in fs::read_dir(dir).map_err(|e| e.to_string())? {
            let item = item.map_err(|e| e.to_string())?;
            let name = item.file_name().to_string_lossy().into_owned();
            if name.starts_with(".git") || name == ".DS_Store" {
                continue;
            }
            let is_dir = item.file_type().map_err(|e| e.to_string())?.is_dir();
            out.push((!is_dir,name.to_lowercase(),json!({"name":name,"path":item.path(),"dir":is_dir,"dim":HIDDEN.contains(&name.as_str())})));
        }
        out.sort_by(|a, b| (&a.0, &a.1).cmp(&(&b.0, &b.1)));
        Ok(Value::Array(out.into_iter().map(|(_, _, v)| v).collect()))
    }
    pub fn read(&self, file: &str) -> CoreResult {
        let metadata = fs::metadata(file).map_err(|e| e.to_string())?;
        if !metadata.is_file() {
            return Err("Not a file".into());
        }
        if metadata.len() > MAX_READ {
            return Ok(json!({"tooLarge":true,"size":metadata.len()}));
        }
        let (bytes, metadata) = limited(file, MAX_READ)?;
        if bytes.iter().take(8000).any(|b| *b == 0) {
            return Ok(json!({"binary":true,"size":bytes.len()}));
        }
        Ok(
            json!({"text":String::from_utf8_lossy(&bytes),"mtime":mtime(&metadata),"size":bytes.len()}),
        )
    }
    pub fn write(&self, file: &str, text: &str) -> CoreResult {
        if text.len() > MAX_WRITE {
            return Err("Editor text exceeds the write limit".into());
        }
        fs::write(file, text).map_err(|e| e.to_string())?;
        Ok(json!({"mtime":mtime(&fs::metadata(file).map_err(|e|e.to_string())?)}))
    }
    pub fn stat(&self, paths: &Value) -> CoreResult {
        Ok(Value::Array(paths.as_array().into_iter().flatten().filter_map(Value::as_str).take(500).map(|p|{
            let metadata=fs::metadata(p).ok();json!({"path":p,"exists":metadata.is_some(),"dir":metadata.is_some_and(|m|m.is_dir())})
        }).collect()))
    }
    pub fn attachment(&self, file: &str) -> CoreResult {
        let path = Path::new(file);
        let extension = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let media = match extension.as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            _ => return Err("Unsupported image attachment".into()),
        };
        let (bytes, _) = limited(file, MAX_ATTACHMENT)?;
        Ok(
            json!({"name":path.file_name().unwrap_or_default().to_string_lossy(),"mediaType":media,"data":base64::engine::general_purpose::STANDARD.encode(bytes)}),
        )
    }
    pub fn paste_text(&self, data: &Path, text: &str) -> CoreResult {
        if text.is_empty() || text.len() > MAX_WRITE {
            return Err("Pasted text must contain between 1 byte and 8 MiB".into());
        }
        let dir = data.join("attachments/pasted-text");
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let name = format!("pasted-text-{}.txt", uuid::Uuid::new_v4());
        let path = dir.join(&name);
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&path).map_err(|e| e.to_string())?;
        if let Err(error) = file.write_all(text.as_bytes()).and_then(|_| file.sync_all()) {
            drop(file);
            let _ = fs::remove_file(&path);
            return Err(error.to_string());
        }
        // Match textarea line counting, including CR-only pastes and a final empty line.
        let lines = text.as_bytes().iter().enumerate().filter(|(i, b)| {
            **b == b'\r' || (**b == b'\n' && (*i == 0 || text.as_bytes()[*i - 1] != b'\r'))
        }).count() + 1;
        Ok(json!({"path":path,"name":name,"bytes":text.len(),"lines":lines}))
    }
    pub fn watch(&self, file: &str) -> CoreResult {
        if !Path::new(file).exists() {
            return Ok(Value::Null);
        }
        let mut data = self.state.data.lock().map_err(|e| e.to_string())?;
        if data.paths.contains_key(file) {
            return Ok(Value::Null);
        }
        if data.paths.len() >= MAX_WATCHED {
            return Err("Too many watched editor files".into());
        }
        data.paths.insert(file.to_owned(), stamp(file));
        drop(data);
        let mut worker = self.worker.lock().map_err(|e| e.to_string())?;
        if worker.is_none() {
            let state = self.state.clone();
            let emit = self.emit.clone();
            *worker = Some(std::thread::spawn(move || {
                let mut data = state.data.lock().unwrap();
                loop {
                    if data.stop {
                        break;
                    }
                    if data.paths.is_empty() {
                        data = state.wake.wait(data).unwrap();
                        continue;
                    }
                    let (guard, _) = state
                        .wake
                        .wait_timeout(data, Duration::from_millis(200))
                        .unwrap();
                    data = guard;
                    if data.stop {
                        break;
                    }
                    let mut changed = Vec::new();
                    for (path, last) in &mut data.paths {
                        let next = stamp(path);
                        if *last != next {
                            *last = next;
                            changed.push(path.clone());
                        }
                    }
                    drop(data);
                    for path in changed {
                        emit("files:changed", json!({"path":path}));
                    }
                    data = state.data.lock().unwrap();
                }
            }));
        }
        self.state.wake.notify_all();
        Ok(Value::Null)
    }
    pub fn unwatch(&self, file: &str) -> CoreResult {
        self.state
            .data
            .lock()
            .map_err(|e| e.to_string())?
            .paths
            .remove(file);
        Ok(Value::Null)
    }
}
impl Drop for Files {
    fn drop(&mut self) {
        self.state.data.lock().unwrap().stop = true;
        self.state.wake.notify_all();
        if let Some(worker) = self.worker.lock().unwrap().take() {
            let _ = worker.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pasted_text_is_exact_unique_persistent_and_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let files = Files::new(Arc::new(|_, _| {}));
        let text = "Привет 🦀\r\nline\rnext\n";
        let first = files.paste_text(dir.path(), text).unwrap();
        let second = files.paste_text(dir.path(), text).unwrap();
        assert_ne!(first["path"], second["path"]);
        assert_eq!(first["bytes"], text.len());
        assert_eq!(first["lines"], 4);
        let path = Path::new(first["path"].as_str().unwrap());
        assert!(path.starts_with(dir.path().join("attachments/pasted-text")));
        assert_eq!(fs::read_to_string(path).unwrap(), text);
        drop(files);
        assert_eq!(fs::read_to_string(path).unwrap(), text, "History links survive app shutdown");
        let files = Files::new(Arc::new(|_, _| {}));
        assert!(files.paste_text(dir.path(), "").is_err());
        assert!(files.paste_text(dir.path(), &"x".repeat(MAX_WRITE + 1)).is_err());
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 2);
    }
    #[test]
    fn editor_size_binary_and_attachment_contracts() {
        let dir = tempfile::tempdir().unwrap();
        let files = Files::new(Arc::new(|_, _| {}));
        let text = dir.path().join("тест.txt");
        let name = text.to_str().unwrap();
        files.write(name, "Привет\nRust").unwrap();
        assert_eq!(files.read(name).unwrap()["text"], "Привет\nRust");
        fs::write(&text, [1, 0, 2]).unwrap();
        assert_eq!(files.read(name).unwrap()["binary"], true);
        let large = File::create(&text).unwrap();
        large.set_len(MAX_READ + 1).unwrap();
        assert_eq!(files.read(name).unwrap()["tooLarge"], true);
        assert!(files.attachment(name).is_err());
        let image = dir.path().join("a.png");
        fs::write(&image, [1, 2, 3]).unwrap();
        assert_eq!(
            files.attachment(image.to_str().unwrap()).unwrap()["data"],
            "AQID"
        );
    }
    #[test]
    fn watch_notifies_after_atomic_file_replacement_and_shuts_down() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.txt");
        fs::write(&file, "first").unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let files = Files::new(Arc::new(move |channel, value| {
            tx.send((channel.to_owned(), value)).unwrap();
        }));
        files.watch(file.to_str().unwrap()).unwrap();
        fs::remove_file(&file).unwrap();
        fs::write(&file, "replacement content").unwrap();
        let (channel, value) = rx.recv_timeout(Duration::from_secs(3)).unwrap();
        assert_eq!(channel, "files:changed");
        assert_eq!(value["path"], file.to_str().unwrap());
        files.unwatch(file.to_str().unwrap()).unwrap();
        drop(files);
    }
}
